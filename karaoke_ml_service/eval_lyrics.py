"""
Оценка таймингов слов: hypothesis lyrics.json vs gold lyrics.json.

Gold — выверенные вручную тайминги (Editor/WordTimeline): формат как lyrics.json
бандла: {"segments": [{"text": ..., "words": [{"w": ..., "s": ..., "e": ...}]}]}.
Слова стыкуются по тексту (difflib, только stdlib — скрипт работает везде),
считаются расхождения начал слов.

Запуск:
  python -m karaoke_ml_service.eval_lyrics --gold gold.json --hyp hyp.json
  python -m karaoke_ml_service.eval_lyrics --gold gold.json --hyp v1.json --hyp v2.json
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import statistics
import sys
from pathlib import Path


def _norm(w: str) -> str:
    s = (w or "").lower().replace("ё", "е")
    s = re.sub(r"[^\w\s]", "", s, flags=re.UNICODE)
    return re.sub(r"\s+", " ", s).strip()


def _flat(doc: dict) -> list[tuple[str, float]]:
    out = []
    for seg in doc.get("segments", []) or []:
        for w in seg.get("words", []) or []:
            out.append((_norm(str(w.get("w", ""))), float(w.get("s", 0.0))))
    return out


def score(hyp: dict, gold: dict) -> dict:
    """{coverage, n, median_abs_s, p95_abs_s, frac_over_200ms, mean_signed_s}."""
    g = _flat(gold)
    h = _flat(hyp)
    if not g:
        return {"coverage": 0.0, "n": 0, "median_abs_s": 0.0,
                "p95_abs_s": 0.0, "frac_over_200ms": 0.0, "mean_signed_s": 0.0}
    sm = difflib.SequenceMatcher(None, [w for w, _ in g], [w for w, _ in h],
                                 autojunk=False)
    deltas: list[float] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for gi, hi in zip(range(i1, i2), range(j1, j2), strict=True):
                deltas.append(h[hi][1] - g[gi][1])
    if not deltas:
        return {"coverage": 0.0, "n": len(g), "median_abs_s": 99.0,
                "p95_abs_s": 99.0, "frac_over_200ms": 1.0, "mean_signed_s": 0.0}
    absd = sorted(abs(d) for d in deltas)
    p95 = absd[min(len(absd) - 1, int(len(absd) * 0.95))]
    return {"coverage": round(len(deltas) / len(g), 4), "n": len(g),
            "median_abs_s": round(statistics.median(absd), 3),
            "p95_abs_s": round(p95, 3),
            "frac_over_200ms": round(sum(1 for d in absd if d > 0.2) / len(absd), 4),
            "mean_signed_s": round(sum(deltas) / len(deltas), 3)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Оценка таймингов слов vs gold")
    ap.add_argument("--gold", required=True, help="gold lyrics.json")
    ap.add_argument("--hyp", action="append", required=True, dest="hyps",
                    help="hypothesis lyrics.json (можно несколько)")
    args = ap.parse_args(argv)
    gold = json.loads(Path(args.gold).read_text(encoding="utf-8"))
    report = {}
    for hpath in args.hyps:
        hyp = json.loads(Path(hpath).read_text(encoding="utf-8"))
        report[hpath] = score(hyp, gold)
    json.dump(report, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
