"""Примитивы текстов песен: нормализация, чистка строк, раскладка, выпрямление."""
from karaoke_ml_service.core.lyrics import (
    clean_lines,
    even_words,
    norm,
    normalize_words,
    sanitize_segments,
)


def test_norm():
    assert norm("Привет, Ёжик!") == "привет ежик"
    assert norm("  a   b  ") == "a b"


def test_clean_lines_skips_brackets_and_empties():
    assert clean_lines("  \n[Припев]\nстрока \n") == ["строка"]
    assert clean_lines(["a", "", "b"]) == ["a", "b"]


def test_even_words_splits_interval():
    ws = even_words("раз два", 10.0, 12.0)
    assert [(w["w"], w["s"], w["e"]) for w in ws] == [
        ("раз", 10.0, 11.0), ("два", 11.0, 12.0)]


def test_even_words_empty():
    assert even_words("   ", 0.0, 1.0) == []


def test_normalize_words_clamps_and_orders():
    words = [
        {"w": "a", "s": -1, "e": 0.5},
        {"w": "b", "s": 0.4, "e": 0.3},
        {"w": "c", "s": 0.4, "e": 2.0},
    ]
    out = normalize_words(words, 0.0, 1.0)
    assert [w["w"] for w in out] == ["a", "b", "c"]
    assert out[0]["s"] == 0.0 and out[2]["e"] == 1.0
    prev = 0.0
    for w in out:
        assert w["s"] <= w["e"] and w["s"] >= prev
        prev = w["e"]


def test_sanitize_repairs_degenerate_segment():
    segs = [{"start": 32.52, "end": 32.52, "text": "э",
             "words": [{"w": "э", "s": 32.52, "e": 32.52}]}]
    out, info = sanitize_segments(segs)
    assert info == {"repaired": 1, "dropped": 0}
    assert out[0]["end"] > out[0]["start"]
    # слова не тронуты — двигалась только граница сегмента
    assert (out[0]["words"][0]["s"], out[0]["words"][0]["e"]) == (32.52, 32.52)


def test_sanitize_repairs_inversion_and_drops_garbage():
    segs = [{"start": 5.0, "end": 3.0, "text": "x", "words": []},
            {"start": float("nan"), "end": 1.0, "text": "y", "words": []},
            "мусор",
            {"start": 0.0, "end": 1.0, "text": "ok", "words": []}]
    out, info = sanitize_segments(segs)
    assert info == {"repaired": 1, "dropped": 2}
    assert [(s["start"], s["end"]) for s in out] == [(5.0, 5.03), (0.0, 1.0)]


def test_sanitize_keeps_valid_untouched():
    segs = [{"start": 1.0, "end": 2.0, "text": "a", "words": []}]
    out, info = sanitize_segments(segs)
    assert out == segs and info == {"repaired": 0, "dropped": 0}
