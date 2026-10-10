"""Публикация песни: опубликованные артефакты лежат РЯДОМ с каноном.

Один бакет, один префикс songs/<id>/ — публикация добавляет туда же:
  minus.mp3 / vocals.mp3 / original.mp3 — привозит бандл GPU-сервиса
    (ffmpeg живёт только там; здесь проверяем лишь наличие)
  waveform.json  (пики громкости вокала, из vocals.wav)
  pitch.json     (если канон не привёз — ставим пустой эталон)

Всё решается по head(): PUT lyrics — только JSON за миллисекунды,
wav из бакета качаем лишь для первичного расчёта waveform.
CLI — karaoke_api.cli.export, рантайм — publish_one.
"""
from __future__ import annotations

import array
import logging
import tempfile
import wave
from pathlib import Path

from karaoke_api import silo
from karaoke_api.store import catalog
from karaoke_api.store.songs import all_ids, read_lyrics, read_meta, song_key

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


def _rel_if(sid: str, name: str) -> str | None:
    """Публичный путь mp3, если он есть в бакете."""
    if silo.head(song_key(sid, name)) is None:
        return None
    return f"songs/{sid}/{name}"


def _ensure_waveform(sid: str, title: str) -> None:
    """Пики вокала: считаем один раз на версию vocals.wav (проверка по head)."""
    wav_head = silo.head(song_key(sid, "vocals.wav"))
    if wav_head is None:
        log.warning("%s: нет vocals.wav, waveform недоступен", title)
        return
    wf_head = silo.head(song_key(sid, "waveform.json"))
    if wf_head is not None and wf_head["last_modified"] >= wav_head["last_modified"]:
        return  # уже посчитан для этой версии вокала
    with tempfile.TemporaryDirectory(prefix=f"waveform-{sid}-") as td:
        local = Path(td) / "vocals.wav"
        silo.download(song_key(sid, "vocals.wav"), local)
        peaks, wdur = waveform_peaks(local)
    silo.put_json(song_key(sid, "waveform.json"), {"peaks": peaks, "duration": wdur})


def publish_song(sid: str) -> dict:
    """Одна песня: канон -> опубликованные артефакты в том же префиксе.

    mp3 кодирует GPU-сервис (в бандле) — здесь их отсутствие громко
    падает, а не притворяется успехом.
    """
    meta = read_meta(sid)
    title = meta.get("title", sid)
    if silo.head(song_key(sid, "minus.mp3")) is None:
        raise RuntimeError(f"{title}: нет minus.mp3 — перезапустите обработку песни")

    if silo.head(song_key(sid, "pitch.json")) is None:
        silo.put_json(song_key(sid, "pitch.json"), {"t": [], "midi": []})

    lyr = read_lyrics(sid) or {}
    segments = lyr.get("segments", [])

    original_rel = _rel_if(sid, "original.mp3")
    if original_rel is None:
        log.warning("%s: original.mp3 отсутствует (старый бандл?)", title)
    vocals_rel = _rel_if(sid, "vocals.mp3")
    _ensure_waveform(sid, title)

    catalog.upsert(sid, title=meta.get("title") or sid, language=meta.get("language"),
                   artist=meta.get("artist"),
                   owner_id=(meta.get("owner") or {}).get("id"),
                   owner_name=(meta.get("owner") or {}).get("name"),
                   lines=meta.get("lines") or 0, duration=meta.get("duration") or 0,
                   has_original=original_rel is not None, has_vocals=vocals_rel is not None,
                   source_sha1=(meta.get("source") or {}).get("sha1"),
                   created=meta.get("created"), updated=meta.get("updated"))

    return {
        "id": sid,
        "title": title,
        "audio": f"songs/{sid}/minus.mp3",
        "original": original_rel,
        "vocals": vocals_rel,
        "language": lyr.get("language"),
        "lines": len(segments),
        "duration": meta.get("duration"),
        "artist": meta.get("artist"),
    }


def publish_one(sid: str) -> dict:
    """Публикация одной песни (вызывается из API/воркера)."""
    return publish_song(sid)


def select_sids(only: str | None) -> list[str]:
    """id для публикации: все, либо один (--only по id или по названию трека)."""
    sids = all_ids()
    if not only:
        return sids
    hit = [s for s in sids if s == only]
    if not hit:
        hit = [s for s in sids if read_meta(s).get("title") == only]
    return hit
