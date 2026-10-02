"""Endpoints каталога и правок: честные статусы, store во временной папке."""
import pytest
from fastapi.testclient import TestClient

import karaoke_api.api.jobs as api_jobs
import karaoke_api.api.songs as api_songs
import karaoke_api.app as app_module
import karaoke_api.worker as worker_mod
from karaoke_api.registry import Job
from karaoke_api.store.songs import save_lyrics, write_meta


@pytest.fixture
def client(tmp_path, monkeypatch):
    store = tmp_path / "songs"
    monkeypatch.setattr("karaoke_api.api.songs.STORE", store)
    monkeypatch.setattr(api_songs, "publish_one", lambda sid: None)
    write_meta(store, "t", {"title": "Тест", "language": "ru", "duration": 10})
    save_lyrics(store, "t", {
        "language": "ru",
        "segments": [{"start": 0, "end": 1, "text": "а", "words": [{"w": "а", "s": 0, "e": 1}]}],
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
            "segments": [{"start": 0, "end": 2, "text": "б", "words": []}],
            "skips": [{"s": 1, "e": 2}]}
    r = client.put("/api/songs/t/lyrics", json=body).json()
    assert r == {"ok": True, "lines": 1}
    got = client.get("/api/songs/t/lyrics").json()
    assert got["segments"][0]["text"] == "б"
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
    # пустой список сегментов отклоняет доменная валидация store
    r = client.put("/api/songs/t/lyrics", json={"segments": []})
    assert r.status_code == 400
    assert "error" in r.json()
    # битый тип поля ловит pydantic (раньше — 500 из float(None))
    r = client.put("/api/songs/t/lyrics", json={
        "segments": [{"start": "abc", "end": 1, "text": "x", "words": []}]})
    assert r.status_code == 400
    assert "error" in r.json()
    # неверная структура тела целиком
    r = client.put("/api/songs/t/lyrics", json={"segments": "нет"})
    assert r.status_code == 400
    assert "error" in r.json()


def test_lyrics_put_publish_fail_still_ok(client, monkeypatch):
    def boom(sid):
        raise RuntimeError("ffmpeg missing")

    monkeypatch.setattr(api_songs, "publish_one", boom)
    r = client.put("/api/songs/t/lyrics", json={
        "language": "ru",
        "segments": [{"start": 0, "end": 2, "text": "б", "words": []}]})
    assert r.status_code == 200  # данные сохранены — не ошибка запроса
    body = r.json()
    assert body["ok"] is True
    assert "warning" in body
    got = client.get("/api/songs/t/lyrics").json()
    assert got["segments"][0]["text"] == "б"


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


def test_upload_too_large_413(client, tmp_path, monkeypatch):
    monkeypatch.setattr(api_jobs, "MAX_UPLOAD_MB", 0)
    monkeypatch.setattr(api_jobs, "MUSIC", tmp_path / "music")
    r = client.post("/api/upload", files={"file": ("a.mp3", b"xx")})
    assert r.status_code == 413
    assert "error" in r.json()
    assert not list((tmp_path / "music").glob("*.mp3"))  # частичный файл удалён


def test_upload_empty_file_400(tmp_path, monkeypatch):
    monkeypatch.setattr(api_jobs, "MUSIC", tmp_path / "music")
    r = TestClient(app_module.app).post("/api/upload", files={"file": ("a.mp3", b"")})
    assert r.status_code == 400
    assert "error" in r.json()
    assert not list((tmp_path / "music").glob("*.mp3"))


def test_upload_ok(tmp_path, monkeypatch):
    monkeypatch.setattr(api_jobs, "MUSIC", tmp_path / "music")
    seen = {}

    def fake_submit(**kw):
        seen.update(kw)
        return Job(id="job1", title=kw["title"], audio=kw["audio"])

    monkeypatch.setattr(worker_mod, "submit", fake_submit)
    r = TestClient(app_module.app).post(
        "/api/upload", files={"file": ("Песня.mp3", b"AAA")}, data={"lang": "en"})
    assert r.status_code == 200
    assert r.json() == {"jobId": "job1"}
    assert seen["lang"] == "en"
    assert seen["audio"].suffix == ".mp3"
    assert seen["audio"].read_bytes() == b"AAA"


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
