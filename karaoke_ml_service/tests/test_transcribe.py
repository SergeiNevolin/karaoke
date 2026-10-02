"""Чистые функции транскрибера + класс Transcriber (faster-whisper замокан)."""
import sys
import types
from types import SimpleNamespace

from karaoke_ml_service.core.transcribe import Transcriber, fmt_lrc_time, normalize_words, r3


def test_fmt_lrc_time():
    assert fmt_lrc_time(0) == "[00:00.00]"
    assert fmt_lrc_time(61.5) == "[01:01.50]"
    assert fmt_lrc_time(125.25) == "[02:05.25]"


def test_r3():
    assert r3(1.23456) == 1.235
    assert r3("2") == 2.0


def test_normalize_words_clamps_and_orders():
    words = [
        {"w": "a", "s": -1, "e": 0.5},  # вылезает влево — clamp
        {"w": "b", "s": 0.4, "e": 0.3},  # инверсия — чиним
        {"w": "c", "s": 0.4, "e": 2.0},  # вылезает вправо — clamp
    ]
    out = normalize_words(words, 0.0, 1.0)
    assert [w["w"] for w in out] == ["a", "b", "c"]  # порядок и состав те же
    assert out[0]["s"] == 0.0
    assert out[0]["e"] == 0.5
    assert out[1]["s"] == 0.5 and out[1]["e"] >= out[1]["s"]
    assert out[2]["e"] == 1.0
    # инварианты: s <= e, границы монотонны, никто никого не обгоняет
    prev_e = 0.0
    for w in out:
        assert w["s"] <= w["e"]
        assert w["s"] >= prev_e
        prev_e = w["e"]


def test_normalize_words_zero_keeps():
    out = normalize_words([{"w": "x", "s": 0.5, "e": 0.5}], 0.0, 1.0)
    assert out[0]["s"] == out[0]["e"] == 0.5


def test_transcriber_caches_model_and_formats_words(monkeypatch, tmp_path):
    fake = types.ModuleType("faster_whisper")

    class FakeWhisper:
        made: list["FakeWhisper"] = []

        def __init__(self, name, device=None, compute_type=None):
            self.init = (name, device, compute_type)
            self.kwargs = None
            type(self).made.append(self)

        def transcribe(self, path, **kw):
            self.kwargs = kw
            seg = SimpleNamespace(start=0.0, end=1.25, text=" привет ",
                                  words=[SimpleNamespace(word=" привет ", start=0.0,
                                                         end=1.25, probability=0.9)])
            info = SimpleNamespace(language="ru", language_probability=0.97)
            return iter([seg]), info

    fake.WhisperModel = FakeWhisper
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)
    monkeypatch.setattr(FakeWhisper, "made", [])

    tr = Transcriber(model="medium", device="cpu", compute="int8", vad=False)
    data = tr.transcribe(tmp_path / "v.wav", lang="ru")
    assert data["language"] == "ru"
    seg = data["segments"][0]
    assert seg["words"][0] == {"w": "привет", "s": 0.0, "e": 1.25, "p": 0.9}

    tr.transcribe(tmp_path / "v.wav", lang="")
    assert len(FakeWhisper.made) == 1, "модель кэшируется на экземпляр"
    assert FakeWhisper.made[0].init == ("medium", "cpu", "int8")
    assert FakeWhisper.made[0].kwargs["language"] is None, "'' — автоопределение"
    assert FakeWhisper.made[0].kwargs["vad_filter"] is False

    tr.close()
    assert tr._model is None
    tr.close()  # повторный close — no-op
