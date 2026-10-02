"""Хранилище data/songs: валидация, round-trip, история, манифест."""
import json

import pytest

from karaoke_api.store.songs import (
    all_ids,
    build_manifest,
    manifest_entry,
    read_lyrics,
    read_meta,
    save_lyrics,
    unique_sid,
    validate_lyrics,
    write_meta,
)


def _song(store, sid="t", **kw):
    meta = {"title": "Тест", "language": "ru", "duration": 100, **kw}
    write_meta(store, sid, meta)
    return meta


def test_validate_ok_and_sort():
    lang, segs, skips = validate_lyrics({
        "language": "ru",
        "segments": [{"start": 0, "end": 1, "text": "а", "words": [{"w": "а", "s": 0, "e": 1}]}],
        "skips": [{"s": 5, "e": 6}, {"s": 1, "e": 2}],
    })
    assert lang == "ru"
    assert segs[0]["words"] == [{"w": "а", "s": 0.0, "e": 1.0}]
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


def test_save_roundtrip_and_history(tmp_path):
    store = tmp_path / "songs"
    _song(store)
    payload = {"language": "ru", "segments": [{"start": 0, "end": 1, "text": "а", "words": []}],
               "skips": [{"s": 1, "e": 2}]}
    save_lyrics(store, "t", payload)
    assert read_lyrics(store, "t")["segments"][0]["text"] == "а"
    assert read_lyrics(store, "t")["skips"] == [{"s": 1.0, "e": 2.0}]
    assert read_meta(store, "t")["lines"] == 1
    # второе сохранение — первое уезжает в историю
    save_lyrics(store, "t", {**payload, "segments": [{"start": 0, "end": 2, "text": "б", "words": []}]})
    hist = list((store / "t" / "history").glob("lyrics-*.json"))
    assert len(hist) == 1
    assert json.loads(hist[0].read_text(encoding="utf-8"))["segments"][0]["text"] == "а"


def test_save_unknown_song(tmp_path):
    with pytest.raises(KeyError):
        save_lyrics(tmp_path / "songs", "nope", {"segments": [{"start": 0, "end": 1, "text": "x"}]})


def test_sid_traversal_blocked(tmp_path):
    store = tmp_path / "songs"
    with pytest.raises(ValueError):
        save_lyrics(store, "..", {"segments": [{"start": 0, "end": 1, "text": "x"}]})
    with pytest.raises(ValueError):
        read_meta(store, "../x")


def test_manifest(tmp_path):
    store = tmp_path / "songs"
    _song(store, "b", title="Б")
    _song(store, "a", title="А")
    assert all_ids(store) == ["a", "b"]
    m = build_manifest(store)
    assert [s["id"] for s in m["songs"]] == ["a", "b"]  # по алфавиту названий
    e = manifest_entry(store, "a")
    assert e["audio"] == "songs/a/minus.mp3"
    assert e["original"] is None  # нет source
    assert manifest_entry(store, "nope") is None


def _wav(path, seconds=1.0, sr=8000):
    import array
    import wave

    n = int(seconds * sr)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(array.array("h", [0] * n).tobytes())


def test_unique_sid(tmp_path):
    store = tmp_path / "songs"
    assert unique_sid(store, "a") == "a"
    _song(store, "a")
    assert unique_sid(store, "a") == "a-2"
    _song(store, "a-2")
    assert unique_sid(store, "a") == "a-3"
