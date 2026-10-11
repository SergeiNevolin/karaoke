"""eval_lyrics: скоринг гипотез против gold (stdlib, без моделей)."""
from __future__ import annotations

import json
from pathlib import Path

from karaoke_ml_service.eval_lyrics import score

GOLD = json.loads((Path(__file__).parent / "gold_sample.json").read_text(encoding="utf-8"))


def test_identical_scores_zero():
    r = score(GOLD, GOLD)
    assert r["coverage"] == 1.0 and r["n"] == 4
    assert r["median_abs_s"] == 0.0 and r["frac_over_200ms"] == 0.0


def test_systematic_early_shift_detected():
    hyp = json.loads(json.dumps(GOLD))
    for seg in hyp["segments"]:
        for w in seg["words"]:
            w["s"] = round(w["s"] - 0.15, 3)
    r = score(hyp, GOLD)
    assert r["coverage"] == 1.0
    assert r["median_abs_s"] == 0.15, r  # та самая «спешка Whisper» видна
    assert r["mean_signed_s"] == -0.15, r
    assert r["frac_over_200ms"] == 0.0


def test_missing_word_kills_coverage_not_timing():
    hyp = json.loads(json.dumps(GOLD))
    hyp["segments"][1]["words"] = hyp["segments"][1]["words"][:1]
    hyp["segments"][1]["text"] = "три"
    r = score(hyp, GOLD)
    assert r["coverage"] == 0.75, r
    assert r["median_abs_s"] == 0.0
