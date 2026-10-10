"""Тесты PG-слоя: миграции, каталог, реестр задач.

Нужен PostgreSQL — conftest поднимает схему и чистит таблицы перед каждым тестом.
Локально: DATABASE_URL=postgresql://postgres:postgres@localhost:5432/karaoke pytest -q karaoke_api/tests
"""
from __future__ import annotations

import time

from karaoke_api import db, silo
from karaoke_api.registry import PgJobRegistry
from karaoke_api.store import catalog, songs
from karaoke_api.store.publish import publish_song


def test_migrate_idempotent():
    db.migrate()
    with db.pool().connection() as conn:
        versions = [r[0] for r in conn.execute("SELECT version FROM schema_migrations")]
    assert "001_init" in versions
    assert "002_owners" in versions


def test_manifest_from_pg():
    songs.write_meta("beta-song", {"title": "Beta", "language": "ru",
                                   "duration": 12.5, "lines": 3,
                                   "artist": "Beta Band",
                                   "owner": {"id": "user-1", "name": "Биба"}})
    songs.write_meta("alpha-song", {"title": "Alpha", "language": "en",
                                    "duration": 7, "lines": 5})
    # флаги original/vocals выставляет publish по факту наличия mp3 в бакете
    for name in ("minus.mp3", "original.mp3", "vocals.mp3"):
        silo.put(songs.song_key("beta-song", name), b"x", "audio/mpeg")
    publish_song("beta-song")

    m = songs.build_manifest()
    assert [s["id"] for s in m["songs"]] == ["alpha-song", "beta-song"]  # lower(title)
    assert m["songs"][1] == {
        "id": "beta-song",
        "title": "Beta",
        "audio": "songs/beta-song/minus.mp3",
        "original": "songs/beta-song/original.mp3",
        "vocals": "songs/beta-song/vocals.mp3",
        "language": "ru",
        "lines": 3,
        "duration": 12.5,
        "artist": "Beta Band",
        "owner_id": "user-1",
        "owner_name": "Биба",
    }
    assert m["songs"][0]["original"] is None and m["songs"][0]["vocals"] is None
    assert m["songs"][0]["artist"] is None
    assert m["songs"][0]["owner_id"] is None


def test_write_meta_partial_update():
    songs.write_meta("gamma-song", {"title": "Gamma", "language": "ru",
                                    "duration": 1, "lines": 1})
    catalog.upsert("gamma-song", strict=True, has_original=True)
    songs.write_meta("gamma-song", {"title": "Gamma 2", "language": "en",
                                    "duration": 2, "lines": 2})
    with db.pool().connection() as conn:
        row = conn.execute(
            "SELECT title, language, lines, duration, has_original FROM songs "
            "WHERE id='gamma-song'").fetchone()
    assert row == ("Gamma 2", "en", 2, 2.0, True)  # has_original не сброшен


def test_job_registry_roundtrip():
    reg = PgJobRegistry(ttl_sec=3600)
    job = reg.create(title="Трек", audio="music/x.mp3", owner_id="user-1", owner_name="Биба")
    assert reg.get(job.id) is job
    reg.update(job.id, state="running", stage="lyrics", progress=40)

    reg._jobs.clear()  # noqa: SLF001 — вычистили память, читаем из PG
    loaded = reg.get(job.id)
    assert loaded is not None
    assert (loaded.title, loaded.state, loaded.stage, loaded.progress) == (
        "Трек", "running", "lyrics", 40)
    assert loaded.audio == ""  # в PG — только статус, не исходники
    assert (loaded.owner_id, loaded.owner_name) == ("user-1", "Биба")

    reg.update(job.id, state="done", stage="done", progress=100, song_id="gamma-song")
    reg._jobs.clear()  # noqa: SLF001
    done = reg.get(job.id)
    assert done is not None
    assert (done.state, done.song_id, done.progress) == ("done", "gamma-song", 100)


def test_mark_interrupted():
    reg = PgJobRegistry(ttl_sec=3600)
    job = reg.create(title="X", audio="music/x.mp3")
    reg.update(job.id, state="running", stage="pitch")

    reg.mark_interrupted()
    reg._jobs.clear()  # noqa: SLF001
    loaded = reg.get(job.id)
    assert loaded is not None
    assert (loaded.state, loaded.stage, loaded.error) == ("error", "error", "перезапуск сервера")


def test_stale_jobs_deleted_from_pg():
    reg = PgJobRegistry(ttl_sec=1)
    old = reg.create(title="Old", audio="music/o.mp3")
    reg.update(old.id, state="done", stage="done", progress=100)
    with db.pool().connection() as conn:  # старше TTL напрямую в PG
        conn.execute("UPDATE jobs SET updated=%s WHERE id=%s", (time.time() - 100, old.id))
    reg._jobs.clear()  # noqa: SLF001

    fresh = reg.create(title="New", audio="music/n.mp3")  # create чистит старьё в PG
    assert reg.get(old.id) is None
    assert reg.get(fresh.id) is not None
