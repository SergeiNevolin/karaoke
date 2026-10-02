"""Тесты наложения текста: fuzzy-DP + перенос таймингов слов."""
from karaoke_ml_service.core.lyrics import apply_text_to_segments, even_words, normalize_words, transfer_words


def seg(text, s, e, words):
    return {"start": s, "end": e, "text": text,
            "words": [{"w": w, "s": ws, "e": we} for w, ws, we in words]}


def base():
    return [
        seg("раз два", 10, 12, [("раз", 10, 11), ("два", 11, 12)]),
        seg("три четыре", 14, 16, [("три", 14, 15), ("четыре", 15, 16)]),
        seg("пять шесть", 20, 22, [("пять", 20, 21), ("шесть", 21, 22)]),
    ]


def test_exact_keeps_timings():
    out, stats = apply_text_to_segments(base(), "раз два\nтри четыре\nпять шесть")
    assert stats["matched"] == 3
    assert out[0]["words"] == base()[0]["words"]


def test_typo_keeps_timings():
    out, stats = apply_text_to_segments(base(), "раз два\nтри читыре\nпять шесть")
    assert stats["matched"] == 3
    assert [(w["w"], w["s"], w["e"]) for w in out[1]["words"]] == [
        ("три", 14, 15), ("читыре", 15, 16),
    ]


def test_shifted_lines_align_not_positionally():
    out, stats = apply_text_to_segments(
        base(), "интро-заглушка\nраз два\nтри четыре\nпять шесть")
    assert stats["matched"] == 3
    assert out[1]["text"] == "раз два"
    assert out[1]["start"] == 10
    assert out[0]["text"] == "интро-заглушка"


def test_gap_and_kept_tail():
    out, stats = apply_text_to_segments(base(), "раз два\nвставка\nтри четыре")
    assert stats["matched"] == 2
    mid = next(s for s in out if s["text"] == "вставка")
    assert mid["start"] >= 12 and mid["end"] <= 14
    assert out[-1]["text"] == "пять шесть"


def test_brackets_skipped_tail_appended():
    out, stats = apply_text_to_segments(
        base(), "[Куплет]\nраз два\n\nтри четыре\nпять шесть\nна бис\nещё раз")
    assert out[-1]["text"] == "ещё раз"
    assert out[-1]["start"] > 22


def test_empty_returns_as_is():
    out, stats = apply_text_to_segments(base(), "  \n[Припев]\n  ")
    assert stats == {"applied": False}
    assert len(out) == 3


def test_transfer_interpolates_inserted_tokens():
    s = seg("a b", 10, 14, [("a", 10, 12), ("b", 12, 14)])
    ws = transfer_words(s, "a X b")
    assert [(w["w"], w["s"], w["e"]) for w in ws] == [
        ("a", 10, 12), ("X", 12, 12), ("b", 12, 14),
    ]


def test_transfer_ms_rounding():
    s = seg("а б", 10.1234, 12.3456, [("а", 10.1234, 11), ("б", 11, 12.3456)])
    for w in transfer_words(s, "а б в"):
        assert w["s"] == round(w["s"], 3)
        assert w["e"] == round(w["e"], 3)


def test_even_words_ms():
    ws = even_words("а б в", 10.1234, 12.3456)
    assert (ws[0]["s"], ws[-1]["e"]) == (10.123, 12.346)
    assert ws[0]["e"] == ws[1]["s"]
    assert ws[1]["e"] == ws[2]["s"]
    for w in ws:
        assert w["s"] == round(w["s"], 3)


def test_normalize_clamps_and_unoverlaps_ms():
    ws = normalize_words(
        [
            {"w": "a", "s": 9.0, "e": 10.1234},  # вылезло влево
            {"w": "b", "s": 10.05, "e": 10.04},  # инверсия + налезло
            {"w": "c", "s": 11.9999, "e": 99.0},  # вылезло вправо
        ],
        10.0,
        12.0,
    )
    assert [(w["s"], w["e"]) for w in ws] == [(10.0, 10.123), (10.123, 10.153), (12.0, 12.0)]
    for w in ws:
        assert w["s"] == round(w["s"], 3)


def test_normalize_keeps_clean_untouched():
    ws = normalize_words(
        [{"w": "a", "s": 10.123, "e": 11}, {"w": "b", "s": 11.5, "e": 12}],
        10.0,
        12.0,
    )
    assert [(w["s"], w["e"]) for w in ws] == [(10.123, 11), (11.5, 12)]


def test_yo_normalization_matches():
    out, stats = apply_text_to_segments(
        [seg("еще один", 10, 12, [("еще", 10, 11), ("один", 11, 12)])],
        "ещё один",
    )
    assert stats["matched"] == 1
    assert out[0]["words"][0]["s"] == 10


def test_fuzzy_token_anchor_keeps_timing_on_typo():
    out, _ = apply_text_to_segments(
        [seg("большой дом", 10, 12, [("большой", 10, 11), ("дом", 11, 12)])],
        "балшой дом",
    )
    # 'балшой' ~ 'большой' (опечатка) — якорь держит [10,11], а не интерполяция
    assert out[0]["words"][0]["s"] == 10
    assert out[0]["words"][0]["e"] == 11


def test_shadow_duplicate_suppressed():
    out, stats = apply_text_to_segments(
        [
            seg("пошла жара", 10, 12, [("пошла", 10, 11), ("жара", 11, 12)]),
            seg("пошла жара веселая", 10, 14, [("пошла", 10, 11), ("веселая", 13, 14)]),
        ],
        "пошла жара веселая",
    )
    assert stats["matched"] == 1
    assert stats["deduped"] == 1
    assert len(out) == 1
    assert out[0]["text"] == "пошла жара веселая"


def test_dissimilar_kept_not_dropped():
    out, stats = apply_text_to_segments(
        [
            seg("совсем другое", 10, 12, [("совсем", 10, 11), ("другое", 11, 12)]),
            seg("пошла жара веселая", 10, 14, [("пошла", 10, 11), ("веселая", 13, 14)]),
        ],
        "пошла жара веселая",
    )
    assert stats["deduped"] == 0
    assert len(out) == 2


def test_relaxed_pass_pairs_borderline():
    # 'пошла жара!' vs 'пошла жара' — высокое сходство, строгий проход берёт;
    # 'жара весёлая' vs 'жара веселая праздник' — пониже, добирает relaxed
    out, stats = apply_text_to_segments(
        [
            seg("пошла жара", 10, 12, [("пошла", 10, 11), ("жара", 11, 12)]),
            seg("совсем другое дело тут", 14, 16, [("совсем", 14, 15), ("тут", 15, 16)]),
        ],
        "пошла жара!\nсовсем другое дело",
    )
    assert stats["matched"] == 2
    assert out[0]["text"] == "пошла жара!"
    assert out[1]["text"] == "совсем другое дело"


def test_gap_copy_does_not_duplicate_kept():
    # две whisper-тейки одного места + одна custom-строка:
    # одна спаривается, вторая-несматченная давится как тень
    out, stats = apply_text_to_segments(
        [
            seg("пошла жара", 10, 12, [("пошла", 10, 11), ("жара", 11, 12)]),
            seg("пошла жара!", 10.5, 14, [("пошла", 10.5, 11), ("жара!", 11, 14)]),
        ],
        "пошла жара!",
    )
    assert stats["matched"] == 1
    assert stats["deduped"] == 1
    assert len(out) == 1
    assert out[0]["text"] == "пошла жара!"


def test_gap_hard_cap_no_overflow():
    out, _ = apply_text_to_segments(
        [seg("a", 10, 12, [("a", 10, 12)]), seg("b", 12.2, 14, [("b", 12.2, 14)])],
        "a\nx\ny\nb",
    )
    xs = [s for s in out if s["text"] in ("x", "y")]
    assert len(xs) == 2
    assert all(s["end"] <= 12.201 for s in xs)
