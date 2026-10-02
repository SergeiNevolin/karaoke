"""Реестр задач: create/get/update, полезная нагрузка, TTL-очистка завершённых."""
import time
from pathlib import Path

from karaoke_api.registry import JobRegistry


def test_create_get_update():
    reg = JobRegistry(ttl_sec=60)
    job = reg.create(title="A", audio=Path("a.mp3"))
    assert reg.get(job.id) is job
    assert job.state == "queued"
    reg.update(job.id, state="done", progress=100, song_id="a")
    assert job.state == "done"
    assert job.progress == 100
    assert job.song_id == "a"
    reg.update("missing", state="error")  # неизвестный id — no-op
    assert reg.get("missing") is None


def test_ttl_cleanup_drops_finished_only():
    reg = JobRegistry(ttl_sec=0.01)
    old = reg.create(title="Old", audio=Path("o.mp3"))
    running = reg.create(title="Run", audio=Path("r.mp3"))
    reg.update(old.id, state="done")
    reg.update(running.id, state="running")
    time.sleep(0.02)
    fresh = reg.create(title="New", audio=Path("n.mp3"))  # cleanup на создании
    assert reg.get(old.id) is None
    assert reg.get(running.id) is running  # работающая задача не чистится
    assert reg.get(fresh.id) is fresh


def test_public_hides_internals():
    reg = JobRegistry()
    job = reg.create(title="A", audio=Path("a.mp3"), lyrics_text="секрет")
    pub = job.public()
    assert set(pub) == {"id", "state", "stage", "progress", "title", "songId", "error"}
    assert pub["title"] == "A"
    assert pub["id"] == job.id
