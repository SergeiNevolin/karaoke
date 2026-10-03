"""GPU-микросервис: контракты endpoints (шаги — фейки, диск во tmp, семафор — модульный)."""
from __future__ import annotations

import io
import time
import zipfile
from pathlib import Path

import pytest
from fakes import BoomPipeline, FakePitch, FakeSeparator, FakeTranscriber, wav
from fastapi.testclient import TestClient

import karaoke_ml_service.app as gpu_app
from karaoke_ml_service.errors import ApiError
from karaoke_ml_service.jobs import JobRegistry
from karaoke_ml_service.pipeline import KaraokePipeline


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(gpu_app, "registry",
                        JobRegistry(root=tmp_path / "jobs", ttl_sec=3600.0))

    def factory():
        return KaraokePipeline(separator=FakeSeparator(),
                               transcriber=FakeTranscriber(),
                               pitch_extractor=FakePitch(),
                               keep_whisper=False)

    monkeypatch.setattr(gpu_app, "make_pipeline", factory)
    return TestClient(gpu_app.app)


def _upload(api, url, src: Path, **data):
    with open(src, "rb") as f:
        return api.post(url, files={"file": (src.name, f)}, data=data)


def _wait_done(api, jid, tries=200):
    for _ in range(tries):
        st = api.get(f"/v1/jobs/{jid}").json()
        if st.get("state") in ("done", "error"):
            return st
        time.sleep(0.02)
    raise AssertionError("job завис")


def _assert_lock_free():
    assert gpu_app._gpu_lock.acquire(blocking=False), "семафор не отдан"
    gpu_app._gpu_lock.release()


def test_pipeline_lifecycle(api, tmp_path):
    src = tmp_path / "in.wav"
    wav(src, seconds=1.0)
    jid = _upload(api, "/v1/jobs", src, lang="ru", lyrics_text="").json()["job_id"]
    st = _wait_done(api, jid)
    assert st["state"] == "done", st
    assert st["stage"] == "done"
    assert st["progress"] == 100
    r = api.get(f"/v1/jobs/{jid}/result")
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert set(z.namelist()) == {"vocals.wav", "minus.wav",
                                 "minus.mp3", "vocals.mp3", "original.mp3",
                                 "lyrics.json", "pitch.json"}
    for name in ("minus.mp3", "vocals.mp3", "original.mp3"):
        d = z.read(name)
        # ID3-тег либо синхронизация кадра MPEG (0xFF + 11 бит)
        assert len(d) > 100 and (d[:3] == b"ID3" or (d[0] == 0xFF and d[1] & 0xE0 == 0xE0)), name
    lyrics = __import__("json").loads(z.read("lyrics.json"))
    assert lyrics["language"] == "ru" and lyrics["segments"]
    # диск под задачей: бандл остался, вход и рабочий каталог вычищены
    job_dir = gpu_app.registry.root / jid
    assert (job_dir / "bundle.zip").is_file()
    assert not job_dir.joinpath("work").exists()
    assert not any(job_dir.glob("in.*"))
    _assert_lock_free()


def test_pipeline_overlays_custom_text(api, tmp_path):
    src = tmp_path / "in.wav"
    wav(src)
    jid = _upload(api, "/v1/jobs", src, lang="ru",
                  lyrics_text="hello brave world").json()["job_id"]
    st = _wait_done(api, jid)
    assert st["state"] == "done", st
    r = api.get(f"/v1/jobs/{jid}/result")
    z = zipfile.ZipFile(io.BytesIO(r.content))
    lyrics = __import__("json").loads(z.read("lyrics.json"))
    texts = " ".join(s["text"] for s in lyrics["segments"])
    assert "brave" in texts, texts


def test_pipeline_error(api, tmp_path, monkeypatch):
    monkeypatch.setattr(gpu_app, "make_pipeline", lambda: BoomPipeline())
    src = tmp_path / "in.wav"
    wav(src)
    jid = _upload(api, "/v1/jobs", src).json()["job_id"]
    st = _wait_done(api, jid)
    assert st["state"] == "error"
    assert "сгорел" in st["error"]
    assert api.get(f"/v1/jobs/{jid}/result").status_code == 404
    _assert_lock_free()


def test_submit_busy_429(api, tmp_path):
    gpu_app._gpu_lock.acquire()
    try:
        src = tmp_path / "in.wav"
        wav(src)
        r = _upload(api, "/v1/jobs", src)
        assert r.status_code == 429
        assert "GPU занят" in r.json()["error"]
        assert len(gpu_app.registry) == 0
    finally:
        gpu_app._gpu_lock.release()


def test_bad_ext_400(api, tmp_path):
    src = tmp_path / "in.txt"
    src.write_bytes(b"nope")
    r = _upload(api, "/v1/jobs", src)
    assert r.status_code == 400
    assert "аудио/видео" in r.json()["error"]
    assert len(gpu_app.registry) == 0
    _assert_lock_free()


def test_bad_lang_400(api, tmp_path):
    src = tmp_path / "in.wav"
    wav(src)
    r = _upload(api, "/v1/jobs", src, lang="jp")
    assert r.status_code == 400
    assert "lang" in r.json()["error"]
    _assert_lock_free()


def test_text_too_long_400(api, tmp_path, monkeypatch):
    monkeypatch.setattr(gpu_app, "MAX_LYRICS_TEXT", 5)
    src = tmp_path / "in.wav"
    wav(src)
    r = _upload(api, "/v1/jobs", src, lyrics_text="0123456789")
    assert r.status_code == 400
    _assert_lock_free()


def test_upload_too_big_413(api, tmp_path, monkeypatch):
    monkeypatch.setattr(gpu_app, "MAX_UPLOAD_MB", 0)
    src = tmp_path / "in.wav"
    wav(src)
    r = _upload(api, "/v1/jobs", src)
    assert r.status_code == 413
    assert "МБ" in r.json()["error"]
    # частичный файл убран вместе с каталогом задачи, семафор отдан
    assert len(gpu_app.registry) == 0
    assert list(gpu_app.registry.root.iterdir()) == []
    _assert_lock_free()


def test_pipeline_video(api, tmp_path, monkeypatch):
    """Видео демультиплексится на GPU-боксе: сабмит .mp4 — пайплайн доходит."""
    import karaoke_ml_service.pipeline as pipeline_mod

    def fake_demux(src: Path, dst: Path) -> None:
        wav(dst)

    monkeypatch.setattr(pipeline_mod, "demux", fake_demux)
    src = tmp_path / "in.mp4"
    src.write_bytes(b"fake-video")
    jid = _upload(api, "/v1/jobs", src).json()["job_id"]
    st = _wait_done(api, jid)
    assert st["state"] == "done", st
    r = api.get(f"/v1/jobs/{jid}/result")
    assert r.status_code == 200
    assert "vocals.wav" in zipfile.ZipFile(io.BytesIO(r.content)).namelist()


def test_bundle_missing_files_is_error(api, tmp_path, monkeypatch):
    """Пайплайн вернул без minus.wav — задача падает, а не отдаёт битый бандл."""

    class Broken:
        def run(self, *a, **kw):
            vocals = tmp_path / "v.wav"
            wav(vocals)
            return {"vocals": str(vocals), "minus": str(tmp_path / "nope.wav"),
                    "lyrics": {"language": "ru", "segments": []}, "pitch": {"t": []}}

    monkeypatch.setattr(gpu_app, "make_pipeline", lambda: Broken())
    src = tmp_path / "in.wav"
    wav(src)
    jid = _upload(api, "/v1/jobs", src).json()["job_id"]
    st = _wait_done(api, jid)
    assert st["state"] == "error"
    assert "minus" in st["error"]
    _assert_lock_free()


def test_status_and_result_unknown_404(api):
    assert api.get("/v1/jobs/nope").status_code == 404
    assert api.get("/v1/jobs/nope/result").status_code == 404


def test_result_not_ready_404(api, tmp_path):
    job = gpu_app.registry.create(filename="in.wav", suffix=".wav")
    st = api.get(f"/v1/jobs/{job.id}").json()
    assert st["state"] == "running" and st["stage"] == "queued"
    assert api.get(f"/v1/jobs/{job.id}/result").status_code == 404


def test_info_reports_models(api):
    r = api.get("/v1/info").json()
    assert r == {"demucs": "htdemucs_ft", "whisper": "large-v3", "pitch": "crepe"}


def test_pitch_endpoint(api, tmp_path, monkeypatch):
    monkeypatch.setattr(gpu_app, "make_pitch_extractor", lambda: FakePitch())
    src = tmp_path / "vocals.wav"
    wav(src)
    r = _upload(api, "/v1/pitch", src)
    assert r.status_code == 200, r.text
    assert r.json() == {"t": [0.0], "midi": [60], "conf": [0.9]}


def test_pitch_endpoint_bad_ext_400(api, tmp_path):
    src = tmp_path / "vocals.txt"
    src.write_bytes(b"x")
    assert _upload(api, "/v1/pitch", src).status_code == 400


def test_lifespan_wipes_orphans(tmp_path, monkeypatch):
    reg = JobRegistry(root=tmp_path / "jobs")
    (reg.root / "dead").mkdir(parents=True)
    monkeypatch.setattr(gpu_app, "registry", reg)
    with TestClient(gpu_app.app):
        assert not (reg.root / "dead").exists()


def test_api_error_body(api):
    """Контракт тела ошибок: {"error": ...} на любом статусе."""
    r = api.get("/v1/jobs/nope")
    assert r.status_code == 404
    assert set(r.json()) == {"error"}
    with pytest.raises(ApiError) as e:
        raise ApiError(502, "upstream")
    assert e.value.status == 502
