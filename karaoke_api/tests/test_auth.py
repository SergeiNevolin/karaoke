"""Чтение открыто без входа, запись (upload/правки) — только с JWT bebradio."""
import time

import jwt
import pytest
from fastapi.testclient import TestClient

import karaoke_api.api.songs as api_songs
import karaoke_api.app as app_module
from karaoke_api import config, silo
from karaoke_api.store.songs import write_meta

SECRET = "test-secret-0123456789abcdef01234567"
LYRICS = {"segments": [{"start": 0.0, "end": 2.0, "text": "Привет"}]}


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


def put_lyrics(client: TestClient, **kw) -> object:
    return client.put("/api/songs/t/lyrics", json=LYRICS, **kw)


def upload(client: TestClient, **kw) -> object:
    return client.post("/api/upload", files={"file": ("x.txt", b"abc", "text/plain")}, **kw)


def test_auth_disabled_without_secret(monkeypatch):
    monkeypatch.setattr(config, "AUTH_JWT_SECRET", "")
    c = TestClient(app_module.app)
    assert c.get("/api/songs").status_code == 200
    assert upload(c).status_code == 400  # авторизация выключена — дошли до валидации


def test_read_open_without_token(client):
    r = client.get("/api/songs")
    assert r.status_code == 200
    assert [s["id"] for s in r.json()["songs"]] == ["t"]


def test_read_open_even_with_bad_token(client):
    # испорченный токен на чтении не мешает: каталог public
    r = client.get("/api/songs", headers=bearer(make_token(secret="совсем-другой-ключ-0123456789")))
    assert r.status_code == 200


def test_docs_open_without_token(client):
    assert client.get("/docs").status_code == 200


def test_valid_bearer_200_and_sets_cookie(client):
    r = client.get("/api/songs", headers=bearer(make_token()))
    assert r.status_code == 200
    assert [s["id"] for s in r.json()["songs"]] == ["t"]
    assert "karaoke_auth=" in r.headers.get("set-cookie", "")


def test_upload_without_token_401(client):
    r = upload(client)
    assert r.status_code == 401
    assert r.json() == {"error": "Требуется вход в bebradio"}


def test_put_lyrics_without_token_401(client):
    r = put_lyrics(client)
    assert r.status_code == 401
    assert r.json() == {"error": "Требуется вход в bebradio"}


def test_mutation_expired_token_401(client):
    r = put_lyrics(client, headers=bearer(make_token(exp=int(time.time()) - 10)))
    assert r.status_code == 401


def test_mutation_wrong_signature_401(client):
    r = upload(client, headers=bearer(make_token(secret="совсем-другой-ключ-0123456789")))
    assert r.status_code == 401


def test_mutation_room_token_without_sub_401(client):
    # room-токены bebradio без sub не должны открывать запись
    token = make_token(sub=None, room="r1", scope="room_access")
    assert put_lyrics(client, headers=bearer(token)).status_code == 401
    assert upload(client, headers=bearer(token)).status_code == 401


def test_valid_bearer_opens_mutation_and_sets_cookie(client):
    r = put_lyrics(client, headers=bearer(make_token()))
    assert r.status_code == 200
    assert r.json().get("ok")
    assert "karaoke_auth=" in r.headers.get("set-cookie", "")


def test_cookie_opens_mutation(client):
    client.cookies.set("karaoke_auth", make_token())
    assert put_lyrics(client).status_code == 200


def test_upload_valid_token_passes_auth(client):
    # авторизация проходит — дошли до проверки расширения (400, не 401)
    r = upload(client, headers=bearer(make_token()))
    assert r.status_code == 400


def owned():
    write_meta("owned", {"title": "Чужая", "language": "ru", "duration": 5,
                         "owner": {"id": "user-1", "name": "Биба"}})


def test_put_lyrics_owner_ok(client):
    owned()
    r = client.put("/api/songs/owned/lyrics", json=LYRICS, headers=bearer(make_token(sub="user-1")))
    assert r.status_code == 200
    assert r.json().get("ok")


def test_put_lyrics_stranger_403(client):
    owned()
    r = client.put("/api/songs/owned/lyrics", json=LYRICS, headers=bearer(make_token(sub="user-2")))
    assert r.status_code == 403
    assert r.json() == {"error": "Править может только загрузивший песню"}


def test_put_lyrics_legacy_ownerless_ok(client):
    r = put_lyrics(client, headers=bearer(make_token(sub="user-9")))
    assert r.status_code == 200


def test_put_lyrics_missing_404(client):
    r = client.put("/api/songs/nope/lyrics", json=LYRICS, headers=bearer(make_token()))
    assert r.status_code == 404


def test_put_meta_owner_ok(client):
    owned()
    r = client.put("/api/songs/owned/meta", json={"title": "Новое название", "artist": "Новый автор"},
                   headers=bearer(make_token(sub="user-1")))
    assert r.status_code == 200
    assert r.json()["title"] == "Новое название"
    assert r.json()["artist"] == "Новый автор"
    row = next(s for s in client.get("/api/songs").json()["songs"] if s["id"] == "owned")
    assert row["title"] == "Новое название" and row["artist"] == "Новый автор"


def test_put_meta_stranger_403(client):
    owned()
    r = client.put("/api/songs/owned/meta", json={"title": "Хак", "artist": None},
                   headers=bearer(make_token(sub="user-2")))
    assert r.status_code == 403


def test_put_meta_legacy_ownerless_ok(client):
    r = client.put("/api/songs/t/meta", json={"title": "Переименована", "artist": None},
                   headers=bearer(make_token(sub="user-9")))
    assert r.status_code == 200
    assert r.json()["title"] == "Переименована"


def test_put_meta_missing_404(client):
    r = client.put("/api/songs/nope/meta", json={"title": "Х", "artist": None},
                   headers=bearer(make_token()))
    assert r.status_code == 404


def test_put_meta_empty_title_400(client):
    owned()
    r = client.put("/api/songs/owned/meta", json={"title": "   ", "artist": None},
                   headers=bearer(make_token(sub="user-1")))
    assert r.status_code == 400


def test_put_meta_clears_artist(client):
    owned()
    assert client.put("/api/songs/owned/meta", json={"title": "Чужая", "artist": "Кто-то"},
                      headers=bearer(make_token(sub="user-1"))).status_code == 200
    r = client.put("/api/songs/owned/meta", json={"title": "Чужая", "artist": None},
                   headers=bearer(make_token(sub="user-1")))
    assert r.json()["artist"] is None


def test_delete_owner_ok(client):
    owned()
    r = client.delete("/api/songs/owned", headers=bearer(make_token(sub="user-1")))
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert client.get("/api/songs/owned/lyrics").status_code == 404
    assert "owned" not in [s["id"] for s in client.get("/api/songs").json()["songs"]]


def test_delete_stranger_403(client):
    owned()
    r = client.delete("/api/songs/owned", headers=bearer(make_token(sub="user-2")))
    assert r.status_code == 403


def test_delete_missing_404(client):
    assert client.delete("/api/songs/nope", headers=bearer(make_token())).status_code == 404


def test_delete_without_token_401(client):
    owned()
    assert client.delete("/api/songs/owned").status_code == 401


def test_manifest_has_artist_owner(client):
    owned()
    row = next(s for s in client.get("/api/songs").json()["songs"] if s["id"] == "owned")
    assert row["owner_id"] == "user-1" and row["owner_name"] == "Биба"


def test_upload_captures_owner(client, monkeypatch):
    import karaoke_api.worker as worker_mod
    from karaoke_api.registry import Job
    seen = {}

    def fake_submit(**kw):
        seen.update(kw)
        return Job(id="job1", title=kw["title"], audio=kw["audio"])

    monkeypatch.setattr(worker_mod, "submit", fake_submit)
    r = client.post("/api/upload", files={"file": ("Песня.mp3", b"AAA")},
                    data={"owner_name": "  Биба  "}, headers=bearer(make_token(sub="user-7")))
    assert r.status_code == 200
    assert seen["owner_id"] == "user-7" and seen["owner_name"] == "Биба"


def test_static_open_without_token(client):
    silo.put("songs/t/minus.mp3", b"mp3-bytes")
    assert client.get("/songs/t/minus.mp3").status_code == 200


def test_healthz_and_spa_stay_open(client):
    assert client.get("/healthz").status_code == 200
    assert client.get("/").status_code != 401
