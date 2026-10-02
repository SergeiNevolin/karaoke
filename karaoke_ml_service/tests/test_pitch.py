"""Параметры pitch-трекинга (CREPE) и обёртки классов PitchExtractor/PitchScorer."""
import json
from pathlib import Path
from unittest.mock import patch

import numpy as np

from karaoke_ml_service.core.pitch import extract_reference


def _silent_loud(sr, freq=220.0):
    t = np.arange(sr) / sr
    sine = (0.5 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    return np.concatenate([np.zeros(sr, dtype=np.float32), sine])


def test_crepe_params(tmp_path):
    """CREPE зовём полной моделью в диапазоне голоса, выход — m|None."""
    import torch

    sr, hop = 22050, 512
    y = _silent_loud(sr)
    n = 1 + len(y) // hop
    f0 = torch.full((1, n), 220.0)
    conf = torch.ones(1, n)
    conf[:, 5::10] = 0.0
    with (
        patch("librosa.load", return_value=(y, sr)),
        patch("torchcrepe.predict", return_value=(f0, conf)) as mpredict,
    ):
        out = extract_reference("dummy.wav", out_json=tmp_path / "p.json")
    _, kwargs = mpredict.call_args
    pos = mpredict.call_args[0]
    assert pos[3] == 50 and pos[4] == 880  # fmin/fmax диапазона голоса
    assert pos[5] == "full"  # модель
    assert len(out["t"]) == n
    assert out["midi"][-1] is not None  # громкий синус озвучен
    assert out["midi"][65] is None  # низкая periodicity — не озвучено
    assert out["midi"][0] is None  # тишина в начале — не озвучена
    assert out["t"][1] == round(hop / sr, 3)
    # уверенность трекера едет рядом, покадрово
    assert len(out["conf"]) == n
    assert out["conf"][-1] == 1.0


def test_vad_gates_separator_silence(tmp_path):
    """Тишина сепаратора (-inf дБ) — не пение, даже при высокой periodicity."""
    import torch

    sr, hop = 22050, 512
    y = _silent_loud(sr)
    n = 1 + len(y) // hop
    f0 = torch.full((1, n), 220.0)
    conf = torch.ones(1, n)
    with (
        patch("librosa.load", return_value=(y, sr)),
        patch("torchcrepe.predict", return_value=(f0, conf)),
    ):
        out = extract_reference("dummy.wav", out_json=tmp_path / "p.json")
    silent = [m for m, tt in zip(out["midi"], out["t"], strict=False) if tt < 0.9]
    assert silent and all(m is None for m in silent)
    loud = [m for m, tt in zip(out["midi"], out["t"], strict=False) if tt > 1.1]
    assert sum(m is not None for m in loud) / len(loud) > 0.9


def test_pitch_extractor_wraps_extract_reference(monkeypatch):
    import karaoke_ml_service.core.pitch as pitch_mod
    calls = {}

    def fake_extract(vocals_path, out_json=None, **kw):
        calls["vocals"] = Path(vocals_path)
        return {"t": [0.0], "midi": [60]}

    monkeypatch.setattr(pitch_mod, "extract_reference", fake_extract)
    out = pitch_mod.PitchExtractor().extract(Path("v.wav"))
    assert out == {"t": [0.0], "midi": [60]}
    assert calls["vocals"] == Path("v.wav")


def test_pitch_extractor_close_is_safe():
    from karaoke_ml_service.core.pitch import PitchExtractor
    PitchExtractor().close()  # без GPU — не падает
    PitchExtractor().close()


def test_scorer_accepts_dict_and_path(monkeypatch, tmp_path):
    import karaoke_ml_service.core.pitch as pitch_mod
    monkeypatch.setattr(
        pitch_mod, "midi_from_file",
        lambda p, sr=22050, hop=512: (np.array([0.0, 0.01]), np.array([60.0, 60.0])))
    ref = {"t": [0.0, 0.01], "midi": [60, 60], "sr": 22050, "hop": 512}
    res = pitch_mod.PitchScorer().score(ref, Path("mic.wav"))
    assert res["score"] == 100.0 and res["hits"] == 2
    ref_path = tmp_path / "ref.json"
    ref_path.write_text(json.dumps(ref), encoding="utf-8")
    assert pitch_mod.PitchScorer().score(ref_path, Path("mic.wav"))["score"] == 100.0
