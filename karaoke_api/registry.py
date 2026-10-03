"""Реестр задач: потокобезопасный словарь с TTL для завершённых задач."""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field


@dataclass
class Job:
    """Состояние одной загрузки (state: queued | running | done | error)."""

    id: str
    title: str
    audio: str  # ключ исходника в бакете (music/<файл>) либо локальный путь
    lang: str = "ru"
    lyrics_text: str = ""
    lyrics_url: str = ""
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
               lyrics_text: str = "", lyrics_url: str = "") -> Job:
        job = Job(id=uuid.uuid4().hex[:12], title=title, audio=audio, lang=lang,
                  lyrics_text=lyrics_text, lyrics_url=lyrics_url)
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

    def __len__(self) -> int:
        with self._lock:
            return len(self._jobs)
