"""Клиент GPU-микросервиса: сабмит, поллинг, забор бандла, ошибки."""
import io
import zipfile

import pytest

from karaoke_api.gpu_client import GpuClient, GpuError


def _wav(path, seconds=0.2, sr=8000):
    import array
    import wave
    n = int(seconds * sr)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(array.array("h", [0] * n).tobytes())


def test_submit_poll_download(tmp_path, monkeypatch):
    import httpx

    def fake_post(url, timeout=None, files=None, data=None):
        class R:
            status_code = 200

            def json(self):
                return {"job_id": "abc123"}

        assert url.endswith("/v1/jobs")
        assert data["lang"] == "ru"
        assert "model" not in data and "whisper" not in data
        return R()

    states = [
        {"state": "running", "stage": "separation", "progress": 10},
        {"state": "done", "stage": "done", "progress": 100},
    ]

    def fake_get(url, timeout=None):
        class R:
            status_code = 200

            def json(self):
                return states.pop(0)

            @property
            def content(self):
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w") as z:
                    z.writestr("vocals.wav", b"RIFF....")
                    z.writestr("minus.wav", b"RIFF....")
                    z.writestr("lyrics.json", '{"language": "ru", "segments": []}')
                    z.writestr("pitch.json", '{"t": [], "midi": []}')
                return buf.getvalue()

        return R()

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setattr(httpx, "get", fake_get)
    wav = tmp_path / "a.wav"
    _wav(wav)
    cl = GpuClient("http://gpu:8001")
    rid = cl.submit_job(wav, "ru", "текст")
    assert rid == "abc123"
    assert cl.job_status(rid)["state"] == "running"
    assert cl.job_status(rid)["state"] == "done"
    raw = cl.job_result(rid)
    assert set(zipfile.ZipFile(io.BytesIO(raw)).namelist()) == {
        "vocals.wav", "minus.wav", "lyrics.json", "pitch.json"}


def test_gpu_url_required():
    with pytest.raises(GpuError):
        GpuClient("")


def test_client_http_error(tmp_path, monkeypatch):
    import httpx

    class R:
        status_code = 500
        text = "boom"

        def json(self):
            raise ValueError("no json")

    monkeypatch.setattr(httpx, "post", lambda *a, **k: R())
    monkeypatch.setattr(httpx, "get", lambda *a, **k: R())
    wav = tmp_path / "a.wav"
    _wav(wav)
    cl = GpuClient("http://gpu:8001", backoff=0)
    with pytest.raises(GpuError):
        cl.submit_job(wav, "ru")
    with pytest.raises(GpuError):
        cl.job_status("x")
    with pytest.raises(GpuError):
        cl.pitch(wav)


def _conn_down(url, **kwargs):
    import httpx
    raise httpx.ConnectError("down", request=httpx.Request("GET", url))


def test_get_retries_transient_errors(tmp_path, monkeypatch):
    import httpx

    calls = {"n": 0}

    def flaky(url, timeout=None):
        calls["n"] += 1
        if calls["n"] < 3:
            raise httpx.ConnectError("down", request=httpx.Request("GET", url))

        class R:
            status_code = 200

            def json(self):
                return {"state": "done"}

        return R()

    monkeypatch.setattr(httpx, "get", flaky)
    cl = GpuClient("http://gpu:8001", backoff=0)
    assert cl.job_status("j")["state"] == "done"
    assert calls["n"] == 3


def test_get_gives_up_after_retries(tmp_path, monkeypatch):
    import httpx

    calls = {"n": 0}

    def always(url, timeout=None):
        calls["n"] += 1
        raise httpx.ConnectError("down", request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", always)
    cl = GpuClient("http://gpu:8001", retries=3, backoff=0)
    with pytest.raises(GpuError, match="недоступен"):
        cl.job_status("j")
    assert calls["n"] == 3


def test_post_is_not_retried(tmp_path, monkeypatch):
    import httpx

    calls = {"n": 0}

    def down(url, timeout=None, files=None, data=None):
        calls["n"] += 1
        raise httpx.ConnectError("down", request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", down)
    wav = tmp_path / "a.wav"
    _wav(wav)
    cl = GpuClient("http://gpu:8001", backoff=0)
    with pytest.raises(GpuError):
        cl.submit_job(wav, "ru")
    assert calls["n"] == 1


def test_submit_busy_429_keeps_server_message(tmp_path, monkeypatch):
    import httpx

    class R:
        status_code = 429

        def json(self):
            return {"error": "GPU занят"}

    monkeypatch.setattr(httpx, "post", lambda *a, **k: R())
    wav = tmp_path / "a.wav"
    _wav(wav)
    cl = GpuClient("http://gpu:8001", backoff=0)
    with pytest.raises(GpuError, match="занят"):
        cl.submit_job(wav, "ru")


def test_client_400_is_not_retried(tmp_path, monkeypatch):
    import httpx

    calls = {"n": 0}

    class R:
        status_code = 400
        text = "плохой файл"

        def json(self):
            return {"error": "плохой файл"}

    def get(url, timeout=None):
        calls["n"] += 1
        return R()

    monkeypatch.setattr(httpx, "get", get)
    cl = GpuClient("http://gpu:8001", retries=3, backoff=0)
    with pytest.raises(GpuError, match="плохой файл"):
        cl.job_status("j")
    assert calls["n"] == 1
