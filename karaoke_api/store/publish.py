"""Публикация песен из канона data/songs/ в data/public/songs/:

  songs/<id>/minus.mp3      (ffmpeg из minus.wav — минус для пения)
  songs/<id>/original.mp3   (ffmpeg из исходника — полная песня, редактор)
  songs/<id>/vocals.mp3     (ffmpeg из vocals.wav — запасной трек редактора)
  songs/<id>/waveform.json  (пики громкости вокала)
  songs/<id>/lyrics.json    (segments + language + skips)
  songs/<id>/pitch.json     (эталон тона)
  songs/manifest.json       (каталог для React)

mp3 не перекодируем, если свежее исходника (PUT lyrics после правок —
только JSON за миллисекунды). CLI — karaoke_api.cli.export, рантайм — publish_one.
"""
from __future__ import annotations

import array
import json
import logging
import subprocess
import wave
from pathlib import Path

from karaoke_api.config import DATA_PUBLIC, MUSIC, ROOT, STORE
from karaoke_api.store.songs import all_ids, read_lyrics, read_meta, wav_seconds
from karaoke_api.utils import slug

log = logging.getLogger(__name__)

AUDIO_EXTS = (".mp3", ".wav", ".flac", ".m4a", ".ogg", ".mp4", ".mkv", ".webm")


def find_original(bdir: Path, title: str) -> Path | None:
    """Исходник полной песни в music/: по имени папки бандла, иначе по slug."""
    if not MUSIC.is_dir():
        return None
    for ext in AUDIO_EXTS:
        p = MUSIC / f"{bdir.name}{ext}"
        if p.is_file():
            return p
    want = slug(title)
    for p in MUSIC.iterdir():
        if p.is_file() and p.suffix.lower() in AUDIO_EXTS and slug(p.stem) == want:
            return p
    return None


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


def fresh_enough(dst: Path, src: Path) -> bool:
    """mp3 не трогаем, если новее исходника (PUT lyrics — только JSON)."""
    try:
        return dst.is_file() and src.is_file() and dst.stat().st_mtime >= src.stat().st_mtime
    except OSError:
        return False


def encode_mp3(src: Path, dst: Path, quality: str, what: str) -> bool:
    log.info("%s -> %s/%s", what, dst.parent.name, dst.name)
    r = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(src),
         "-codec:a", "libmp3lame", "-q:a", quality, str(dst)]
    )
    if r.returncode != 0:
        log.error("ffmpeg упал на %s", src)
        return False
    return True


def ensure_mp3(src: Path, dst: Path, quality: str, title: str, sid: str,
               name: str) -> str | None:
    """Свежий mp3 рядом (перекодируем при необходимости) -> публичный путь."""
    if not fresh_enough(dst, src):
        if not encode_mp3(src, dst, quality, title):
            return None
    elif not dst.is_file():
        return None
    return f"songs/{sid}/{name}"


def publish_song(sid: str, sdir: Path, out_root: Path, quality: str,
                 store: Path = STORE) -> dict | None:
    """Один бандл из store в public. Возвращает entry манифеста."""
    meta = read_meta(store, sid)
    title = meta.get("title", sid)
    dest = out_root / sid
    dest.mkdir(parents=True, exist_ok=True)

    minus_src = sdir / "minus.wav"
    if not minus_src.is_file():
        log.info("[SKIP] %s: нет минуса", title)
        return None
    if ensure_mp3(minus_src, dest / "minus.mp3", quality, title, sid, "minus.mp3") is None:
        return None

    lyr = read_lyrics(store, sid) or {}
    segments = lyr.get("segments", [])
    doc = {"language": lyr.get("language"), "segments": segments}
    if lyr.get("skips"):
        doc["skips"] = lyr["skips"]
    (dest / "lyrics.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    pitch_src = sdir / "pitch.json"
    if pitch_src.is_file():
        (dest / "pitch.json").write_bytes(pitch_src.read_bytes())
    else:
        (dest / "pitch.json").write_text('{"t":[],"midi":[]}', encoding="utf-8")

    # полная песня — играется в редакторе (исходник из meta.source)
    original_rel = None
    src_file = Path(str(meta.get("source", {}).get("file") or ""))
    if not src_file.is_absolute():
        src_file = ROOT / src_file
    original_src = src_file if src_file.is_file() else find_original(sdir, title)
    if original_src is None:
        log.warning("%s: нет исходника для original.mp3", title)
    else:
        original_rel = ensure_mp3(original_src, dest / "original.mp3", quality,
                                  title, sid, "original.mp3")

    # изолированный вокал — запасной трек редактора + пики waveform
    vocals_src = sdir / "vocals.wav"
    vocals_rel = None
    if vocals_src.is_file():
        vocals_rel = ensure_mp3(vocals_src, dest / "vocals.mp3", quality,
                                title, sid, "vocals.mp3")
        peaks, wdur = waveform_peaks(vocals_src)
        (dest / "waveform.json").write_text(
            json.dumps({"peaks": peaks, "duration": wdur}), encoding="utf-8")
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
        "duration": meta.get("duration", round(wav_seconds(minus_src), 1)),
    }


def publish_one(sid: str, *, out_root: Path = DATA_PUBLIC, quality: str = "4") -> dict | None:
    """Публикация одной песни (вызывается из API/воркера, без subprocess)."""
    return publish_song(sid, STORE / sid, out_root, quality)


def read_manifest(out_root: Path) -> list[dict]:
    try:
        return json.loads((out_root / "manifest.json").read_text(encoding="utf-8")).get("songs", [])
    except (OSError, json.JSONDecodeError):
        return []


def write_manifest(out_root: Path, entries: list[dict]) -> None:
    entries.sort(key=lambda m: str(m.get("title", m.get("id"))).lower())
    (out_root / "manifest.json").write_text(
        json.dumps({"songs": entries}, ensure_ascii=False, indent=1), encoding="utf-8")


def upsert_manifest(out_root: Path, entry: dict) -> None:
    """Добавить/заменить строку манифеста по id (чтобы --only не затирал остальные)."""
    entries = [m for m in read_manifest(out_root) if m.get("id") != entry.get("id")]
    entries.append(entry)
    write_manifest(out_root, entries)


def select_sids(only: str | None, store: Path = STORE) -> list[str]:
    """id для публикации: все, либо один (--only по id или по названию трека)."""
    sids = all_ids(store)
    if not only:
        return sids
    hit = [s for s in sids if s == only]
    if not hit:
        hit = [s for s in sids if read_meta(store, s).get("title") == only]
    return hit
