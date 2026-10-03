"""Канон хранилища (объекты songs/<id>/): валидация, round-trip, история, манифест."""
import json

import pytest

from karaoke_api import minio
from karaoke_api.store.songs import (
    all_ids,
    build_manifest,
    manifest_entry,
    read_lyrics,
    read_meta,
    save_lyrics,
    song_key,
    unique_sid,
    validate_lyrics,
    write_meta,
)


def _song(sid="t", **kw):
    meta = {"title": "Песня", "language": "ru", "duration": 100, **kw}
    write_meta(sid, meta)
    return meta


def test_validate_ok_and_sort():
    lang, segs, skips = validate_lyrics({
        "language": "ru",
        "segments": [{"start": 0, "end": 1, "text": "я", "words": [{"w": "я", "s": 0, "e": 1}]}],
        "skips": [{"s": 5, "e": 6}, {"s": 1, "e": 2}],
    })
    assert lang == "ru"
    assert segs[0]["words"] == [{"w": "я", "s": 0.0, "e": 1.0}]
    assert skips == [{"s": 1.0, "e": 2.0}, {"s": 5.0, "e": 6.0}]


def test_validate_rejects():
    with pytest.raises(ValueError):
        validate_lyrics({"segments": []})
    with pytest.raises(ValueError):
        validate_lyrics({"segments": [{"start": 2, "end": 1, "text": "x"}]})
    with pytest.raises(ValueError):
        validate_lyrics({"segments": [{"start": 0, "end": 1, "text": "x"}],
                         "skips": [{"s": 2, "e": 2}]})
    with pytest.raises(ValueError):
        validate_lyrics("junk")


def test_save_roundtrip_and_history():
    _song()
    payload = {"language": "ru", "segments": [{"start": 0, "end": 1, "text": "я", "words": []}],
               "skips": [{"s": 1, "e": 2}]}
    save_lyrics("t", payload)
    assert read_lyrics("t")["segments"][0]["text"] == "я"
    assert read_lyrics("t")["skips"] == [{"s": 1.0, "e": 2.0}]
    assert read_meta("t")["lines"] == 1
    # после правки: старый текст остаётся в истории, новый — канон
    save_lyrics("t", {**payload, "segments": [{"start": 0, "end": 2, "text": "ты", "words": []}]})
    hist = [k for k in minio.list_keys("songs/t/history/")
            if k.rsplit("/", 1)[-1].startswith("lyrics-")]
    assert len(hist) == 1
    assert json.loads(minio.get(hist[0]))["segments"][0]["text"] == "я"


def test_save_history_pruned():
    _song()
    payload = {"language": "ru", "segments": [{"start": 0, "end": 1, "text": "x", "words": []}]}
    for i in range(25):
        payload = {"language": "ru",
                   "segments": [{"start": 0, "end": 1, "text": f"v{i}", "words": []}]}
        save_lyrics("t", payload)
    hist = [k for k in minio.list_keys("songs/t/history/")
            if k.rsplit("/", 1)[-1].startswith("lyrics-")]
    assert len(hist) == 20  # HISTORY_KEEP


def test_save_unknown_song():
    with pytest.raises(KeyError):
        save_lyrics("nope", {"segments": [{"start": 0, "end": 1, "text": "x"}]})


def test_sid_traversal_blocked():
    with pytest.raises(ValueError):
        save_lyrics("..", {"segments": [{"start": 0, "end": 1, "text": "x"}]})
    with pytest.raises(ValueError):
        read_meta("../x")


def test_manifest():
    _song("b", title="Яя")
    _song("a", title="Аа")
    assert all_ids() == ["a", "b"]
    m = build_manifest()
    assert [s["id"] for s in m["songs"]] == ["a", "b"]  # сортировка по названию
    e = manifest_entry("a")
    assert e["audio"] == "songs/a/minus.mp3"
    assert e["original"] is None  # нет original.mp3 в бакете
    assert e["vocals"] is None  # нет vocals.mp3 в бакете
    assert manifest_entry("nope") is None


def test_manifest_vocals_flag():
    """Ссылка на mp3 — только когда сам mp3 лежит в бакете (wav не считается)."""
    _song("a")
    assert manifest_entry("a")["vocals"] is None
    minio.put(song_key("a", "vocals.wav"), b"RIFF")  # одного wav мало
    assert manifest_entry("a")["vocals"] is None
    minio.put(song_key("a", "vocals.mp3"), b"ID3")
    assert manifest_entry("a")["vocals"] == "songs/a/vocals.mp3"


def test_unique_sid():
    assert unique_sid("a") == "a"
    _song("a")
    assert unique_sid("a") == "a-2"
    _song("a-2")
    assert unique_sid("a") == "a-3"
