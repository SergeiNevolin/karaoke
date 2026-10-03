"""Вход через bebradio: JWT HS256 (sub+exp), cookie после Bearer, 401 без токена."""
import time

import jwt
import pytest
from fastapi.testclient import TestClient

import karaoke_api.api.songs as api_songs
import karaoke_api.app as app_module
from karaoke_api import config, minio
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
def client(secret, monkeypatch):
    monkeypatch.setattr(api_songs, "publish_one", lambda sid: None)
    write_meta("t", {"title": "Песня", "language": "ru", "duration": 10})
    return TestClient(app_module.app)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_auth_disabled_without_secret(monkeypatch):
    monkeypatch.setattr(config, "AUTH_JWT_SECRET", "")
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
    r = client.get("/api/songs", headers=bearer(make_token(secret="совсем-другой-ключ-0123456789")))
    assert r.status_code == 401


def test_room_token_without_sub_401(client):
    # room-токены bebradio без sub не должны открывать приватное
    token = make_token(sub=None, room="r1", scope="room_access")
    r = client.get("/api/songs", headers=bearer(token))
    assert r.status_code == 401


def test_cookie_opens_api(client):
    client.cookies.set("karaoke_auth", make_token())
    r = client.get("/api/songs")
    assert r.status_code == 200


def test_static_401_and_cookie_200(client):
    minio.put("songs/t/minus.mp3", b"mp3-bytes")
    assert client.get("/songs/t/minus.mp3").status_code == 401
    client.cookies.set("karaoke_auth", make_token())
    r = client.get("/songs/t/minus.mp3")
    assert r.status_code == 200
    assert r.content == b"mp3-bytes"


def test_healthz_and_spa_stay_open(client):
    assert client.get("/healthz").status_code == 200
    assert client.get("/").status_code != 401
