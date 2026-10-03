"""Endpoints поверх объектного store: каталог, текст, статика с Range, загрузка."""
import pytest
from fastapi.testclient import TestClient

import karaoke_api.api.jobs as api_jobs
import karaoke_api.api.songs as api_songs
import karaoke_api.app as app_module
import karaoke_api.worker as worker_mod
from karaoke_api import minio
from karaoke_api.registry import Job
from karaoke_api.store.songs import save_lyrics, write_meta


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(api_songs, "publish_one", lambda sid: None)
    write_meta("t", {"title": "Песня", "language": "ru", "duration": 10})
    save_lyrics("t", {
        "language": "ru",
        "segments": [{"start": 0, "end": 1, "text": "я", "words": [{"w": "я", "s": 0, "e": 1}]}],
    })
    return TestClient(app_module.app)


def test_songs_from_store(client):
    songs = client.get("/api/songs").json()["songs"]
    assert [s["id"] for s in songs] == ["t"]
    assert songs[0]["audio"] == "songs/t/minus.mp3"


def test_lyrics_roundtrip(client):
    got = client.get("/api/songs/t/lyrics").json()
    assert len(got["segments"]) == 1
    body = {"language": "ru",
            "segments": [{"start": 0, "end": 2, "text": "ты", "words": []}],
            "skips": [{"s": 1, "e": 2}]}
    r = client.put("/api/songs/t/lyrics", json=body).json()
    assert r == {"ok": True, "lines": 1}
    got = client.get("/api/songs/t/lyrics").json()
    assert got["segments"][0]["text"] == "ты"
    assert got["skips"] == [{"s": 1.0, "e": 2.0}]


def test_lyrics_unknown_song_404(client):
    r = client.get("/api/songs/nope/lyrics")
    assert r.status_code == 404
    assert "error" in r.json()
    r = client.put("/api/songs/nope/lyrics", json={
        "segments": [{"start": 0, "end": 1, "text": "x", "words": []}]})
    assert r.status_code == 404
    assert "error" in r.json()


def test_lyrics_invalid_payload_400(client):
    # битые данные не должны попадать в store (валидация до записи)
    r = client.put("/api/songs/t/lyrics", json={"segments": []})
    assert r.status_code == 400
    assert "error" in r.json()
    #NaN-ловушка: pydantic обязан дать 400, а не 500 на float(None)
    r = client.put("/api/songs/t/lyrics", json={
        "segments": [{"start": "abc", "end": 1, "text": "x", "words": []}]})
    assert r.status_code == 400
    assert "error" in r.json()
    # строка вместо списка сегментов
    r = client.put("/api/songs/t/lyrics", json={"segments": "мусор"})
    assert r.status_code == 400
    assert "error" in r.json()


def test_lyrics_put_publish_fail_still_ok(client, monkeypatch):
    def boom(sid):
        raise RuntimeError("ffmpeg missing")

    monkeypatch.setattr(api_songs, "publish_one", boom)
    r = client.put("/api/songs/t/lyrics", json={
        "language": "ru",
        "segments": [{"start": 0, "end": 2, "text": "ты", "words": []}]})
    assert r.status_code == 200  # сохранение прошло — не ошибка запроса
    body = r.json()
    assert body["ok"] is True
    assert "warning" in body
    got = client.get("/api/songs/t/lyrics").json()
    assert got["segments"][0]["text"] == "ты"


def test_static_full_and_range(client):
    minio.put("songs/t/minus.mp3", b"0123456789")
    r = client.get("/songs/t/minus.mp3")
    assert r.status_code == 200
    assert r.content == b"0123456789"
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-type"] == "audio/mpeg"
    r = client.get("/songs/t/minus.mp3", headers={"Range": "bytes=2-4"})
    assert r.status_code == 206
    assert r.content == b"234"
    assert r.headers["content-range"] == "bytes 2-4/10"


def test_static_missing_404(client):
    assert client.get("/songs/nope/x.mp3").status_code == 404


def test_static_bad_range_416(client):
    minio.put("songs/t/minus.mp3", b"0123456789")
    r = client.get("/songs/t/minus.mp3", headers={"Range": "bytes=99-199"})
    assert r.status_code == 416


def test_job_unknown_404(client):
    r = client.get("/api/jobs/doesnotexist")
    assert r.status_code == 404
    assert "error" in r.json()


def test_upload_bad_extension_400(client):
    r = client.post("/api/upload", files={"file": ("a.txt", b"hi")})
    assert r.status_code == 400
    assert "error" in r.json()


def test_upload_missing_file_400(client):
    r = client.post("/api/upload")
    assert r.status_code == 400
    assert "error" in r.json()


def test_upload_too_large_413(client, monkeypatch):
    monkeypatch.setattr(api_jobs, "MAX_UPLOAD_MB", 0)
    r = client.post("/api/upload", files={"file": ("a.mp3", b"xx")})
    assert r.status_code == 413
    assert "error" in r.json()
    assert not minio.list_keys("music/")  # объект не должен залиться


def test_upload_empty_file_400(client):
    r = client.post("/api/upload", files={"file": ("a.mp3", b"")})
    assert r.status_code == 400
    assert "error" in r.json()
    assert not minio.list_keys("music/")  # объект не должен залиться


def test_upload_ok(client, monkeypatch):
    seen = {}

    def fake_submit(**kw):
        seen.update(kw)
        return Job(id="job1", title=kw["title"], audio=kw["audio"])

    monkeypatch.setattr(worker_mod, "submit", fake_submit)
    r = client.post("/api/upload", files={"file": ("Песня.mp3", b"AAA")}, data={"lang": "en"})
    assert r.status_code == 200
    assert r.json() == {"jobId": "job1"}
    assert seen["lang"] == "en"
    assert seen["audio"] == "music/pesnya.mp3"  # ключ в бакете, slug имени файла
    assert minio.get(seen["audio"]) == b"AAA"


def test_upload_unique_keys(client, monkeypatch):
    jobs = []
    monkeypatch.setattr(worker_mod, "submit",
                        lambda **kw: jobs.append(kw) or Job(id="j", **kw))
    for _ in range(2):
        client.post("/api/upload", files={"file": ("song.mp3", b"x")})
    assert jobs[0]["audio"] == "music/song.mp3"
    assert jobs[1]["audio"] == "music/song-2.mp3"


def test_unhandled_exception_500():
    from fastapi import FastAPI

    from karaoke_api.errors import install_error_handlers

    application = FastAPI()
    install_error_handlers(application)

    @application.get("/boom")
    async def boom():
        raise RuntimeError("boom")

    with TestClient(application, raise_server_exceptions=False) as c:
        r = c.get("/boom")
    assert r.status_code == 500
    assert "error" in r.json()
