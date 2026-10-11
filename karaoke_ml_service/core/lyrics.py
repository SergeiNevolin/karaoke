"""
Текстовые и временные примитивы для текстов песен (сторона GPU-сервиса).

Только чистые функции без моделей: нормализация строк, чистка строк,
равномерная раскладка слов, выпрямление границ. Само наложение
приложенного текста — audio-first, см. `custom_align.align_custom_text`
(текст к тексту через тайминги Whisper признан негодным и удалён:
сегменты Whisper — не строки песни, а word_timestamps местами
деградируют до механической равномерной сетки).
"""
from __future__ import annotations

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
