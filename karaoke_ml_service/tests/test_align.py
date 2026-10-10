"""Forced alignment: чистые функции + WordAligner на стабах (без моделей)."""
from __future__ import annotations

import pytest

from karaoke_ml_service.core.align import (
    WordAligner,
    _ctc_word_times,
    _encode_transcript,
    norm_for_align,
    snap_words_to_onsets,
)


def _torch():
    return pytest.importorskip("torch")


def _w(w, s, e):
    return {"w": w, "s": s, "e": e}


def test_norm_for_align():
    assert norm_for_align("Привет, Ёжик! 123") == "привет ежик 123"
    assert norm_for_align("  a   b  ") == "a b"


def test_snap_pulls_early_word_forward():
    words = [_w("раз", 1.00, 1.30), _w("два", 1.30, 1.60)]
    out, stats = snap_words_to_onsets(words, [1.12, 1.45], 1.0, 1.6, window=0.25)
    assert out[0]["s"] == pytest.approx(1.12)
    assert out[0]["e"] == pytest.approx(1.42)  # длительность сохранена
    assert out[1]["s"] == pytest.approx(1.45)
    assert stats["snapped"] == 2
    assert stats["mean_shift"] == pytest.approx(0.135, abs=0.01)


def test_snap_prefers_forward_over_backward():
    # назад ближе в абсолютном (0.06), вперёд дальше (0.08) — тянем вперёд:
    # Whisper систематически спешит, истинное начало впереди. Штраф x1.5
    # на прошлое: 0.06*1.5=0.09 > 0.08*1.0=0.08.
    out, _ = snap_words_to_onsets([_w("а", 1.0, 1.2)], [0.94, 1.08], 0.9, 1.3, window=0.25)
    assert out[0]["s"] == pytest.approx(1.08)


def test_snap_no_onset_keeps_and_monotone():
    words = [_w("а", 1.0, 1.2), _w("б", 1.1, 1.3)]  # налезают
    out, stats = snap_words_to_onsets(words, [], 1.0, 1.5, window=0.25)
    assert stats["snapped"] == 0
    assert out[1]["s"] >= out[0]["e"], "монотонность даже без onset'ов"
    assert all(w["s"] <= w["e"] for w in out)


def test_encode_transcript_skips_oov_and_marks_ranges():
    vocab = {"a": 1, "b": 2, "|": 3}
    labels, ranges = _encode_transcript("ab z", vocab)
    assert labels == [1, 2, 3]  # 'z' нет в словаре — дроп, слово пустое
    assert ranges == [("ab", 0, 2), ("z", 3, 3)]


def _log_probs(peaks, blank=0, hi=0.0, lo=-10.0):
    """Синтетические emissions: peaks[t] = id метки (или blank)."""
    torch = _torch()
    V = 3
    lp = torch.full((len(peaks), V), lo)
    for t, v in enumerate(peaks):
        lp[t, v] = hi
    return lp


def test_ctc_word_times_orders_and_conf():
    # кадры: a a blank b b blank; метки [a, b]; слова w1=[a], w2=[b]
    lp = _log_probs([1, 1, 0, 2, 2, 0])
    times = _ctc_word_times(lp, [1, 2], [("w1", 0, 1), ("w2", 1, 2)],
                            blank=0, frame_dur=0.02, offset=10.0)
    (s1, e1, c1), (s2, e2, c2) = times
    assert s1 == pytest.approx(10.0) and e1 == pytest.approx(10.04)
    assert s2 == pytest.approx(10.06) and e2 == pytest.approx(10.10)
    assert c1 == pytest.approx(1.0) and c2 == pytest.approx(1.0)


def test_ctc_word_times_empty_span_falls_back():
    # emissions — одни бланки: Viterbi вынужденно кладёт токен на худший кадр,
    # но conf == 0.0 — вызыватель (_ctc_words) оставит whisper-тайминг
    # (порог conf < 0.05). Пустой labels -> честный nan.
    lp = _log_probs([0, 0, 0, 0])
    (s, e, c), = _ctc_word_times(lp, [1], [("w", 0, 1)],
                                 blank=0, frame_dur=0.02, offset=0.0)
    assert c == 0.0
    (sn, en, cn), = _ctc_word_times(lp, [], [("w", 0, 0)],
                                    blank=0, frame_dur=0.02, offset=0.0)
    assert cn == 0.0
    import math
    assert math.isnan(sn) and math.isnan(en)


def test_aligner_snap_only_without_ctc(tmp_path, monkeypatch):
    from fakes import wav

    import karaoke_ml_service.core.align as align_mod

    src = wav(tmp_path / "vocals.wav", seconds=1.0)
    monkeypatch.setattr(align_mod, "compute_onsets", lambda vocals: [0.15])
    monkeypatch.setattr(align_mod, "_load_mono_16k", lambda path: [0.0] * 16000)
    al = WordAligner(use_ctc=False, snap_window=0.25)
    segs = [{"start": 0.0, "end": 1.0, "text": "а б",
             "words": [_w("а", 0.0, 0.5), _w("б", 0.5, 1.0)]}]
    out = al.align(src, segs, lang="ru")
    assert out[0]["words"][0]["s"] == pytest.approx(0.15)
    assert out[0]["start"] == pytest.approx(0.15)  # границы сегмента — по словам
    assert out[0]["end"] == pytest.approx(1.0)


def test_aligner_never_raises_on_broken_audio(tmp_path, monkeypatch):
    import karaoke_ml_service.core.align as align_mod

    monkeypatch.setattr(align_mod, "_load_mono_16k",
                        lambda path: (_ for _ in ()).throw(OSError("нет файла")))
    al = WordAligner(use_ctc=False)
    segs = [{"start": 0.0, "end": 1.0, "text": "а", "words": [_w("а", 0.0, 1.0)]}]
    assert al.align(tmp_path / "нет.wav", segs) is segs
