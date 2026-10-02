"""
Наложение пользовательского текста на тайминги Whisper (сторона GPU-сервиса).

Проблема: число строк вставленного текста обычно НЕ совпадает с числом
сегментов Whisper (пропуски, склейки). Поэтому делаем глобальное выравнивание
(DP, монотонно, оптимально): каждый сегмент встаёт на самую похожую строку,
совпавшие токены наследуют точные тайминги Whisper; пропущенные строки
вставляются в паузы, несопоставленное оставляем, дубли-тени давим.
"""
from __future__ import annotations

import difflib
import json
import re
from pathlib import Path


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


def _whisper_tokens(seg: dict) -> list[dict]:
    """Токены whisper-слов с таймингами (склеенные делят интервал равномерно)."""
    out = []
    for w in seg.get("words", []) or []:
        toks = str(w.get("w", "")).split()
        s, e = float(w.get("s", 0)), float(w.get("e", 0))
        for k, t in enumerate(toks):
            out.append({
                "w": t,
                "s": round(s + (e - s) * k / len(toks), 3),
                "e": round(s + (e - s) * (k + 1) / len(toks), 3),
            })
    return out


def transfer_words(seg: dict, text: str) -> list[dict]:
    """Перенести тайминги whisper на слова custom-строки.

    Совпавшие токены (LCS) наследуют точные тайминги; почти совпавшие
    (опечатки, ratio >= 0.75) — тоже; остальные интерполируются
    между соседними якорями.
    """
    tokens = text.split()
    if not tokens:
        return []
    seg_s, seg_e = float(seg.get("start", 0)), float(seg.get("end", 0))
    wt = _whisper_tokens(seg)
    if not wt:
        return even_words(text, seg_s, seg_e)
    na = [norm(t["w"]) for t in wt]
    nb = [norm(t) for t in tokens]
    sm = difflib.SequenceMatcher(None, na, nb, autojunk=False)
    anchored = [-1] * len(tokens)
    used_w = [False] * len(wt)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for wi, ci in zip(range(i1, i2), range(j1, j2), strict=False):
                if anchored[ci] == -1:
                    anchored[ci] = wi
                    used_w[wi] = True
    # второй проход: нечёткие якоря для опечаток — строго внутри зазоров
    # между LCS-якорями, чтобы не ломать порядок
    k = 0
    while k < len(tokens):
        if anchored[k] >= 0:
            k += 1
            continue
        r = k
        while r < len(tokens) and anchored[r] < 0:
            r += 1
        lo_wi = anchored[k - 1] if k > 0 else -1
        hi_wi = anchored[r] if r < len(tokens) else len(wt)
        prev = lo_wi
        for ci in range(k, r):
            if not nb[ci]:
                continue
            best, bestr = -1, 0.0
            for wi in range(prev + 1, hi_wi):
                if used_w[wi] or not na[wi]:
                    continue
                rr = difflib.SequenceMatcher(None, na[wi], nb[ci], autojunk=False).ratio()
                if rr > bestr:
                    best, bestr = wi, rr
            if bestr >= 0.75:
                anchored[ci] = best
                used_w[best] = True
                prev = best
        k = r
    out: list[dict] = [{} for _ in tokens]
    k = 0
    while k < len(tokens):
        if anchored[k] >= 0:
            w = wt[anchored[k]]
            out[k] = {"w": tokens[k], "s": w["s"], "e": w["e"]}
            k += 1
        else:
            r = k
            while r < len(tokens) and anchored[r] < 0:
                r += 1
            lo = out[k - 1]["e"] if k > 0 else seg_s
            hi = wt[anchored[r]]["s"] if r < len(tokens) else seg_e
            cnt = r - k
            for q in range(cnt):
                out[k + q] = {
                    "w": tokens[k + q],
                    "s": round(lo + (hi - lo) * q / cnt, 3),
                    "e": round(lo + (hi - lo) * (q + 1) / cnt, 3),
                }
            k = r
    # якоря упорядочены — но whisper-слова могли налезать: чистим границы
    return normalize_words(out, seg_s, seg_e)


def _align(snorm: list[str], lnorm: list[str], threshold: float) -> dict[int, int]:
    """Глобальное выравнивание (динамика, монотонно): пары seg -> line."""
    n, m = len(snorm), len(lnorm)
    sim = [[difflib.SequenceMatcher(None, snorm[i], lnorm[k], autojunk=False).ratio()
            if snorm[i] and lnorm[k] else 0.0
            for k in range(m)] for i in range(n)]
    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            s = sim[i - 1][j - 1]
            pair = dp[i - 1][j - 1] + s if s >= threshold else float("-inf")
            dp[i][j] = max(dp[i - 1][j], dp[i][j - 1], pair)
    match: dict[int, int] = {}
    i, j = n, m
    while i > 0 and j > 0:
        s = sim[i - 1][j - 1]
        if s >= threshold and dp[i][j] == dp[i - 1][j - 1] + s:
            match[i - 1] = j - 1
            i -= 1
            j -= 1
        elif dp[i - 1][j] >= dp[i][j - 1]:
            i -= 1
        else:
            j -= 1
    return match


def apply_text_to_segments(segments: list[dict], raw: list[str] | str,
                            threshold: float = 0.45) -> tuple[list[dict], dict]:
    """Возвращает (новые сегменты, статистика).

    Глобальное выравнивание (динамика, монотонно): каждый сегмент встаёт на
    самую похожую строку, жадность не ворует строки у соседей. Совпавшие
    токены наследуют точные тайминги Whisper, остальные интерполируются.
    """
    lines = clean_lines(raw)
    if not lines:
        return segments, {"applied": False}
    snorm = [norm(s.get("text", "")) for s in segments]
    lnorm = [norm(line) for line in lines]
    n, m = len(segments), len(lines)

    match = _align(snorm, lnorm, threshold)
    strict = len(match)
    # второй проход послабее: пограничные пары (0.3), мимо которых строгий прошёл, —
    # иначе они плодят дубли (оригинал + вставленная копия)
    rs = [i for i in range(n) if i not in match]
    rl = [k for k in range(m) if k not in match.values()]
    if rs and rl:
        for a, b in _align([snorm[i] for i in rs], [lnorm[k] for k in rl], 0.3).items():
            match[rs[a]] = rl[b]
    relaxed = len(match) - strict

    def with_text(seg: dict, text: str) -> dict:
        d = dict(seg)
        d["text"] = text
        if norm(text) == norm(seg.get("text", "")):
            return d  # текст тот же — точные word-timings целы
        d["words"] = transfer_words(seg, text)
        return d

    def gap_lines(texts: list[str], gs: float, ge: float,
                  hard_end: float | None = None) -> list[dict]:
        if ge - gs < len(texts) * 0.4:
            ge = gs + len(texts) * 2.0
        if hard_end is not None:
            ge = min(ge, max(gs + 0.1, hard_end))
        out = []
        for idx, t in enumerate(texts):
            s = round(gs + (ge - gs) * idx / len(texts), 3)
            e = round(gs + (ge - gs) * (idx + 1) / len(texts), 3)
            out.append({"start": s, "end": e, "text": t, "words": even_words(t, s, e)})
        return out

    def place(texts: list[str], gs: float, ge: float,
              hard_end: float | None = None) -> list[dict]:
        """Вставить строки паузой и запомнить их спаны для антидубля."""
        g = gap_lines(texts, gs, ge, hard_end)
        for x in g:
            custom_spans.append((float(x["start"]), float(x["end"]), str(x["text"])))
        return g

    out: list[dict] = []
    cursor = 0  # следующая неиспользованная строка
    prev_end = 0.0
    first = True
    kept_pos: list[int] = []  # позиции whisper без пары
    custom_spans: list[tuple[float, float, str]] = []  # всё из custom-текста
    for i, seg in enumerate(segments):
        if i in match:
            k = match[i]
            if k > cursor:  # пропущенные строки -> в паузу перед сегментом
                if first:
                    need = (k - cursor) * 2.0
                    gs = max(0.0, seg["start"] - need)
                    out.extend(place(lines[cursor:k], gs, seg["start"], seg["start"]))
                else:
                    out.extend(place(lines[cursor:k], prev_end, seg["start"], seg["start"]))
            out.append(with_text(seg, lines[k]))
            custom_spans.append((float(seg["start"]), float(seg["end"]), lines[k]))
            cursor = k + 1
            prev_end = seg["end"]
            first = False
        else:
            out.append(dict(seg))  # Whisper без пары — оставляем
            kept_pos.append(len(out) - 1)
            prev_end = seg["end"]
            first = False
    if cursor < m:  # хвост — после последней строки
        out.extend(place(lines[cursor:], prev_end + 0.3, prev_end + 0.3 + (m - cursor) * 2.5))

    # подавление дублей: whisper без пары, почти целиком лежащий внутри
    # custom-строки (матч, пауза или хвост) с похожим текстом, — тень merge
    # (как в poshlaya-molli): в караоке он никогда не показывается
    drop: set[int] = set()
    for p in kept_pos:
        ks = out[p]
        kd = float(ks["end"]) - float(ks["start"])
        if kd <= 0:
            continue
        for ms, me, mt in custom_spans:
            inter = min(float(ks["end"]), me) - max(float(ks["start"]), ms)
            if inter / kd > 0.6:
                r = difflib.SequenceMatcher(
                    None, norm(str(ks.get("text", ""))), norm(mt), autojunk=False).ratio()
                if r >= 0.5:
                    drop.add(p)
                    break
    if drop:
        out = [s for idx, s in enumerate(out) if idx not in drop]

    stats = {"applied": True, "matched": len(match), "relaxed": relaxed,
             "deduped": len(drop),
             "segments": len(segments), "lines": m, "result": len(out)}
    return out, stats


def apply_custom_lyrics(track_dir: str | Path, text: str = "") -> dict:
    """Подменить текст в vocals_lyrics.json трека. Возвращает статистику."""
    track_dir = Path(track_dir)
    p = track_dir / "vocals_lyrics.json"
    data = json.loads(p.read_text(encoding="utf-8"))
    lines = clean_lines(text) if text.strip() else []
    if not lines:
        return {"applied": False}
    new_segs, stats = apply_text_to_segments(data.get("segments", []), lines)
    data["segments"] = new_segs
    p.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return stats
