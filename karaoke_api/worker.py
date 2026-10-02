"""Очередь задач: один фоновый поток-потребитель, состояние — JobRegistry."""
from __future__ import annotations

import logging
import queue
import shutil
import threading

from . import pipeline
from .config import JOB_TTL_SEC, STORE
from .registry import Job, JobRegistry

log = logging.getLogger(__name__)

registry = JobRegistry(ttl_sec=JOB_TTL_SEC)
_queue: queue.Queue[str | None] = queue.Queue()
_thread: threading.Thread | None = None


def submit(*, title: str, audio, lang: str = "ru",
           lyrics_text: str = "", lyrics_url: str = "") -> Job:
    """Зарегистрировать задачу и поставить её в очередь."""
    job = registry.create(title=title, audio=audio, lang=lang,
                          lyrics_text=lyrics_text, lyrics_url=lyrics_url)
    _queue.put(job.id)
    return job


def start() -> None:
    """Поднять потребителя (идемпотентно) и вычистить tmp-каталоги после аварий."""
    global _thread
    _clean_tmp()
    if _thread is not None and _thread.is_alive():
        return
    _thread = threading.Thread(target=_consume, name="karaoke-worker", daemon=True)
    _thread.start()
    log.info("worker запущен")


def stop(timeout: float = 5.0) -> None:
    global _thread
    if _thread is None or not _thread.is_alive():
        return
    _queue.put(None)
    _thread.join(timeout=timeout)
    _thread = None


def _consume() -> None:
    while True:
        job_id = _queue.get()
        try:
            if job_id is None:
                return
            job = registry.get(job_id)
            if job is None or job.state != "queued":
                continue
            registry.update(job_id, state="running")
            pipeline.run_job(job, registry)
        finally:
            _queue.task_done()


def _clean_tmp() -> None:
    if not STORE.exists():
        return
    for p in STORE.glob(".tmp-*"):
        shutil.rmtree(p, ignore_errors=True)
