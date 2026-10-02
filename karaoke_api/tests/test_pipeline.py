"""Пайплайн: сабмит -> поллинг -> безопасная распаковка -> store -> публикация."""
import array
import io
import wave
import zipfile
from pathlib import Path

import karaoke_api.worker as W
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


def _run(tmp_path, gpu=None, *, title="Test", src_name="song.mp3", lyrics_text="",
         lyrics_url="", publisher=None, poll_interval=0.0, timeout_sec=5.0, fetcher=None):
    store = tmp_path / "songs"
    src = tmp_path / src_name
    src.write_bytes(b"fake-audio")
    registry = JobRegistry(ttl_sec=60)
    job = registry.create(title=title, audio=src, lang="ru",
                          lyrics_text=lyrics_text, lyrics_url=lyrics_url)
    published: list[str] = []

    def _publish(sid: str) -> None:
        published.append(sid)
        if publisher is not None:
            publisher(sid)

    run_job(job, registry, store=store,
            gpu_factory=lambda url: gpu or FakeGpu(),
            publisher=_publish,
            fetcher=fetcher, poll_interval=poll_interval, timeout_sec=timeout_sec)
    return registry, job, store, published


def test_run_job_happy(tmp_path):
    registry, job, store, published = _run(tmp_path)
    assert job.state == "done"
    assert job.song_id == "test"
    assert job.progress == 100
    assert published == ["test"]
    assert read_lyrics(store, "test")["segments"][0]["text"] == "a"
    meta = read_meta(store, "test")
    assert meta["pipeline"]["via"] == "gpu-service"
    assert meta["pipeline"]["models"] == "fake"
    assert (store / "test" / "vocals.wav").is_file()
    assert (store / "test" / "minus.wav").is_file()
    assert not list(store.glob(".tmp-*"))


def test_run_job_video_passthrough(tmp_path):
    """Видео едет на GPU-бокс как есть — демультиплекс там."""
    gpu = FakeGpu()
    _run(tmp_path, gpu=gpu, title="Clip", src_name="clip.mp4")
    assert gpu.submitted.suffix == ".mp4"


def test_run_job_gpu_error(tmp_path):
    class Dead:
        def submit_job(self, *a, **k):
            raise RuntimeError("GPU down")

    registry, job, store, _ = _run(tmp_path, gpu=Dead())
    assert job.state == "error"
    assert "GPU down" in (job.error or "")
    assert not list(store.glob(".tmp-*"))


def test_run_job_poll_timeout(tmp_path):
    class Never(FakeGpu):
        def job_status(self, _jid):
            return {"state": "running", "stage": "separation", "progress": 10}

    registry, job, store, _ = _run(tmp_path, gpu=Never(),
                                   poll_interval=0.001, timeout_sec=0.01)
    assert job.state == "error"
    assert "не завершился" in (job.error or "")
    assert not list(store.glob(".tmp-*"))


def test_run_job_rejects_foreign_bundle_files(tmp_path):
    gpu = FakeGpu(bundle=_bundle({"evil.sh": "#!/bin/sh"}))
    registry, job, store, _ = _run(tmp_path, gpu=gpu)
    assert job.state == "error"
    assert "посторонними" in (job.error or "")
    assert not list(store.glob(".tmp-*"))


def test_run_job_rejects_oversized_bundle(tmp_path, monkeypatch):
    monkeypatch.setattr("karaoke_api.pipeline.MAX_BUNDLE_MB", 0)
    registry, job, store, _ = _run(tmp_path)
    assert job.state == "error"
    assert "больше" in (job.error or "")
    assert not list(store.glob(".tmp-*"))


def test_run_job_publish_failure_retries_then_error(tmp_path):
    calls = {"n": 0}

    def bad(sid):
        calls["n"] += 1
        raise RuntimeError("ffmpeg missing")

    registry, job, store, _ = _run(tmp_path, publisher=bad)
    assert calls["n"] == 2  # один повтор
    assert job.state == "error"
    assert "Сохранено, но публикация упала" in (job.error or "")
    assert (store / "test").is_dir()  # сама песня в store осталась


def test_run_job_custom_text_to_gpu(tmp_path):
    gpu = FakeGpu()
    _run(tmp_path, gpu=gpu, lyrics_text="мой текст")
    assert gpu.submitted_text == "мой текст"


def test_run_job_fetches_lyrics_url(tmp_path):
    gpu = FakeGpu()
    registry, job, store, _ = _run(tmp_path, gpu=gpu, lyrics_url="https://genius.com/x",
                                   fetcher=lambda url: ["строка 1"])
    assert job.state == "done"
    assert gpu.submitted_text == "строка 1"


def test_worker_submit_registers_job():
    job = W.submit(title="X", audio=Path("x.mp3"))
    try:
        assert W.registry.get(job.id) is job
        assert job.state == "queued"
    finally:
        W.registry._jobs.pop(job.id, None)  # noqa: SLF001
        drained = W._queue.get_nowait()  # noqa: SLF001
        W._queue.task_done()  # noqa: SLF001
        assert drained == job.id
