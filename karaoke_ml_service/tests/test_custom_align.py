"""Правка слов приложенным текстом: тайминги заморожены, правится текст."""
from __future__ import annotations

from karaoke_ml_service.core.custom_align import _align_words, align_custom_text


def _seg(text, s, e, words):
    return {"start": s, "end": e, "text": text,
            "words": [{"w": w, "s": ws, "e": we, "p": 0.9} for w, ws, we in words]}


def _base():
    return [
        _seg("раз два", 10.0, 12.0, [("раз", 10.0, 11.0), ("два", 11.0, 12.0)]),
        _seg("три читыре", 14.0, 16.0, [("три", 14.0, 15.0), ("читыре", 15.0, 16.0)]),
    ]


def _data(segs):
    return {"language": "ru", "segments": segs}


def test_exact_match_keeps_timings_byte_for_byte():
    out, stats = align_custom_text(
        _data(_base()), ["раз два", "три читыре"])
    assert stats["applied"] is True and stats["mode"] == "correct"
    assert stats["corrected"] == 0
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


def test_inserted_words_share_existing_timing():
    out, stats = align_custom_text(
        _data(_base()), ["раз два", "три очень четыре"])
    words = [w for s in out for w in s["words"]]
    och = next(w for w in words if w["w"] == "очень")
    # вставка делит полный интервал якоря — нулевых слов нет
    assert (och["s"], och["e"]) == (15.0, 16.0)
    assert all(w["e"] > w["s"] for w in words)
    assert stats["inserted"] == 1
    # все числа s/e — verbatim из Whisper, четыре на месте
    allowed_nums = {10.0, 11.0, 12.0, 14.0, 15.0, 16.0}
    assert {w["s"] for w in words} | {w["e"] for w in words} <= allowed_nums
    chetyre = next(w for w in words if w["w"] == "четыре")
    assert (chetyre["s"], chetyre["e"]) == (15.0, 16.0)


def test_unmatched_whisper_kept_fragment_absorbed():
    # «с» — осколок (джойн не проходит по порогу): приклеен к «собой» — поглощается
    segs = [_seg("с тобой", 10.0, 12.0, [("с", 10.0, 11.0), ("тобой", 11.0, 12.0)])]
    out, stats = align_custom_text(_data(segs), ["собой"])
    texts = " ".join(s["text"] for s in out)
    assert texts == "собой", texts
    soboi = next(w for s in out for w in s["words"] if w["w"] == "собой")
    assert (soboi["s"], soboi["e"]) == (11.0, 12.0)
    assert stats["dropped"] == 1


def test_join_covers_span():
    # «по»+«д» -> «под»: спан от начала первого до конца последнего, числа те же
    segs = [_seg("по д", 14.0, 16.0, [("по", 14.0, 15.0), ("д", 15.0, 16.0)])]
    out, stats = align_custom_text(_data(segs), ["под"])
    pod = next(w for s in out for w in s["words"] if w["w"] == "под")
    assert (pod["s"], pod["e"]) == (14.0, 16.0)
    assert stats["kept"] == 0


def test_split_shares_full_interval():
    # «незнаю» -> «не знаю»: оба куска подсвечены весь интервал, точек нет
    segs = [_seg("незнаю", 5.0, 6.0, [("незнаю", 5.0, 6.0)])]
    out, stats = align_custom_text(_data(segs), ["не знаю"])
    words = [w for s in out for w in s["words"]]
    assert [(w["w"], w["s"], w["e"]) for w in words] == [
        ("не", 5.0, 6.0), ("знаю", 5.0, 6.0)]
    assert stats["point_share"] == 0.0
    assert stats["matched"] == 1


def test_repeats_keep_order():
    segs = [_seg("припев а", 10.0, 12.0, [("припев", 10.0, 11.0), ("а", 11.0, 12.0)]),
            _seg("куплет", 14.0, 15.0, [("куплет", 14.0, 15.0)]),
            _seg("припев а", 20.0, 22.0, [("припев", 20.0, 21.0), ("а", 21.0, 22.0)])]
    out, _ = align_custom_text(
        _data(segs), ["припев а", "куплет", "припев а"])
    assert [s["text"] for s in out] == ["припев а", "куплет", "припев а"]
    assert [s["start"] for s in out] == [10.0, 14.0, 20.0]


def test_empty_lines_noop():
    segs = _base()
    out, stats = align_custom_text(_data(segs), [])
    assert out is segs and stats["applied"] is False


def test_align_words_monotone_ops():
    ops = _align_words(["а", "б", "в"], ["а", "в"])
    kinds = [o[0] for o in ops]
    assert kinds == ["m", "d", "m"], kinds


def test_inserted_line_shares_anchor_no_zero_words():
    # строка целиком из вставок: делит интервал якоря, сегмент валиден,
    # слов нулевой длительности нет
    segs = [_seg("раз", 10.0, 11.0, [("раз", 10.0, 11.0)])]
    out, _ = align_custom_text(_data(segs), ["раз", "эй"])
    line = next(s for s in out if s["text"] == "эй")
    assert [(w["w"], w["s"], w["e"]) for w in line["words"]] == [("эй", 10.0, 11.0)]
    for s in out:
        assert s["end"] > s["start"], s
        for w in s["words"]:
            assert w["e"] > w["s"], w


def test_genuine_unmatched_whisper_kept_verbatim():
    # пользователь пропустил слово — распознанное остаётся как есть, с тем же таймингом
    out, stats = align_custom_text(
        _data(_base()), ["раз", "три читыре"])
    words = [w for s in out for w in s["words"]]
    dva = next(w for w in words if w["w"] == "два")
    assert (dva["s"], dva["e"]) == (11.0, 12.0)
    assert "corrected" not in dva
    assert stats["kept"] == 1


def test_keepers_split_on_breath_gap():
    # киперы с паузой >= 1с — два сегмента, числа те же
    segs = [_seg("дом лес", 10.0, 20.0, [("дом", 10.0, 11.0), ("лес", 15.0, 16.0)])]
    out, stats = align_custom_text(_data(segs), ["ззз"])
    keeper_segs = [s for s in out if s["text"] in ("дом", "лес")]
    assert [(s["start"], s["end"]) for s in keeper_segs] == [(10.0, 11.0), (15.0, 16.0)]
    assert stats["kept"] == 2


def test_degraded_even_grid_flagged():
    segs = [_seg("а б в г д", 0.0, 2.5,
                 [(w, i * 0.5, i * 0.5 + 0.5)
                  for i, w in enumerate(["а", "б", "в", "г", "д"])])]
    _, stats = align_custom_text(_data(segs), ["а б в г д"])
    assert stats["degraded"] is True
    _, stats_ok = align_custom_text(_data(_base()), ["раз два", "три читыре"])
    assert stats_ok["degraded"] is False


def test_unsupervised_stats_and_line_conf():
    out, stats = align_custom_text(
        _data(_base()), ["раз два", "три читыре"])
    for key in ("total_w", "total_u", "dp_cost", "point_share",
                "keeper_share", "keeper_overlap", "mean_line_conf",
                "low_conf_lines", "degraded"):
        assert key in stats, key
    assert stats["total_w"] == 4 and stats["total_u"] == 4
    assert stats["dp_cost"] == 0.0 and stats["mean_line_conf"] == 1.0
    assert stats["low_conf_lines"] == 0
    assert all(s["conf"] == 1.0 for s in out if s["text"] in ("раз два", "три читыре"))


def test_replaced_keeper_dropped():
    # «о» вместо «а»: вставка без пары опускается, заменённый кипер — тоже;
    # остаётся согласованное
    segs = [_seg("припев а", 10.0, 12.0, [("припев", 10.0, 11.0), ("а", 11.0, 12.0)])]
    out, stats = align_custom_text(_data(segs), ["припев о"])
    texts = [w["w"] for s in out for w in s["words"]]
    assert texts == ["припев", "о"], texts
    assert stats["kept"] == 0 and stats["inserted"] == 1 and stats["replaced"] == 1
