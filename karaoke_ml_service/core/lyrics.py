"""
Текстовые и временные примитивы для текстов песен (сторона GPU-сервиса).

Только чистые функции без моделей: нормализация строк, чистка строк,
равномерная раскладка слов, выпрямление границ. Само наложение
приложенного текста — правка на месте, см. `custom_align.align_custom_text`
(структура и тайминги — из Whisper, правится только текст слов).
"""
from __future__ import annotations

import math
import re


def norm(s: str) -> str:
    s = s.lower().replace("ё", "е")
    s = re.sub(r"[^\w\s]", "", s, flags=re.UNICODE)
    return re.sub(r"\s+", " ", s).strip()


def clean_lines(raw: list[str] | str) -> list[str]:
    """Синк с karaoke_api/lyrics.py (там — для парсера Genius)."""
    if isinstance(raw, str):
        raw = raw.split("\n")
    out = []
    for line in raw:
        t = line.strip()
        if t and not re.fullmatch(r"\[.*\]", t):
            out.append(t)
    return out


def even_words(text: str, s: float, e: float) -> list[dict]:
    """Равномерно разложить слова текста по интервалу (честный fallback,
    не тайминг: вызыватель обязан перекрыть CTC/onset-уточнением)."""
    tokens = text.split()
    n = len(tokens)
    if n == 0:
        return []
    return [{"w": w, "s": round(s + (e - s) * i / n, 3),
             "e": round(s + (e - s) * (i + 1) / n, 3)}
            for i, w in enumerate(tokens)]


def normalize_words(words: list[dict], seg_s: float, seg_e: float) -> list[dict]:
    """Границы слов в мс: внутри сегмента, монотонно, без инверсий.

    Никого не удаляем и не меняем порядок — только minimal-фиксы.
    Нулевые слова (s == e) оставляем как есть — это точки, а не баг.
    """
    seg_s = round(float(seg_s), 3)
    seg_e = round(float(seg_e), 3)
    out = []
    prev = seg_s
    for w in words or []:
        s = round(max(seg_s, min(float(w.get("s", seg_s)), seg_e)), 3)
        e = round(max(seg_s, min(float(w.get("e", seg_e)), seg_e)), 3)
        s = max(s, prev)
        if e < s:
            e = min(seg_e, round(s + 0.03, 3))
            if e < s:
                e = s
        out.append({**w, "s": s, "e": e})
        prev = e
    return out


#: минимальная длительность сегмента (сек). Бэкенд требует end > start строго
#: (karaoke_api/store/songs.py:109)
MIN_SEG_DUR = 0.03


def sanitize_segments(segments: list[dict]) -> tuple[list[dict], dict]:
    """Гарантия валидности сегментов перед бандлом: end > start, числа конечны.

    Источники дегенератов: схлопывание r3-округления в Whisper ([32.52, 32.52]),
    переписанные алайнером границы, точечные строки. Двигаем ТОЛЬКО границу
    сегмента (+MIN_SEG_DUR), тайминги слов не трогаем; сегменты с нечисловыми
    границами дропаем (иначе уронят всю задачу на публикации).
    Возвращает (сегменты, {"repaired": n, "dropped": m}).
    """
    out: list[dict] = []
    repaired = dropped = 0
    for s in segments or []:
        if not isinstance(s, dict):
            dropped += 1
            continue
        try:
            start = float(s.get("start", float("nan")))
            end = float(s.get("end", float("nan")))
        except (TypeError, ValueError):
            dropped += 1
            continue
        if not (math.isfinite(start) and math.isfinite(end)):
            dropped += 1
            continue
        if end <= start:
            end = round(start + MIN_SEG_DUR, 3)
            repaired += 1
            out.append({**s, "start": start, "end": end})
        else:
            out.append(dict(s))
    return out, {"repaired": repaired, "dropped": dropped}
