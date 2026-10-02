"""Реестр задач GPU-сервиса: состояние — в памяти, результат — на диске, TTL-очистка."""
from __future__ import annotations

import logging
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

TERMINAL = {"done", "error"}


@dataclass
class Job:
    """Одна задача пайплайна (state: running | done | error)."""

    id: str
    root: Path
    filename: str
    src: Path
    lang: str = "ru"
    text: str = ""
    state: str = "running"
    stage: str = "queued"
    progress: int = 0
    error: str | None = None
    result_path: Path | None = None
    created: float = field(default_factory=time.time)
    updated: float = field(default_factory=time.time)

    @property
    def dir(self) -> Path:
        return self.root / self.id

    @property
    def work(self) -> Path:
        return self.dir / "work"

    def public(self) -> dict:
        """Полезная нагрузка статуса (без путей)."""
        return {"state": self.state, "stage": self.stage,
                "progress": self.progress, "error": self.error}


class JobRegistry:
    """Потокобезопасный реестр: завершённые задачи вычищаются по TTL (каталогом)."""

    def __init__(self, root: Path, ttl_sec: float = 3600.0) -> None:
        self.root = root
        self.ttl_sec = ttl_sec
        self._lock = threading.Lock()
        self._jobs: dict[str, Job] = {}
        self.root.mkdir(parents=True, exist_ok=True)

    def create(self, *, filename: str, suffix: str, lang: str = "ru",
               text: str = "") -> Job:
        job_id = uuid.uuid4().hex[:12]
        job = Job(id=job_id, root=self.root, filename=filename,
                  src=self.root / job_id / f"in{suffix}", lang=lang, text=text)
        with self._lock:
            self._cleanup_locked()
            self._jobs[job.id] = job
        job.dir.mkdir(parents=True, exist_ok=True)
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

    def drop(self, job_id: str) -> None:
        """Забыть задачу и стереть её каталог (для откатов до запуска потока)."""
        with self._lock:
            self._jobs.pop(job_id, None)
        shutil.rmtree(self.root / job_id, ignore_errors=True)

    def wipe(self) -> None:
        """На старте процесса: прошлые джобы не живут — вычищаем осиротевшие каталоги."""
        with self._lock:
            self._jobs.clear()
        for p in self._root_dirs():
            shutil.rmtree(p, ignore_errors=True)

    def cleanup(self) -> None:
        with self._lock:
            self._cleanup_locked()

    def _cleanup_locked(self) -> None:
        now = time.time()
        stale = [jid for jid, j in self._jobs.items()
                 if j.state in TERMINAL and now - j.updated > self.ttl_sec]
        for jid in stale:
            del self._jobs[jid]
            log.info("TTL: вычищаю задачу %s", jid)
        for jid in stale:
            shutil.rmtree(self.root / jid, ignore_errors=True)

    def _root_dirs(self) -> list[Path]:
        try:
            return [p for p in self.root.iterdir() if p.is_dir()]
        except OSError:
            return []

    def __len__(self) -> int:
        with self._lock:
            return len(self._jobs)
