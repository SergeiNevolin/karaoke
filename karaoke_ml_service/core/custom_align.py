"""
Правка распознанных слов приложенным текстом. Тайминги — идеал, не трогаем.

Семантика (строго):
- тайминги слов Whisper (после WordAligner) считаются точными и копируются
  как есть: ни одна граница s/e распознанного слова не пересчитывается,
  не сдвигается и не интерполируется (все числа s/e в выходе — verbatim
  из слов Whisper);
- приложенный текст — канон СЛОВ: глобальное монотонное выравнивание
  подменяет написания, сохраняя тайминги носителей.

Как маппим:
- 1:1 (точное или нечёткое совпадение по символам) — слово пользователя
  с (s, e, p) слова Whisper;
- расщепление (1 слово Whisper на N слов пользователя, «незнаю» ->
  «не знаю»): все делят полный интервал (s, e) — одновременно подсвечены
  весь интервал, соседние метки не едут;
- слияние (N слов Whisper в 1 слово пользователя): слово пользователя
  покрывает спан (s первого, e последнего);
- вставка без пары — делит полный интервал (s, e) якоря (следующего слова
  Whisper, хвост — последнего): подсвечивается вместе с якорем, соседние
  метки не едут; слов нулевой длительности не вставляем;
- слово Whisper без пары — остаётся как распознано (покрытие), кроме
  пунктуации и осколков (<=2 букв, приклеенных к соседнему слову), —
  они поглощаются; а также кроме заменённых (см. ниже).

Выравнивание — полный DP с переходами 1:1 / 1:N / N:1 (N<=3) по
нормализованным словам, схожесть — посимвольная (конкатенации для
слияний/расщеплений). Монотонно, глобально оптимально; повторы припевов
ложатся на свои места порядком, а не похожестью. Подстановка 1:1 разрешена
при схожести >= 0.5, слияния — при >= 0.95 со штрафом (точные пары всегда
дешевле). Сегменты на выходе — строки пользователя с построчным confidence
(+ сегменты-хвосты из непокрытых слов Whisper, длинные режутся по паузам).
Чистая функция без моделей и аудио.
"""
from __future__ import annotations

import difflib
import logging

from .lyrics import norm


def _clamp_words(words: list[dict], lo: float, hi: float) -> list[dict]:
    """Только кламп в границы строки, без сдвига starts.

    В отличие от normalize_words (требует s >= prev_e и двигает shared-
    интервалы/точки), здесь порядок уже монотонен по построению, а shared-
    интервалы расщеплений и точки вставок обязаны уцелеть как есть.
    """
    out = []
    for w in words:
        s = round(max(lo, min(float(w["s"]), hi)), 3)
        e = round(max(lo, min(float(w["e"]), hi)), 3)
        out.append({**w, "s": s, "e": max(e, s)})
    return out

log = logging.getLogger(__name__)

#: схожесть 1:1 ниже — подстановка запрещена, только пропуски
FUZZY_MIN_RATIO = 0.5
#: схожесть конкатенации ниже — слияние/расщепление запрещено.
#: Порог почти точный (0.95): настоящие сплиты конкатенируются ровно (1.0),
#: а «похожее, но другое» («стобой» vs «собой» — 0.909) идёт честным путём
#: 1:1 + пропуски с сохранением покрытия, а не склейкой
MERGE_MIN_RATIO = 0.95
#: штраф слияния: точные пары 1:1 всегда дешевле
MERGE_PENALTY = 0.2
#: максимум слов в слиянии/расщеплении с одной стороны
MAX_MERGE = 3
#: цена пропуска слова с любой стороны
GAP_COST = 1.0
#: пауза между словами кипера, режущая хвост на сегменты (сек)
BREATH_GAP = 1.0
#: уверенность слов: точная пара / общий интервал / точка-вставка
CONF_MATCH = 1.0
CONF_MERGE = 0.9
CONF_POINT = 0.3
#: строка с conf ниже — на ручную проверку в Editor
LOW_LINE_CONF = 0.6
#: дегенерат VAD-сетки: столько слов с одинаковой длительностью (+- допуск)
DEGRADED_GRID_TOL = 0.005
DEGRADED_MIN_WORDS = 5
#: дегенерат схлопывания: столько секунд покрыто не более чем сегментами
DEGRADED_LONG_SPAN = 60.0
DEGRADED_MAX_SEGS = 2
#: минимальная длительность сегмента (сек). Бэкенд требует end > start строго
#: (karaoke_api/store/songs.py:109), а строка из одних точек-вставок даёт
#: start == end: тогда двигаем ТОЛЬКО границу сегмента, тайминги слов целы
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


def _is_fragment(frag: str, left: str, right: str) -> bool:
    """Осколок расщепления (<=2 букв, приклеен к соседнему слову): поглотить."""
    if not frag or len(frag) > 2:
        return False
    return left.endswith(frag) or right.startswith(frag)


def _overlaps(a_s: float, a_e: float, b_s: float, b_e: float, eps: float = 0.05) -> bool:
    return min(a_e, b_e) - max(a_s, b_s) > eps


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
    """Приложенный текст -> сегменты-строки с замороженными таймингами.

    Возвращает (сегменты, статистика). Тайминги s/e берутся только из слов
    Whisper и копируются побайтово; новых чисел с плавающей точкой нет.
    Строки пользователя несут построчный "conf" (1.0 — точные пары,
    ниже — на проверку в Editor).
    """
    wsegs: list[dict] = whisper_data.get("segments", []) or []
    if not lines:
        return wsegs, {"applied": False, "mode": "correct"}
    flat: list[tuple[int, dict]] = []
    for si, seg in enumerate(wsegs):
        for w in seg.get("words", []) or []:
            flat.append((si, w))
    if not flat:
        n_u = sum(len(line.split()) for line in lines)
        return _even_all(lines), {"applied": True, "mode": "correct-even",
                                  "matched": 0, "corrected": 0, "inserted": 0,
                                  "kept": 0, "total_w": 0, "total_u": n_u,
                                  "dp_cost": 0.0, "point_share": 0.0,
                                  "keeper_share": 0.0, "keeper_overlap": 0.0,
                                  "mean_line_conf": 0.0,
                                  "low_conf_lines": len(lines),
                                  "degraded": False, "segments": 0,
                                  "lines": len(lines), "result": len(lines)}
    uwords: list[tuple[str, str, int]] = []  # (показ, норма, строка)
    for li, line in enumerate(lines):
        for t in line.split():
            uwords.append((t, norm(t), li))

    wnorm = [norm(str(w.get("w", ""))) for _, w in flat]
    unorm = [u[1] for u in uwords]
    ops, dp_total = _align_words_ex(wnorm, unorm)
    degraded = _is_degraded(wsegs, flat)
    if degraded:
        log.warning("подозрительный вход: механическая сетка или схлопывание "
                    "сегментов — проверить в Editor")

    # пары для правила осколков: ближайшее пользовательское слово слева/справа
    w2u: list[int | None] = [None] * len(flat)
    for op in ops:
        if op[0] == "m":
            w2u[op[1]] = op[2]
        elif op[0] == "merge":
            w2u[op[1]] = op[2][0]
        elif op[0] == "join":
            for ii in op[1]:
                w2u[ii] = op[2]

    def neighbor_norms(i: int) -> tuple[str, str]:
        left, right = "", ""
        for k in range(i - 1, -1, -1):
            if w2u[k] is not None:
                left = unorm[w2u[k]]
                break
        for k in range(i + 1, len(flat)):
            if w2u[k] is not None:
                right = unorm[w2u[k]]
                break
        return left, right

    line_words: dict[int, list[dict]] = {li: [] for li in range(len(lines))}
    line_ac: dict[int, list[float]] = {li: [] for li in range(len(lines))}
    keepers: dict[int, list[dict]] = {}
    matched = corrected = inserted = kept = dropped = replaced = n_full = n_points = 0
    pending: list[int] = []  # вставки без якоря — сядут на следующее слово Whisper

    def anchor_timing(idx: int) -> tuple[float, float, float | None]:
        _, w = flat[idx]
        s, e = float(w.get("s", 0.0)), float(w.get("e", 0.0))
        p = w.get("p")
        return s, e, (float(p) if p is not None else None)

    def emit_user(uj: int, s: float, e: float, p: float | None,
                  anchor_w: str, ac: float) -> None:
        nonlocal corrected, n_full, n_points
        disp = uwords[uj][0]
        wd: dict = {"w": disp, "s": s, "e": e}
        if p is not None:
            wd["p"] = p
        if disp != anchor_w:
            wd["corrected"] = True
            corrected += 1
        line_words[uwords[uj][2]].append(wd)
        line_ac[uwords[uj][2]].append(ac)
        if s == e:
            n_points += 1
        else:
            n_full += 1

    # заменённые киперы: пара d(i)+i(j) в ops — DP отверг подстановку как
    # непохожую, но пользователь поставил слово ровно в этот слот И рядом
    # (<=2 ops) есть согласованная пара: слово заменили, а не пропустили.
    # Без согласованного соседства (хвост unrelated-текста, пустой трек) —
    # покрытие сохраняем.
    m_pos = [k for k, op in enumerate(ops) if op[0] in ("m", "merge", "join")]
    replaced_idx: set[int] = set()
    for k, op in enumerate(ops):
        if op[0] == "d":
            prev_ins = k > 0 and ops[k - 1][0] == "i"
            next_ins = k + 1 < len(ops) and ops[k + 1][0] == "i"
            if (prev_ins or next_ins) and any(abs(k - p) <= 2 for p in m_pos):
                replaced_idx.add(op[1])

    for op in ops:
        if op[0] == "m":
            _, i, j = op
            s, e, p = anchor_timing(i)
            for uj in pending:
                # вставка делит полный интервал якоря: подсвечена вместе с ним
                emit_user(uj, s, e, p, str(flat[i][1].get("w", "")), CONF_POINT)
                inserted += 1
            pending = []
            emit_user(j, s, e, p, str(flat[i][1].get("w", "")), CONF_MATCH)
            matched += 1
        elif op[0] == "merge":
            _, i, js = op
            s, e, p = anchor_timing(i)
            anchor_w = str(flat[i][1].get("w", ""))
            for uj in pending:
                emit_user(uj, s, e, p, anchor_w, CONF_POINT)
                inserted += 1
            pending = []
            # расщепление: все куски делят полный интервал — подсвечены вместе
            for uj in js:
                emit_user(uj, s, e, p, anchor_w, CONF_MERGE)
            matched += 1
        elif op[0] == "join":
            _, iis, j = op
            s0, _, p = anchor_timing(iis[0])
            e1 = float(flat[iis[-1]][1].get("e", s0))
            anchor_w = " ".join(str(flat[ii][1].get("w", "")) for ii in iis)
            for uj in pending:
                emit_user(uj, s0, e1, p, anchor_w, CONF_POINT)
                inserted += 1
            pending = []
            # слияние: спан от начала первого до конца последнего — числа те же
            emit_user(j, s0, e1, p, anchor_w, CONF_MERGE)
            matched += 1
        elif op[0] == "d":
            _, i = op
            frag = wnorm[i]
            if not frag:
                dropped += 1  # пунктуация без пары — не контент
                continue
            if i in replaced_idx:
                replaced += 1
                dropped += 1
                continue
            left, right = neighbor_norms(i)
            if _is_fragment(frag, left, right):
                dropped += 1
                continue
            si, w = flat[i]
            keepers.setdefault(si, []).append(dict(w))
            kept += 1
        else:
            pending.append(op[1])
    if pending:
        # хвост без якоря справа — делят интервал последнего слова Whisper
        s, e, p = anchor_timing(len(flat) - 1)
        anchor_w = str(flat[-1][1].get("w", ""))
        for uj in pending:
            emit_user(uj, s, e, p, anchor_w, CONF_POINT)
            inserted += 1

    out: list[dict] = []
    line_confs: list[float] = []
    for li, line in enumerate(lines):
        words = line_words[li]
        if not words:
            continue
        lo = min(float(w["s"]) for w in words)
        hi = max(float(w["e"]) for w in words)
        words = _clamp_words(words, lo, hi)
        conf = round(sum(line_ac[li]) / len(line_ac[li]), 3)
        line_confs.append(conf)
        seg_s, seg_e = _seg_bounds(words)
        out.append({"start": seg_s, "end": seg_e,
                    "text": line, "words": words, "conf": conf})
    user_spans = [(float(s["start"]), float(s["end"])) for s in out]
    n_overlap = 0
    n_keeper_words = 0
    for si in sorted(keepers):
        # breath-split: длинные хвосты режем по максимальной паузе —
        # только переупаковка, числа те же
        groups: list[list[dict]] = [[]]
        for w in keepers[si]:
            if groups[-1]:
                gap = float(w["s"]) - float(groups[-1][-1]["e"])
                if gap >= BREATH_GAP:
                    groups.append([])
            groups[-1].append(w)
        for words in groups:
            for w in words:
                n_keeper_words += 1
                if any(_overlaps(float(w["s"]), float(w["e"]), a, b)
                       for a, b in user_spans):
                    n_overlap += 1
            seg_s, seg_e = _seg_bounds(words)
            out.append({"start": seg_s, "end": seg_e,
                        "text": " ".join(str(w.get("w", "")) for w in words),
                        "words": [dict(w) for w in words]})
    out.sort(key=lambda s: (float(s["start"]), float(s["end"])))
    total_u = sum(1 for _ in uwords)
    stats = {"applied": True, "mode": "correct", "matched": matched,
             "corrected": corrected, "inserted": inserted, "kept": kept,
             "dropped": dropped, "replaced": replaced, "total_w": len(flat), "total_u": total_u,
             "dp_cost": round(dp_total / max(1, len(flat) + total_u), 3),
             "point_share": round(n_points / max(1, n_full + n_points), 3),
             "keeper_share": round(kept / max(1, len(flat)), 3),
             "keeper_overlap": round(n_overlap / max(1, n_keeper_words), 3),
             "mean_line_conf": round(sum(line_confs) / len(line_confs), 3)
             if line_confs else 0.0,
             "low_conf_lines": sum(1 for c in line_confs if c < LOW_LINE_CONF),
             "degraded": degraded, "segments": len(wsegs),
             "lines": len(lines), "result": len(out)}
    log.info("правка слов: %s", stats)
    return out, stats


def _seg_bounds(words: list[dict]) -> tuple[float, float]:
    """Границы сегмента по словам с гарантией end > start.

    Строка из одних точек-вставок даёт start == end — такое бэкенд
    отвергает как битый сегмент; двигаем только границу сегмента.
    """
    s = min(float(w["s"]) for w in words)
    e = max(float(w["e"]) for w in words)
    if e <= s:
        e = round(s + MIN_SEG_DUR, 3)
    return s, e


def _even_all(lines: list[str]) -> list[dict]:
    """Слов Whisper нет вообще — равномерная раскладка лентой (честный fallback)."""
    from .align import r3
    from .lyrics import even_words
    out: list[dict] = []
    t = 0.0
    for line in lines:
        toks = line.split() or ["…"]
        e = t + max(1.0, len(toks) * 0.5)
        words = [{"w": w["w"], "s": w["s"], "e": w["e"]}
                 for w in even_words(line, t, e)]
        out.append({"start": r3(t), "end": r3(e), "text": line,
                    "words": words, "conf": 0.0})
    return out
