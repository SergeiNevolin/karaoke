"""Вход через bebradio: JWT HS256 (sub+exp), cookie для медиа, выключенный режим."""
import time

import jwt
import pytest
from fastapi.testclient import TestClient

import karaoke_api.api.songs as api_songs
import karaoke_api.app as app_module
from karaoke_api import config
from karaoke_api.store.songs import write_meta

SECRET = "test-secret-0123456789abcdef01234567"


def make_token(secret: str = SECRET, sub: str | None = "user-1", exp: int | None = None, **extra) -> str:
    claims: dict = {"exp": exp if exp is not None else int(time.time()) + 3600, **extra}
    if sub is not None:
        claims["sub"] = sub
    return jwt.encode(claims, secret, algorithm="HS256")


@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setattr(config, "AUTH_JWT_SECRET", SECRET)
    return SECRET


@pytest.fixture
def client(secret, tmp_path, monkeypatch):
    store = tmp_path / "songs"
    monkeypatch.setattr("karaoke_api.api.songs.STORE", store)
    monkeypatch.setattr(api_songs, "publish_one", lambda sid: None)
    write_meta(store, "t", {"title": "Тест", "language": "ru", "duration": 10})
    return TestClient(app_module.app)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_auth_disabled_without_secret(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "AUTH_JWT_SECRET", "")
    monkeypatch.setattr("karaoke_api.api.songs.STORE", tmp_path / "songs")
    r = TestClient(app_module.app).get("/api/songs")
    assert r.status_code == 200


def test_no_token_401(client):
    r = client.get("/api/songs")
    assert r.status_code == 401
    assert r.json() == {"error": "Требуется вход в bebradio"}


def test_valid_bearer_200_and_sets_cookie(client):
    r = client.get("/api/songs", headers=bearer(make_token()))
    assert r.status_code == 200
    assert [s["id"] for s in r.json()["songs"]] == ["t"]
    assert "karaoke_auth=" in r.headers.get("set-cookie", "")


def test_expired_token_401(client):
    r = client.get("/api/songs", headers=bearer(make_token(exp=int(time.time()) - 10)))
    assert r.status_code == 401


def test_wrong_signature_401(client):
    r = client.get("/api/songs", headers=bearer(make_token(secret="чужой-секрет-0123456789abcdef-012345")))
    assert r.status_code == 401


def test_room_token_without_sub_401(client):
    # room-токены bebradio не несут sub — им доступ не даём
    token = make_token(sub=None, room="r1", scope="room_access")
    r = client.get("/api/songs", headers=bearer(token))
    assert r.status_code == 401


def test_cookie_opens_api(client):
    client.cookies.set("karaoke_auth", make_token())
    r = client.get("/api/songs")
    assert r.status_code == 200


def test_cookie_opens_songs_static(client):
    if not config.DATA_PUBLIC.exists():
        pytest.skip("data/public/songs отсутствует — статика не смонтирована")
    files = [f for f in config.DATA_PUBLIC.rglob("*") if f.is_file()]
    if not files:
        pytest.skip("нет файлов в data/public/songs")
    rel = files[0].relative_to(config.DATA_PUBLIC).as_posix()
    assert client.get(f"/songs/{rel}").status_code == 401
    client.cookies.set("karaoke_auth", make_token())
    assert client.get(f"/songs/{rel}").status_code == 200


def test_healthz_and_spa_stay_open(client):
    assert client.get("/healthz").status_code == 200
    assert client.get("/").status_code != 401
