"""
Каноническое хранилище песен: data/songs/<id>/ (файловая структура, без БД).

Раскладка песни:
  meta.json      id, title, language, duration, lines,
                 source {file, sha1}, pipeline {demucs, whisper, pitch},
                 created, updated
  lyrics.json    {language, segments, skips?} — канон текста и пропусков,
                 включая правки из редактора (через PUT /api/songs/<id>/lyrics)
  pitch.json     {t, midi, conf?} — эталон тона по вокалу
  waveform.json  пики громкости вокала
  vocals.wav     изолированный вокал (Demucs)
  minus.wav      минус (no_vocals)
  cache/         регенерируемые mp3 для плеера (minus/original/vocals)
  history/       бэкапы lyrics.json при каждом сохранении (последние 20)

Публикация в data/public/songs/ — дело karaoke_api.cli.export (читает отсюда).
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import re
from datetime import datetime
from pathlib import Path

from karaoke_api.utils import atomic_write_json, now_iso

HISTORY_KEEP = 20

log = logging.getLogger(__name__)


def song_dir(store: Path, sid: str) -> Path:
    if not re.fullmatch(r"[a-z0-9][a-z0-9\-]*", sid or ""):
        raise ValueError(f"плохой id песни: {sid!r}")
    return store / sid


def all_ids(store: Path) -> list[str]:
    """id песен: каталоги с meta.json, по алфавиту для стабильности."""
    if not store.is_dir():
        return []
    return sorted(p.name for p in store.iterdir() if p.is_dir() and (p / "meta.json").is_file())


def _read_json(path: Path, default=None):
    """Читать канон честно: отсутствие файла — default, порча — в лог."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except (OSError, json.JSONDecodeError) as e:
        log.warning("не прочитали %s: %s", path, e)
        return default


def write_json(path: Path, data: dict) -> None:
    """Атомарная запись канона (см. karaoke_api.utils.atomic_write_json)."""
    atomic_write_json(path, data)


def read_meta(store: Path, sid: str) -> dict:
    return _read_json(song_dir(store, sid) / "meta.json", {}) or {}


def write_meta(store: Path, sid: str, meta: dict) -> dict:
    d = song_dir(store, sid)
    d.mkdir(parents=True, exist_ok=True)
    meta = {**meta, "id": sid}
    write_json(d / "meta.json", meta)
    return meta


def read_lyrics(store: Path, sid: str) -> dict | None:
    return _read_json(song_dir(store, sid) / "lyrics.json")


def validate_lyrics(data: dict) -> tuple[str | None, list, list]:
    """Строгая проверка payload редактора. Возвращает (language, segments, skips)."""
    if not isinstance(data, dict):
        raise ValueError("нужен объект {language, segments}")
    language = data.get("language")
    if language is not None and not isinstance(language, str):
        raise ValueError("language — строка")
    segments = data.get("segments")
    if not isinstance(segments, list) or len(segments) == 0:
        raise ValueError("segments — непустой список")
    clean_segs = []
    for s in segments:
        if not isinstance(s, dict):
            raise ValueError("сегмент — объект")
        start, end = float(s.get("start", float("nan"))), float(s.get("end", float("nan")))
        if not (math.isfinite(start) and math.isfinite(end)) or end <= start:
            raise ValueError(f"битый сегмент [{s.get('start')}, {s.get('end')}]")
        text = s.get("text", "")
        if not isinstance(text, str):
            raise ValueError("text сегмента — строка")
        words = []
        for w in s.get("words", []) or []:
            if not isinstance(w, dict) or not isinstance(w.get("w"), str):
                raise ValueError("битое слово")
            ws, we = float(w.get("s", float("nan"))), float(w.get("e", float("nan")))
            if not (math.isfinite(ws) and math.isfinite(we)):
                raise ValueError(f"битое слово {w.get('w')!r}")
            words.append({"w": w["w"], "s": ws, "e": we})
        seg = {"start": start, "end": end, "text": text, "words": words}
        if isinstance(s.get("part"), str):
            seg["part"] = s["part"]
        clean_segs.append(seg)
    skips = []
    for r in data.get("skips", []) or []:
        if not isinstance(r, dict):
            raise ValueError("пропуск — объект {s, e}")
        rs, re = float(r.get("s", float("nan"))), float(r.get("e", float("nan")))
        if not (math.isfinite(rs) and math.isfinite(re)) or rs < 0 or re <= rs:
            raise ValueError(f"битый пропуск [{r.get('s')}, {r.get('e')}]")
        skips.append({"s": rs, "e": re})
    skips.sort(key=lambda r: r["s"])
    return language, clean_segs, skips


def save_lyrics(store: Path, sid: str, data: dict) -> dict:
    """Проверить, забэкапить, записать, обновить meta. Возвращает записанное."""
    language, segments, skips = validate_lyrics(data)
    d = song_dir(store, sid)
    if not d.is_dir():
        raise KeyError(f"нет песни {sid}")
    payload = {"language": language, "segments": segments}
    if skips:
        payload["skips"] = skips
    cur = d / "lyrics.json"
    if cur.is_file():
        hist = d / "history"
        hist.mkdir(exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d-%H%M%S-%f")  # микросекунды: быстрые PUT не коллидируют
        (hist / f"lyrics-{ts}.json").write_bytes(cur.read_bytes())
        olds = sorted(hist.glob("lyrics-*.json"))
        for stale in olds[:-HISTORY_KEEP]:
            stale.unlink(missing_ok=True)
    write_json(cur, payload)
    meta = read_meta(store, sid)
    meta["lines"] = len(segments)
    meta["updated"] = now_iso()
    write_meta(store, sid, meta)
    return payload


def manifest_entry(store: Path, sid: str) -> dict | None:
    """Строка каталога для фронта (public-имена файлов)."""
    d = song_dir(store, sid)
    meta = read_meta(store, sid)
    if not meta:
        return None
    has_source = bool(meta.get("source", {}).get("file"))
    return {
        "id": sid,
        "title": meta.get("title", sid),
        "audio": f"songs/{sid}/minus.mp3",
        "original": f"songs/{sid}/original.mp3" if has_source else None,
        "vocals": f"songs/{sid}/vocals.mp3" if (d / "vocals.wav").is_file() else None,
        "language": meta.get("language"),
        "lines": meta.get("lines", 0),
        "duration": meta.get("duration", 0),
    }


def build_manifest(store: Path) -> dict:
    songs = []
    for sid in all_ids(store):
        e = manifest_entry(store, sid)
        if e:
            songs.append(e)
    songs.sort(key=lambda s: str(s.get("title", s["id"])).lower())
    return {"songs": songs}


def sha1_of(path: Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def unique_sid(store: Path, want: str) -> str:
    """Свободный id: want, want-2, want-3..."""
    taken = set(all_ids(store))
    if want not in taken:
        return want
    n = 2
    while f"{want}-{n}" in taken:
        n += 1
    return f"{want}-{n}"


def wav_seconds(path: Path) -> float:
    try:
        import wave
        with wave.open(str(path), "rb") as w:
            return w.getnframes() / w.getframerate()
    except Exception:
        return 0.0
