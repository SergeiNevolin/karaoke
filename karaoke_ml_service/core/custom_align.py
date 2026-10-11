"""
Правка распознанных слов приложенным текстом. Тайминги — идеал, не трогаем.

Семантика (строго):
- выход повторяет структуру Whisper: те же сегменты в том же порядке,
  те же слова с теми же s/e (все числа — verbatim из слов Whisper, новых нет);
- приложенный текст — канон СЛОВ: глобальное монотонное выравнивание
  подменяет написания слов на пользовательские;
- слово пользователя без пары в распознанном в выход НЕ попадает
  (выдуманный тайминг портит караоке хуже пропущенного слова);
- слово Whisper без пары остаётся как распознано.

Как маппим:
- 1:1 (точное или нечёткое совпадение по символам) — текст пользователя
  с (s, e, p) слова Whisper;
- расщепление (1 слово Whisper на N слов пользователя, «незнаю» ->
  «не знаю»): все делят полный интервал (s, e);
- слияние (N слов Whisper в 1 слово пользователя): слово пользователя
  покрывает спан (s первого, e последнего).

Выравнивание — полный DP с переходами 1:1 / 1:N / N:1 (N<=3) по
нормализованным словам, схожесть — посимвольная. Монотонно, глобально
оптимально; повторы припевов ложатся на свои места порядком, а не
похожестью. Подстановка 1:1 разрешена при схожести >= 0.5, слияния —
при >= 0.95 со штрафом (точные пары всегда дешевле).
Чистая функция без моделей и аудио.
"""
from __future__ import annotations

import difflib
import logging

from .lyrics import norm

log = logging.getLogger(__name__)

#: схожесть 1:1 ниже — подстановка запрещена, только пропуски
FUZZY_MIN_RATIO = 0.5
#: схожесть конкатенации ниже — слияние/расщепление запрещено.
#: Порог почти точный (0.95): настоящие сплиты конкатенируются ровно (1.0),
#: а «похожее, но другое» («стобой» vs «собой» — 0.909) идёт путём
#: 1:1 + пропуски с сохранением покрытия, а не склейкой
MERGE_MIN_RATIO = 0.95
#: штраф слияния: точные пары 1:1 всегда дешевле
MERGE_PENALTY = 0.2
#: максимум слов в слиянии/расщеплении с одной стороны
MAX_MERGE = 3
#: цена пропуска слова с любой стороны
GAP_COST = 1.0
#: уверенность слов: точная пара / общий интервал
CONF_MATCH = 1.0
CONF_MERGE = 0.9
#: сегмент с conf ниже — на ручную проверку в Editor
LOW_SEG_CONF = 0.6
#: дегенерат VAD-сетки: столько слов с одинаковой длительностью (+- допуск)
DEGRADED_GRID_TOL = 0.005
DEGRADED_MIN_WORDS = 5
#: дегенерат схлопывания: столько секунд покрыто не более чем сегментами
DEGRADED_LONG_SPAN = 60.0
DEGRADED_MAX_SEGS = 2
#: минимальная длительность сегмента (сек). Бэкенд требует end > start строго
#: (karaoke_api/store/songs.py:109); страховка на случай вырожденного входа
MIN_SEG_DUR = 0.03


def _char_ratio(a: str, b: str) -> float:
    """Посимвольная схожесть нормализованных строк (обе непустые)."""
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def _sub_cost(a: str, b: str) -> float:
    """Цена подстановки 1:1: 0 — совпали, inf — запрещена."""
    if a == b:
        return 0.0
    if not a or not b:
        return float("inf")
    r = _char_ratio(a, b)
    if r < FUZZY_MIN_RATIO:
        return float("inf")
    return 1.0 - r


def _merge_cost(concat: str, target: str) -> float:
    """Цена слияния/расщепления: конкатенация против одиночки."""
    if not concat or not target:
        return float("inf")
    r = _char_ratio(concat, target)
    if r < MERGE_MIN_RATIO:
        return float("inf")
    return (1.0 - r) + MERGE_PENALTY


def _align_words_ex(wnorm: list[str], unorm: list[str]) -> tuple[list[tuple], float]:
    """Глобальный DP с переходами 1:1 / 1:N / N:1. Возвращает (ops, цена).

    Ops: [('m', i, j) | ('merge', i, [j..]) | ('join', [i..], j)
    | ('d', i) | ('i', j)], монотонно. Ничьи — в пользу подстановки 1:1,
    затем меньших слияний, затем сохранения слова Whisper.
    """
    m, n = len(wnorm), len(unorm)
    INF = float("inf")
    dp = [[0.0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1):
        dp[i][0] = i * GAP_COST
    for j in range(1, n + 1):
        dp[0][j] = j * GAP_COST
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            sub = _sub_cost(wnorm[i - 1], unorm[j - 1])
            best = min(dp[i - 1][j] + GAP_COST, dp[i][j - 1] + GAP_COST)
            if sub != INF:
                best = min(best, dp[i - 1][j - 1] + sub)
            for k in range(2, MAX_MERGE + 1):
                if j >= k:
                    c = _merge_cost("".join(unorm[j - k:j]), wnorm[i - 1])
                    if c != INF:
                        best = min(best, dp[i - 1][j - k] + c)
                if i >= k:
                    c = _merge_cost("".join(wnorm[i - k:i]), unorm[j - 1])
                    if c != INF:
                        best = min(best, dp[i - k][j - 1] + c)
            dp[i][j] = best
    ops: list[tuple] = []
    i, j = m, n
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            sub = _sub_cost(wnorm[i - 1], unorm[j - 1])
            if sub != INF and dp[i][j] == dp[i - 1][j - 1] + sub:
                ops.append(("m", i - 1, j - 1))
                i -= 1
                j -= 1
                continue
            for k in range(2, MAX_MERGE + 1):
                if j >= k:
                    c = _merge_cost("".join(unorm[j - k:j]), wnorm[i - 1])
                    if c != INF and dp[i][j] == dp[i - 1][j - k] + c:
                        ops.append(("merge", i - 1, list(range(j - k, j))))
                        i -= 1
                        j -= k
                        break
            else:
                for k in range(2, MAX_MERGE + 1):
                    if i >= k:
                        c = _merge_cost("".join(wnorm[i - k:i]), unorm[j - 1])
                        if c != INF and dp[i][j] == dp[i - k][j - 1] + c:
                            ops.append(("join", list(range(i - k, i)), j - 1))
                            i -= k
                            j -= 1
                            break
                else:
                    if i > 0 and (j == 0 or dp[i][j] == dp[i - 1][j] + GAP_COST):
                        ops.append(("d", i - 1))
                        i -= 1
                    else:
                        ops.append(("i", j - 1))
                        j -= 1
                continue
            continue
        if i > 0 and (j == 0 or dp[i][j] == dp[i - 1][j] + GAP_COST):
            ops.append(("d", i - 1))
            i -= 1
        else:
            ops.append(("i", j - 1))
            j -= 1
    ops.reverse()
    return ops, dp[m][n]


def _align_words(wnorm: list[str], unorm: list[str]) -> list[tuple]:
    """Глобальный DP: [('m', i, j) | ('merge', i, [j..]) | ('join', [i..], j)
    | ('d', i) | ('i', j)], монотонно. Ничьи — в пользу подстановки 1:1."""
    ops, _ = _align_words_ex(wnorm, unorm)
    return ops


def _clamp_words(words: list[dict], lo: float, hi: float) -> list[dict]:
    """Только кламп в границы, без сдвига starts.

    Порядок уже монотонен по построению, а shared-интервалы расщеплений
    обязаны уцелеть как есть (normalize_words требовал бы s >= prev_e
    и раздвигал бы их).
    """
    out = []
    for w in words:
        s = round(max(lo, min(float(w["s"]), hi)), 3)
        e = round(max(lo, min(float(w["e"]), hi)), 3)
        out.append({**w, "s": s, "e": max(e, s)})
    return out


def _seg_bounds(words: list[dict]) -> tuple[float, float]:
    """Границы сегмента по словам с гарантией end > start (требует бэкенд)."""
    s = min(float(w["s"]) for w in words)
    e = max(float(w["e"]) for w in words)
    if e <= s:
        e = round(s + MIN_SEG_DUR, 3)
    return s, e


def _is_degraded(wsegs: list[dict], flat: list[tuple[int, dict]]) -> bool:
    """Дегенерат входа: механическая сетка длительностей или схлопывание
    VAD (пара сегментов на минуты аудио). Такому выходу нельзя верить."""
    if len(flat) >= DEGRADED_MIN_WORDS:
        durs = [float(w.get("e", 0.0)) - float(w.get("s", 0.0)) for _, w in flat]
        if max(durs) - min(durs) <= DEGRADED_GRID_TOL:
            return True
    span = max((float(w.get("e", 0.0)) for _, w in flat), default=0.0)
    return span > DEGRADED_LONG_SPAN and len(wsegs) <= DEGRADED_MAX_SEGS


def align_custom_text(whisper_data: dict, lines: list[str]) -> tuple[list[dict], dict]:
    """Приложенный текст -> правка слов на месте с замороженными таймингами.

    Возвращает (сегменты, статистика). Структура, порядок и тайминги s/e —
    из Whisper как есть; меняется только текст слов, сопоставленных со
    словами пользователя. Слова пользователя без пары опускаются, слова
    Whisper без пары остаются как распознаны.
    """
    wsegs: list[dict] = whisper_data.get("segments", []) or []
    if not lines:
        return wsegs, {"applied": False, "mode": "correct"}
    flat: list[tuple[int, dict]] = []
    for si, seg in enumerate(wsegs):
        for w in seg.get("words", []) or []:
            flat.append((si, w))
    if not flat:
        return wsegs, {"applied": False, "mode": "correct"}
    uwords: list[tuple[str, str]] = []  # (показ, норма)
    for line in lines:
        for t in line.split():
            uwords.append((t, norm(t)))

    wnorm = [norm(str(w.get("w", ""))) for _, w in flat]
    unorm = [u[1] for u in uwords]
    ops, dp_total = _align_words_ex(wnorm, unorm)
    degraded = _is_degraded(wsegs, flat)
    if degraded:
        log.warning("подозрительный вход: механическая сетка или схлопывание "
                    "сегментов — проверить в Editor")

    seg_words: dict[int, list[dict]] = {si: [] for si in range(len(wsegs))}
    seg_ac: dict[int, list[float]] = {si: [] for si in range(len(wsegs))}
    matched = corrected = skipped = kept = n_full = n_points = 0

    def anchor_timing(idx: int) -> tuple[float, float, float | None]:
        _, w = flat[idx]
        s, e = float(w.get("s", 0.0)), float(w.get("e", 0.0))
        p = w.get("p")
        return s, e, (float(p) if p is not None else None)

    def emit(si: int, disp: str, s: float, e: float, p: float | None,
             anchor_w: str, ac: float) -> None:
        nonlocal corrected, n_full, n_points
        wd: dict = {"w": disp, "s": s, "e": e}
        if p is not None:
            wd["p"] = p
        if disp != anchor_w:
            wd["corrected"] = True
            corrected += 1
        seg_words[si].append(wd)
        seg_ac[si].append(ac)
        if s == e:
            n_points += 1
        else:
            n_full += 1

    for op in ops:
        if op[0] == "m":
            _, i, j = op
            si, _ = flat[i]
            s, e, p = anchor_timing(i)
            emit(si, uwords[j][0], s, e, p,
                 str(flat[i][1].get("w", "")), CONF_MATCH)
            matched += 1
        elif op[0] == "merge":
            _, i, js = op
            si, _ = flat[i]
            s, e, p = anchor_timing(i)
            anchor_w = str(flat[i][1].get("w", ""))
            # расщепление: все куски делят полный интервал — подсвечены вместе
            for uj in js:
                emit(si, uwords[uj][0], s, e, p, anchor_w, CONF_MERGE)
            matched += 1
        elif op[0] == "join":
            _, iis, j = op
            si, _ = flat[iis[0]]
            s0, _, p = anchor_timing(iis[0])
            e1 = float(flat[iis[-1]][1].get("e", s0))
            anchor_w = " ".join(str(flat[ii][1].get("w", "")) for ii in iis)
            # слияние: спан от начала первого до конца последнего — числа те же
            emit(si, uwords[j][0], s0, e1, p, anchor_w, CONF_MERGE)
            matched += 1
        elif op[0] == "d":
            _, i = op
            si, w = flat[i]
            seg_words[si].append(dict(w))
            # кипер — слово как распознано: уверенность — p whisper, иначе нейтрально
            pw = w.get("p")
            seg_ac[si].append(float(pw) if pw is not None else 0.5)
            kept += 1
        else:
            skipped += 1  # слова без распознанной пары не выводим вообще

    out: list[dict] = []
    seg_confs: list[float] = []
    for si, seg in enumerate(wsegs):
        words = seg_words[si]
        if not words:
            continue
        lo = min(float(w["s"]) for w in words)
        hi = max(float(w["e"]) for w in words)
        words = _clamp_words(words, lo, hi)
        conf = round(sum(seg_ac[si]) / len(seg_ac[si]), 3)
        seg_confs.append(conf)
        seg_s, seg_e = _seg_bounds(words)
        text = " ".join(w["w"] for w in words)
        out.append({**seg, "start": seg_s, "end": seg_e,
                    "text": text, "words": words, "conf": conf})
    total_u = len(uwords)
    stats = {"applied": True, "mode": "correct", "matched": matched,
             "corrected": corrected, "skipped": skipped, "kept": kept,
             "total_w": len(flat), "total_u": total_u,
             "dp_cost": round(dp_total / max(1, len(flat) + total_u), 3),
             "point_share": round(n_points / max(1, n_full + n_points), 3),
             "mean_seg_conf": round(sum(seg_confs) / len(seg_confs), 3)
             if seg_confs else 0.0,
             "low_conf_segments": sum(1 for c in seg_confs if c < LOW_SEG_CONF),
             "degraded": degraded, "segments": len(wsegs),
             "lines": len(lines), "result": len(out)}
    log.info("правка слов: %s", stats)
    return out, stats
