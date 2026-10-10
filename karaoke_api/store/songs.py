"""
Каноническое хранилище песен: объекты songs/<id>/ в Silo (см. karaoke_api.silo).

Раскладка песни:
  meta.json      id, title, language, duration, lines,
                 source {file, sha1}, pipeline {demucs, whisper, pitch},
                 created, updated
  lyrics.json    {language, segments, skips?} — канон текста и пропусков,
                 включая правки из редактора (через PUT /api/songs/<id>/lyrics)
  pitch.json     {t, midi, conf?} — эталон тона по вокалу
  waveform.json  пики громкости вокала (пишет publish)
  vocals.wav     изолированный вокал (Demucs)
  minus.wav      минус (no_vocals)
  minus.mp3      опубликованный минус для плеера (из бандла GPU-сервиса)
  original.mp3   полная песня для редактора (из бандла)
  vocals.mp3     запасной трек редактора (из бандла)
  history/       бэкапы lyrics.json при каждом сохранении (последние 20)

Всё это же пространство отдаётся наружу как /songs/<id>/...; каталог
music/ в бакете хранит загруженные исходники (meta.source.file).
"""
from __future__ import annotations

import hashlib
import logging
import math
import re
from datetime import datetime

from karaoke_api import silo
from karaoke_api.store import catalog
from karaoke_api.utils import now_iso

HISTORY_KEEP = 20

SONGS = "songs/"

log = logging.getLogger(__name__)


def song_prefix(sid: str) -> str:
    """Префикс песни; заодно крыса и path traversal отсекаются."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9\-]*", sid or ""):
        raise ValueError(f"плохой id песни: {sid!r}")
    return f"{SONGS}{sid}/"


def song_key(sid: str, name: str) -> str:
    return f"{song_prefix(sid)}{name}"


def all_ids() -> list[str]:
    """id песен: префиксы с meta.json, по алфавиту для стабильности."""
    ids = set()
    for key in silo.list_keys(SONGS):
        rest = key[len(SONGS):]
        sid, _, name = rest.partition("/")
        if name == "meta.json" and re.fullmatch(r"[a-z0-9][a-z0-9\-]*", sid):
            ids.add(sid)
    return sorted(ids)


def read_json(key: str, default=None):
    """Читать канон честно: отсутствие объекта — default, порча — в лог."""
    return silo.get_json(key, default)


def write_json(key: str, data: dict) -> None:
    """Запись канона: один PUT — в Silo он атомарен."""
    silo.put_json(key, data)


def read_meta(sid: str) -> dict:
    return read_json(song_key(sid, "meta.json"), {}) or {}


def write_meta(sid: str, meta: dict) -> dict:
    meta = {**meta, "id": sid}
    write_json(song_key(sid, "meta.json"), meta)
    owner = meta.get("owner") or {}
    catalog.upsert(sid, title=meta.get("title") or sid, language=meta.get("language"),
                   artist=meta.get("artist"),
                   owner_id=owner.get("id") or None, owner_name=owner.get("name") or None,
                   lines=meta.get("lines") or 0, duration=meta.get("duration") or 0,
                   source_sha1=(meta.get("source") or {}).get("sha1"),
                   created=meta.get("created"), updated=meta.get("updated"))
    return meta


def read_lyrics(sid: str) -> dict | None:
    return read_json(song_key(sid, "lyrics.json"))


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


def check_owner(sid: str, sub: str | None) -> dict | None:
    """Мета песни, если sub может её править/удалять, иначе None.

    Владелец — загрузивший (owner.id из meta). Песни без владельца (легаси)
    правит любой вошедший; гости — никто (их отсекает middleware).
    """
    meta = read_meta(sid)
    if not meta:
        return None
    owner_id = (meta.get("owner") or {}).get("id")
    if owner_id and sub != owner_id:
        return None
    return meta


def delete_song(sid: str) -> bool:
    """Удалить песню целиком: объекты в Silo + строка каталога. Нет песни — False."""
    if not read_meta(sid):
        return False
    silo.delete_prefix(song_prefix(sid))
    catalog.delete(sid)
    return True


def save_lyrics(sid: str, data: dict) -> dict:
    """Проверить, забэкапить, записать, обновить meta. Возвращает записанное."""
    language, segments, skips = validate_lyrics(data)
    if not read_meta(sid):
        raise KeyError(f"нет песни {sid}")
    payload = {"language": language, "segments": segments}
    if skips:
        payload["skips"] = skips
    cur_key = song_key(sid, "lyrics.json")
    cur = silo.get(cur_key)
    if cur is not None:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S-%f")  # микросекунды: быстрые PUT не коллидируют
        hist_prefix = f"{song_prefix(sid)}history/"
        silo.put(f"{hist_prefix}lyrics-{ts}.json", cur, "application/json")
        olds = sorted(k for k in silo.list_keys(hist_prefix)
                      if k.rsplit("/", 1)[-1].startswith("lyrics-"))
        for stale in olds[:-HISTORY_KEEP]:
            silo.delete(stale)
    write_json(cur_key, payload)
    meta = read_meta(sid)
    meta["lines"] = len(segments)
    meta["updated"] = now_iso()
    write_meta(sid, meta)
    return payload


def set_song_meta(sid: str, title: str, artist: str | None) -> dict:
    """Обновить название и автора песни. Нет песни — KeyError."""
    title = (title or "").strip()
    if not title:
        raise ValueError("название не может быть пустым")
    if artist is not None:
        artist = artist.strip() or None
    meta = read_meta(sid)
    if not meta:
        raise KeyError(f"нет песни {sid}")
    meta["title"] = title
    if artist:
        meta["artist"] = artist
    else:
        meta.pop("artist", None)
    meta["updated"] = now_iso()
    write_meta(sid, meta)
    return meta


def manifest_entry(sid: str) -> dict | None:
    """Строка каталога для фронта (public-имена файлов).

    original/vocals — только если mp3 реально лежит в бакете: ссылка
    на несуществующий файл ломает редактор.
    """
    meta = read_meta(sid)
    if not meta:
        return None
    return {
        "id": sid,
        "title": meta.get("title", sid),
        "audio": f"songs/{sid}/minus.mp3",
        "original": f"songs/{sid}/original.mp3" if silo.exists(song_key(sid, "original.mp3")) else None,
        "vocals": f"songs/{sid}/vocals.mp3" if silo.exists(song_key(sid, "vocals.mp3")) else None,
        "language": meta.get("language"),
        "lines": meta.get("lines", 0),
        "duration": meta.get("duration", 0),
        "artist": meta.get("artist"),
        "owner_id": (meta.get("owner") or {}).get("id"),
        "owner_name": (meta.get("owner") or {}).get("name"),
    }


def build_manifest(limit: int = 200, offset: int = 0) -> dict:
    """Каталог для фронта — из PG (без запроса к Silo на каждую строку)."""
    return {"songs": catalog.manifest_rows(limit, offset)}


def sha1_of(path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def unique_sid(want: str) -> str:
    """Свободный id: want, want-2, want-3..."""
    taken = set(all_ids())
    if want not in taken:
        return want
    n = 2
    while f"{want}-{n}" in taken:
        n += 1
    return f"{want}-{n}"


def wav_seconds(path) -> float:
    try:
        import wave
        with wave.open(str(path), "rb") as w:
            return w.getnframes() / w.getframerate()
    except Exception:
        return 0.0
