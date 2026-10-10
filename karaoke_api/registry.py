"""Реестр задач: потокобезопасный словарь с TTL для завершённых задач.

Рантайм-реестр — PgJobRegistry (см. worker): память — горячий слой,
PG — история задач и переживание рестартов API.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field

from . import db

log = logging.getLogger(__name__)


@dataclass
class Job:
    """Состояние одной загрузки (state: queued | running | done | error)."""

    id: str
    title: str
    audio: str  # ключ исходника в бакете (music/<файл>) либо локальный путь
    lang: str = "ru"
    lyrics_text: str = ""
    lyrics_url: str = ""
    owner_id: str = ""
    owner_name: str = ""
    state: str = "queued"
    stage: str = "queued"
    progress: int = 0
    song_id: str | None = None
    error: str | None = None
    created: float = field(default_factory=time.time)
    updated: float = field(default_factory=time.time)

    def public(self) -> dict:
        """Полезная нагрузка для API (без локальных путей и пользовательского текста)."""
        return {
            "id": self.id,
            "state": self.state,
            "stage": self.stage,
            "progress": self.progress,
            "title": self.title,
            "songId": self.song_id,
            "error": self.error,
        }


class JobRegistry:
    """Потокобезопасный реестр: завершённые задачи вычищаются по TTL."""

    def __init__(self, ttl_sec: float = 3600.0) -> None:
        self.ttl_sec = ttl_sec
        self._lock = threading.Lock()
        self._jobs: dict[str, Job] = {}

    def create(self, *, title: str, audio: str, lang: str = "ru",
               lyrics_text: str = "", lyrics_url: str = "",
               owner_id: str = "", owner_name: str = "") -> Job:
        job = Job(id=uuid.uuid4().hex[:12], title=title, audio=audio, lang=lang,
                  lyrics_text=lyrics_text, lyrics_url=lyrics_url,
                  owner_id=owner_id, owner_name=owner_name)
        with self._lock:
            self._cleanup_locked()
            self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            self._cleanup_locked()
            return self._jobs.get(job_id)

    def update(self, job_id: str, **fields) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            for name, value in fields.items():
                setattr(job, name, value)
            job.updated = time.time()

    def _cleanup_locked(self) -> None:
        now = time.time()
        stale = [jid for jid, j in self._jobs.items()
                 if j.state in ("done", "error") and now - j.updated > self.ttl_sec]
        for jid in stale:
            del self._jobs[jid]

    def mark_interrupted(self) -> None:
        """База без зеркала: переживать рестарты умеет только PgJobRegistry."""

    def __len__(self) -> int:
        with self._lock:
            return len(self._jobs)


class PgJobRegistry(JobRegistry):
    """Реестр с зеркалом в PostgreSQL: память — рантайм, PG — история и рестарты.

    Запись best-effort (канон — память, сбой PG не роняет загрузку),
    чтение — с фолбэком в PG: задача видна после вычистки по TTL и рестарта API.
    """

    def create(self, *, title: str, audio: str, lang: str = "ru",
               lyrics_text: str = "", lyrics_url: str = "",
               owner_id: str = "", owner_name: str = "") -> Job:
        job = super().create(title=title, audio=audio, lang=lang,
                             lyrics_text=lyrics_text, lyrics_url=lyrics_url,
                             owner_id=owner_id, owner_name=owner_name)
        self._pg_write(job)
        self._pg_stale()
        return job

    def get(self, job_id: str) -> Job | None:
        job = super().get(job_id)
        return job if job is not None else self._pg_load(job_id)

    def update(self, job_id: str, **fields) -> None:
        super().update(job_id, **fields)
        job = JobRegistry.get(self, job_id)  # в памяти: update только про существующие
        if job is not None:
            self._pg_write(job)

    def mark_interrupted(self) -> None:
        """Очередь не переживает рестарт — висящие задачи честно помечаем ошибкой."""
        try:
            with db.pool().connection() as conn:
                conn.execute(
                    "UPDATE jobs SET state='error', stage='error', error=%s, updated=%s "
                    "WHERE state IN ('queued', 'running')",
                    ("перезапуск сервера", time.time()))
        except Exception:
            log.warning("pg: не удалось пометить прерванные задачи", exc_info=True)

    def _pg_write(self, job: Job) -> None:
        sql = ("INSERT INTO jobs (id, title, state, stage, progress, song_id, error, created, updated, "
               "owner_id, owner_name) "
               "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
               "ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, state=EXCLUDED.state, "
               "stage=EXCLUDED.stage, progress=EXCLUDED.progress, song_id=EXCLUDED.song_id, "
               "error=EXCLUDED.error, updated=EXCLUDED.updated, "
               "owner_id=EXCLUDED.owner_id, owner_name=EXCLUDED.owner_name")
        try:
            with db.pool().connection() as conn:
                conn.execute(sql, (job.id, job.title, job.state, job.stage, job.progress,
                                   job.song_id, job.error, job.created, job.updated,
                                   job.owner_id, job.owner_name))
        except Exception:
            log.warning("pg: не удалось записать задачу %s", job.id, exc_info=True)

    def _pg_load(self, job_id: str) -> Job | None:
        try:
            with db.pool().connection() as conn:
                row = conn.execute(
                    "SELECT id, title, state, stage, progress, song_id, error, created, updated, "
                    "owner_id, owner_name "
                    "FROM jobs WHERE id=%s", (job_id,)).fetchone()
        except Exception:
            log.warning("pg: не удалось прочитать задачу %s", job_id, exc_info=True)
            return None
        if row is None:
            return None
        job = Job(id=row[0], title=row[1], audio="", state=row[2], stage=row[3],
                  progress=row[4], song_id=row[5], error=row[6],
                  created=row[7], updated=row[8],
                  owner_id=row[9] or "", owner_name=row[10] or "")
        with self._lock:
            self._jobs[job.id] = job
        return job

    def _pg_stale(self) -> None:
        """Вычистка из PG по тому же TTL, что и в памяти (лучшее приближение)."""
        try:
            with db.pool().connection() as conn:
                conn.execute("DELETE FROM jobs WHERE state IN ('done', 'error') AND updated < %s",
                             (time.time() - self.ttl_sec,))
        except Exception:
            log.warning("pg: не удалось вычистить старые задачи", exc_info=True)
