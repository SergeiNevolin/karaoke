"""Публикация песни: опубликованные артефакты лежат РЯДОМ с каноном.

Один бакет, один префикс songs/<id>/ — публикация добавляет туда же:
  minus.mp3      (ffmpeg из minus.wav — минус для пения)
  original.mp3   (ffmpeg из исходника в music/ — полная песня, редактор)
  vocals.mp3     (ffmpeg из vocals.wav — запасной трек редактора)
  waveform.json  (пики громкости вокала)
  pitch.json     (если канон не привёз — ставим пустой эталон)

mp3 не перекодируем, если новее исходника (PUT lyrics — только JSON за миллисекунды).
CLI — karaoke_api.cli.export, рантайм — publish_one.
"""
from __future__ import annotations

import array
import logging
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

from karaoke_api import minio
from karaoke_api.store.songs import all_ids, read_lyrics, read_meta, song_key, wav_seconds
from karaoke_api.utils import slug

log = logging.getLogger(__name__)


def waveform_peaks(path: Path, buckets: int = 1200) -> tuple[list[float], float]:
    """Пики громкости вокала для отрисовки waveform (только stdlib)."""
    try:
        with wave.open(str(path), "rb") as w:
            n, ch, sw, sr = w.getnframes(), w.getnchannels(), w.getsampwidth(), w.getframerate()
            raw = w.readframes(n)
    except Exception as e:
        log.warning("waveform: %s", e)
        return [], 0.0
    if sw == 1:
        a = array.array("h", (b - 128 for b in raw))
    elif sw == 2:
        a = array.array("h", raw)
    elif sw == 4:
        a = array.array("i", raw)
    else:
        log.warning("waveform: неподдерживаемая разрядность %d байт", sw)
        return [], 0.0
    if ch > 1:
        a = array.array(a.typecode, (sum(a[i:i + ch]) // ch for i in range(0, len(a), ch)))
    # C-уровень вместо генератора abs по каждому сэмплу
    peak = max(max(a, default=0), -min(a, default=0), 1)
    bs = max(1, len(a) // buckets)
    peaks = []
    for i in range(0, len(a), bs):
        chunk = a[i:i + bs]
        peaks.append(round(max(max(chunk, default=0), -min(chunk, default=0)) / peak, 3))
    return peaks, round(n / sr, 1)


def _fresh(dest_head: dict | None, src_head: dict | None) -> bool:
    """mp3 не трогаем, если новее исходника (PUT lyrics — только JSON)."""
    if not dest_head or not src_head:
        return False
    return dest_head["last_modified"] >= src_head["last_modified"]


def encode_mp3(src: Path, dst: Path, quality: str, what: str) -> bool:
    log.info("%s -> %s", what, dst.name)
    r = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(src),
         "-codec:a", "libmp3lame", "-q:a", quality, str(dst)]
    )
    if r.returncode != 0:
        log.error("ffmpeg упал на %s", src)
        return False
    return True


def _ensure_mp3(src_local: Path, src_head: dict | None, sid: str, name: str,
                quality: str, title: str, tmp: Path) -> str | None:
    """Свежий mp3 в бакете (перекодируем при необходимости) -> публичный путь."""
    key = song_key(sid, name)
    if not _fresh(minio.head(key), src_head):
        if not encode_mp3(src_local, tmp / name, quality, f"{title}: {name}"):
            return None
        minio.put_file(key, tmp / name)
    return f"songs/{sid}/{name}"


def _original_key(sid: str, meta: dict, title: str) -> str | None:
    """Исходник полной песни: meta.source.file, иначе совпадение в music/."""
    src = str((meta.get("source") or {}).get("file") or "")
    if src and minio.exists(src):
        return src
    want = slug(title)
    for key in minio.list_keys("music/"):
        stem = key.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        if slug(stem) == want or stem == sid:
            return key
    return None


def publish_song(sid: str, quality: str = "4") -> dict | None:
    """Одна песня: канон -> опубликованные mp3/JSON в том же префиксе."""
    meta = read_meta(sid)
    title = meta.get("title", sid)
    minus_head = minio.head(song_key(sid, "minus.wav"))
    if minus_head is None:
        log.info("[SKIP] %s: нет минуса", title)
        return None

    tmp = Path(tempfile.mkdtemp(prefix=f"publish-{sid}-"))
    try:
        minus_local = tmp / "minus.wav"
        minio.download(song_key(sid, "minus.wav"), minus_local)
        if _ensure_mp3(minus_local, minus_head, sid, "minus.mp3", quality, title, tmp) is None:
            return None

        if minio.head(song_key(sid, "pitch.json")) is None:
            minio.put_json(song_key(sid, "pitch.json"), {"t": [], "midi": []})

        lyr = read_lyrics(sid) or {}
        segments = lyr.get("segments", [])

        # полная песня — играется в редакторе (исходник из meta.source / music/)
        original_rel = None
        original_key = _original_key(sid, meta, title)
        if original_key is None:
            log.warning("%s: нет исходника для original.mp3", title)
        else:
            src_local = tmp / "original.src"
            minio.download(original_key, src_local)
            original_rel = _ensure_mp3(src_local, minio.head(original_key), sid,
                                       "original.mp3", quality, title, tmp)

        # изолированный вокал — запасной трек редактора + пики waveform
        vocals_rel = None
        vocals_head = minio.head(song_key(sid, "vocals.wav"))
        if vocals_head is not None:
            vocals_local = tmp / "vocals.wav"
            minio.download(song_key(sid, "vocals.wav"), vocals_local)
            vocals_rel = _ensure_mp3(vocals_local, vocals_head, sid, "vocals.mp3",
                                     quality, title, tmp)
            peaks, wdur = waveform_peaks(vocals_local)
            minio.put_json(song_key(sid, "waveform.json"), {"peaks": peaks, "duration": wdur})
        else:
            log.warning("%s: нет vocals.wav, waveform и запасной трек недоступны", title)

        return {
            "id": sid,
            "title": title,
            "audio": f"songs/{sid}/minus.mp3",
            "original": original_rel,
            "vocals": vocals_rel,
            "language": lyr.get("language"),
            "lines": len(segments),
            "duration": meta.get("duration", round(wav_seconds(minus_local), 1)),
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def publish_one(sid: str, quality: str = "4") -> dict | None:
    """Публикация одной песни (вызывается из API/воркера)."""
    return publish_song(sid, quality)


def select_sids(only: str | None) -> list[str]:
    """id для публикации: все, либо один (--only по id или по названию трека)."""
    sids = all_ids()
    if not only:
        return sids
    hit = [s for s in sids if s == only]
    if not hit:
        hit = [s for s in sids if read_meta(s).get("title") == only]
    return hit
