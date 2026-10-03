"""Публикация без ffmpeg: mp3 привозит бандл, здесь только наличие и waveform."""
from __future__ import annotations

import array
import wave

from karaoke_api import minio
from karaoke_api.store.publish import publish_song
from karaoke_api.store.songs import read_meta, song_key, write_meta


def _wav_bytes(seconds=0.5, sr=8000) -> bytes:
    import io

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(array.array("h", [0] * int(seconds * sr)).tobytes())
    return buf.getvalue()


def _song(sid: str = "t", *, mp3: bool = True) -> None:
    write_meta(sid, {"title": "Песня", "duration": 0.5, "lines": 1,
                     "source": {"file": "music/x.mp3"}})
    if mp3:
        for name in ("minus.mp3", "vocals.mp3", "original.mp3"):
            minio.put(song_key(sid, name), b"ID3fake")
    minio.put(song_key(sid, "vocals.wav"), _wav_bytes())


def test_publish_happy_without_ffmpeg():
    _song()
    entry = publish_song("t")
    assert entry["audio"] == "songs/t/minus.mp3"
    assert entry["original"] == "songs/t/original.mp3"
    assert entry["vocals"] == "songs/t/vocals.mp3"
    assert entry["duration"] == 0.5
    assert minio.exists("songs/t/waveform.json")   # посчитан из vocals.wav
    assert minio.exists("songs/t/pitch.json")      # дозалит пустой эталон


def test_publish_missing_minus_mp3_is_error():
    _song(mp3=False)
    try:
        publish_song("t")
    except RuntimeError as e:
        assert "minus.mp3" in str(e) and "перезапустите" in str(e)
    else:
        raise AssertionError("должен упасть без minus.mp3")


def test_publish_without_vocals_wav_still_works():
    _song()
    minio.delete(song_key("t", "vocals.wav"))
    entry = publish_song("t")
    assert entry["vocals"] == "songs/t/vocals.mp3"  # запасной трек есть
    assert not minio.exists("songs/t/waveform.json")


def test_waveform_recomputed_only_when_wav_changes():
    _song()
    publish_song("t")
    assert minio.exists("songs/t/waveform.json")

    calls = {"n": 0}
    real_download = minio.download

    def counting(key, dst):
        calls["n"] += 1
        return real_download(key, dst)

    minio.download = counting
    try:
        publish_song("t")  # wav не менялся — качать нечего
        assert calls["n"] == 0
    finally:
        minio.download = real_download


def test_publish_entry_never_none_and_meta_intact():
    _song()
    publish_song("t")
    assert read_meta("t")["title"] == "Песня"
