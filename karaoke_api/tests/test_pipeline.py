"""Пайплайн: сабмит -> бандл -> установка в объекты store -> публикация."""
import array
import io
import wave
import zipfile
from pathlib import Path

import karaoke_api.worker as W
from karaoke_api import minio
from karaoke_api.config import SCRATCH
from karaoke_api.pipeline import run_job
from karaoke_api.registry import JobRegistry
from karaoke_api.store.songs import read_lyrics, read_meta


def _wav_bytes(seconds=1.0, sr=8000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(array.array("h", [0] * int(seconds * sr)).tobytes())
    return buf.getvalue()


def _bundle(extra: dict | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("vocals.wav", _wav_bytes())
        z.writestr("minus.wav", _wav_bytes())
        z.writestr("minus.mp3", b"ID3fake-minus")
        z.writestr("vocals.mp3", b"ID3fake-vocals")
        z.writestr("original.mp3", b"ID3fake-original")
        z.writestr("lyrics.json",
                   '{"language": "ru", "segments": [{"start": 0, "end": 1, "text": "a", "words": []}]}')
        z.writestr("pitch.json", '{"t": [0], "midi": [60], "conf": [0.9]}')
        for name, data in (extra or {}).items():
            z.writestr(name, data)
    return buf.getvalue()


class FakeGpu:
    def __init__(self, bundle: bytes | None = None):
        self.bundle = _bundle() if bundle is None else bundle
        self.calls = []
        self.submitted: Path | None = None
        self.submitted_text = None

    def submit_job(self, audio, lang, text=""):
        self.calls.append("submit")
        self.submitted = Path(audio)
        self.submitted_text = text
        return "remote-1"

    def job_status(self, _jid):
        self.calls.append("status")
        return {"state": "done", "stage": "done", "progress": 100}

    def job_result(self, _jid):
        self.calls.append("result")
        return self.bundle

    def service_info(self) -> dict:
        return {"models": "fake"}


def _run(gpu=None, *, title="Test", src_name="song.mp3", lyrics_text="",
         lyrics_url="", publisher=None, poll_interval=0.0, timeout_sec=5.0, fetcher=None):
    src_key = f"music/{src_name}"
    minio.put(src_key, b"fake-audio")
    registry = JobRegistry(ttl_sec=60)
    job = registry.create(title=title, audio=src_key, lang="ru",
                          lyrics_text=lyrics_text, lyrics_url=lyrics_url)
    published: list[str] = []

    def _publish(sid: str) -> None:
        published.append(sid)
        if publisher is not None:
            publisher(sid)

    run_job(job, registry,
            gpu_factory=lambda url: gpu or FakeGpu(),
            publisher=_publish,
            fetcher=fetcher, poll_interval=poll_interval, timeout_sec=timeout_sec)
    return registry, job, published


def test_run_job_happy():
    registry, job, published = _run()
    assert job.state == "done"
    assert job.song_id == "test"
    assert job.progress == 100
    assert published == ["test"]
    assert read_lyrics("test")["segments"][0]["text"] == "a"
    meta = read_meta("test")
    assert meta["pipeline"]["via"] == "gpu-service"
    assert meta["pipeline"]["models"] == "fake"
    assert meta["source"]["file"] == "music/song.mp3"
    assert meta["source"]["sha1"]  # посчитан по скачанному исходнику
    assert minio.exists("songs/test/vocals.wav")
    assert minio.exists("songs/test/minus.wav")
    assert minio.exists("songs/test/minus.mp3")   # mp3 привёз бандл
    assert minio.exists("songs/test/original.mp3")
    assert minio.exists("songs/test/meta.json")
    assert not list(SCRATCH.glob("job-*"))  # скраб всегда убирается


def test_run_job_rejects_bundle_without_mp3():
    """Бандл без mp3 (старый GPU-сервис) — задача падает, а не публикуется без них."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("vocals.wav", _wav_bytes())
        z.writestr("minus.wav", _wav_bytes())
        z.writestr("lyrics.json", '{"language": "ru", "segments": []}')
        z.writestr("pitch.json", '{"t": [], "midi": []}')
    registry, job, _ = _run(gpu=FakeGpu(bundle=buf.getvalue()))
    assert job.state == "error"
    assert "Бандл без" in (job.error or "")
    assert not list(SCRATCH.glob("job-*"))


def test_run_job_video_passthrough():
    """Конец на mp4 с GPU-сервиса возвращается как есть и ложится в store."""
    gpu = FakeGpu()
    _run(gpu=gpu, title="Clip", src_name="clip.mp4")
    assert gpu.submitted.suffix == ".mp4"


def test_run_job_gpu_error():
    class Dead:
        def submit_job(self, *a, **k):
            raise RuntimeError("GPU down")

    registry, job, _ = _run(gpu=Dead())
    assert job.state == "error"
    assert "GPU down" in (job.error or "")
    assert not list(SCRATCH.glob("job-*"))


def test_run_job_poll_timeout():
    class Never(FakeGpu):
        def job_status(self, _jid):
            return {"state": "running", "stage": "separation", "progress": 10}

    registry, job, _ = _run(gpu=Never(), poll_interval=0.001, timeout_sec=0.01)
    assert job.state == "error"
    assert "не завершился" in (job.error or "")
    assert not list(SCRATCH.glob("job-*"))


def test_run_job_rejects_foreign_bundle_files():
    gpu = FakeGpu(bundle=_bundle({"evil.sh": "#!/bin/sh"}))
    registry, job, _ = _run(gpu=gpu)
    assert job.state == "error"
    assert "посторонними" in (job.error or "")
    assert not list(SCRATCH.glob("job-*"))


def test_run_job_rejects_oversized_bundle(monkeypatch):
    monkeypatch.setattr("karaoke_api.pipeline.MAX_BUNDLE_MB", 0)
    registry, job, _ = _run()
    assert job.state == "error"
    assert "больше" in (job.error or "")
    assert not list(SCRATCH.glob("job-*"))


def test_run_job_publish_failure_retries_then_error():
    calls = {"n": 0}

    def bad(sid):
        calls["n"] += 1
        raise RuntimeError("нет minus.mp3 — перезапустите обработку песни")

    registry, job, _ = _run(publisher=bad)
    assert calls["n"] == 2  # один повтор
    assert job.state == "error"
    assert "Сохранено, но публикация упала" in (job.error or "")
    assert read_meta("test")["id"] == "test"  # песня осталась в store


def test_run_job_custom_text_to_gpu():
    gpu = FakeGpu()
    _run(gpu=gpu, lyrics_text="мой текст")
    assert gpu.submitted_text == "мой текст"


def test_run_job_fetches_lyrics_url():
    gpu = FakeGpu()
    registry, job, _ = _run(gpu=gpu, lyrics_url="https://genius.com/x",
                            fetcher=lambda url: ["строка 1"])
    assert job.state == "done"
    assert gpu.submitted_text == "строка 1"


def test_run_job_missing_source():
    registry = JobRegistry(ttl_sec=60)
    job = registry.create(title="X", audio="music/gone.mp3", lang="ru")
    run_job(job, registry, gpu_factory=lambda url: FakeGpu(),
            publisher=lambda sid: None, poll_interval=0.0, timeout_sec=5.0)
    assert job.state == "error"
    assert "не найден" in (job.error or "")


def test_worker_submit_registers_job():
    job = W.submit(title="X", audio="music/x.mp3")
    try:
        assert W.registry.get(job.id) is job
        assert job.state == "queued"
    finally:
        W.registry._jobs.pop(job.id, None)  # noqa: SLF001
        drained = W._queue.get_nowait()  # noqa: SLF001
        W._queue.task_done()  # noqa: SLF001
        assert drained == job.id
