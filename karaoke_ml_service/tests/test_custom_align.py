"""Правка слов на месте: структура и тайминги whisper, правится текст."""
from __future__ import annotations

from karaoke_ml_service.core.custom_align import _align_words, align_custom_text


def _seg(text, s, e, words, **kw):
    d = {"start": s, "end": e, "text": text,
         "words": [{"w": w, "s": ws, "e": we, "p": 0.9} for w, ws, we in words]}
    d.update(kw)
    return d


def _base():
    return [
        _seg("раз два", 10.0, 12.0, [("раз", 10.0, 11.0), ("два", 11.0, 12.0)]),
        _seg("три читыре", 14.0, 16.0, [("три", 14.0, 15.0), ("читыре", 15.0, 16.0)]),
    ]


def _data(segs):
    return {"language": "ru", "segments": segs}


def test_exact_match_keeps_everything():
    out, stats = align_custom_text(
        _data(_base()), ["раз два", "три читыре"])
    assert stats["applied"] is True and stats["mode"] == "correct"
    assert stats["corrected"] == 0 and stats["skipped"] == 0
    assert [(s["text"], s["start"], s["end"]) for s in out] == [
        ("раз два", 10.0, 12.0), ("три читыре", 14.0, 16.0)]
    got = [(w["w"], w["s"], w["e"]) for s in out for w in s["words"]]
    assert ("раз", 10.0, 11.0) in got and ("читыре", 15.0, 16.0) in got


def test_typo_corrected_timing_kept():
    out, stats = align_custom_text(
        _data(_base()), ["раз два", "три четыре"])
    words = [w for s in out for w in s["words"]]
    chetyre = next(w for w in words if w["w"] == "четыре")
    assert (chetyre["s"], chetyre["e"]) == (15.0, 16.0)
    assert chetyre.get("corrected") is True
    assert stats["corrected"] == 1


def test_inserted_words_omitted():
    out, stats = align_custom_text(
        _data(_base()), ["раз два", "три очень четыре"])
    words = [w for s in out for w in s["words"]]
    assert all(w["w"] != "очень" for w in words)
    assert stats["skipped"] == 1
    allowed_nums = {10.0, 11.0, 12.0, 14.0, 15.0, 16.0}
    assert {w["s"] for w in words} | {w["e"] for w in words} <= allowed_nums


def test_split_join_keep_numbers():
    out, _ = align_custom_text(
        _data([_seg("незнаю", 5.0, 6.0, [("незнаю", 5.0, 6.0)])]),
        ["не знаю"])
    assert [(w["w"], w["s"], w["e"]) for s in out for w in s["words"]] == [
        ("не", 5.0, 6.0), ("знаю", 5.0, 6.0)]
    out, _ = align_custom_text(
        _data([_seg("по д", 5.0, 6.0, [("по", 5.0, 5.5), ("д", 5.5, 6.0)])]),
        ["под"])
    assert [(w["w"], w["s"], w["e"]) for s in out for w in s["words"]] == [
        ("под", 5.0, 6.0)]


def test_unmatched_whisper_kept_verbatim():
    out, stats = align_custom_text(
        _data(_base()), ["раз", "три читыре"])
    words = [w for s in out for w in s["words"]]
    dva = next(w for w in words if w["w"] == "два")
    assert (dva["s"], dva["e"]) == (11.0, 12.0)
    assert "corrected" not in dva
    assert stats["kept"] == 1


def test_correction_without_counterpart_ignored():
    # «о» вместо «а»: вставить некуда — остаётся распознанное «а»
    segs = [_seg("припев а", 10.0, 12.0, [("припев", 10.0, 11.0), ("а", 11.0, 12.0)])]
    out, stats = align_custom_text(_data(segs), ["припев о"])
    assert [(w["w"], w["s"], w["e"]) for s in out for w in s["words"]] == [
        ("припев", 10.0, 11.0), ("а", 11.0, 12.0)]
    assert stats["skipped"] == 1 and stats["kept"] == 1


def test_repeats_keep_whisper_structure():
    segs = [_seg("припев а", 10.0, 12.0, [("припев", 10.0, 11.0), ("а", 11.0, 12.0)]),
            _seg("куплет", 14.0, 15.0, [("куплет", 14.0, 15.0)]),
            _seg("припев а", 20.0, 22.0, [("припев", 20.0, 21.0), ("а", 21.0, 22.0)])]
    out, _ = align_custom_text(
        _data(segs), ["припев а", "куплет", "припев а"])
    assert [(s["text"], s["start"], s["end"]) for s in out] == [
        ("припев а", 10.0, 12.0), ("куплет", 14.0, 15.0), ("припев а", 20.0, 22.0)]


def test_part_preserved():
    out, _ = align_custom_text(
        _data([_seg("раз два", 10.0, 12.0,
                     [("раз", 10.0, 11.0), ("два", 11.0, 12.0)], part="verse")]),
        ["раз два"])
    assert out[0].get("part") == "verse"


def test_empty_lines_noop():
    segs = _base()
    out, stats = align_custom_text(_data(segs), [])
    assert out is segs and stats["applied"] is False


def test_no_whisper_words_noop():
    out, stats = align_custom_text({"language": "ru", "segments": []}, ["раз"])
    assert out == [] and stats["applied"] is False


def test_align_words_monotone_ops():
    ops = _align_words(["а", "б", "в"], ["а", "в"])
    kinds = [o[0] for o in ops]
    assert kinds == ["m", "d", "m"], kinds


def test_degraded_even_grid_flagged():
    segs = [_seg("а б в г д", 0.0, 2.5,
                 [(w, i * 0.5, i * 0.5 + 0.5)
                  for i, w in enumerate(["а", "б", "в", "г", "д"])])]
    _, stats = align_custom_text(_data(segs), ["а б в г д"])
    assert stats["degraded"] is True
    _, stats_ok = align_custom_text(_data(_base()), ["раз два", "три читыре"])
    assert stats_ok["degraded"] is False


def test_stats_and_seg_conf():
    out, stats = align_custom_text(
        _data(_base()), ["раз два", "три читыре"])
    for key in ("total_w", "total_u", "dp_cost", "point_share",
                "mean_seg_conf", "low_conf_segments", "degraded"):
        assert key in stats, key
    assert stats["total_w"] == 4 and stats["total_u"] == 4
    assert stats["dp_cost"] == 0.0 and stats["mean_seg_conf"] == 1.0
    assert stats["low_conf_segments"] == 0
    assert all(s["conf"] == 1.0 for s in out)
