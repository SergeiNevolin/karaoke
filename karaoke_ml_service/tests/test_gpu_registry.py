"""Реестр задач GPU: каталог задачи, TTL, drop, wipe — диск чистится."""
from __future__ import annotations

import time

from karaoke_ml_service.jobs import JobRegistry


def test_create_layout(tmp_path):
    reg = JobRegistry(root=tmp_path / "jobs")
    job = reg.create(filename="Мой трек.mp3", suffix=".mp3", lang="en", text="привет")
    assert job.dir.is_dir()
    assert job.src == job.dir / "in.mp3"
    assert job.lang == "en" and job.text == "привет"
    assert reg.get(job.id) is job
    assert len(reg) == 1


def test_public_has_no_paths(tmp_path):
    job = JobRegistry(root=tmp_path / "jobs").create(filename="a.wav", suffix=".wav")
    job.state, job.progress = "done", 100
    assert set(job.public()) == {"state", "stage", "progress", "error"}
    assert job.public()["state"] == "done"


def test_update_and_drop(tmp_path):
    reg = JobRegistry(root=tmp_path / "jobs")
    job = reg.create(filename="a.wav", suffix=".wav")
    reg.update(job.id, stage="lyrics", progress=62)
    assert reg.get(job.id).stage == "lyrics"
    reg.drop(job.id)
    assert reg.get(job.id) is None
    assert not job.dir.exists()
    reg.drop("unknown")  # откат несуществующей — не падает


def test_ttl_removes_done_with_dir(tmp_path):
    reg = JobRegistry(root=tmp_path / "jobs", ttl_sec=0.05)
    job = reg.create(filename="a.wav", suffix=".wav")
    reg.update(job.id, state="done")
    time.sleep(0.06)
    assert reg.get(job.id) is None
    assert not job.dir.exists()


def test_ttl_keeps_running_jobs(tmp_path):
    reg = JobRegistry(root=tmp_path / "jobs", ttl_sec=0.0)
    job = reg.create(filename="a.wav", suffix=".wav")
    reg.update(job.id, stage="separation", progress=10)
    assert reg.get(job.id) is not None, "running не вычищается по TTL"


def test_wipe_clears_everything(tmp_path):
    reg = JobRegistry(root=tmp_path / "jobs")
    (reg.root / "orphan").mkdir()
    job = reg.create(filename="a.wav", suffix=".wav")
    reg.wipe()
    assert len(reg) == 0
    assert not (reg.root / "orphan").exists()
    assert not job.dir.exists()
