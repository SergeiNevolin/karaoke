"""VocalSeparator: demucs.api вместо CLI (build_cmd удалён), минус = сумка стемов."""
from __future__ import annotations

from pathlib import Path

import pytest

import karaoke_ml_service.core.separate as sep_mod
from karaoke_ml_service.core.separate import ALLOWED_MODELS, VocalSeparator, _pick_device


class FakeTensor:
    def __init__(self, values):
        self.values = list(values)

    def detach(self):
        return self

    def cpu(self):
        return self

    def __add__(self, other):
        return FakeTensor([a + b for a, b in zip(self.values, other.values, strict=False)])


class FakeDemucs:
    created: list[FakeDemucs] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.samplerate = 44100
        type(self).created.append(self)

    def separate_audio_file(self, path):
        return path, {"vocals": FakeTensor([1.0]), "drums": FakeTensor([2.0]),
                      "bass": FakeTensor([3.0]), "other": FakeTensor([4.0])}


@pytest.fixture
def fake_deps(monkeypatch):
    saved: list[tuple[list[float], str]] = []

    def save_audio(tensor, path, samplerate=None):
        saved.append((tensor.values, str(path)))
        with open(path, "wb") as f:
            f.write(b"RIFF")

    monkeypatch.setattr(sep_mod, "_load_deps", lambda: (FakeDemucs, save_audio))
    monkeypatch.setattr(FakeDemucs, "created", [])
    return saved


def test_separate_outputs_vocals_and_minus(fake_deps, tmp_path):
    out = tmp_path / "sep"
    v, m = VocalSeparator(device="cpu").separate(tmp_path / "in.wav", out)
    assert v.name == "vocals.wav" and m.name == "minus.wav"
    assert v.is_file() and m.is_file()
    vals = {Path(name).name: value for value, name in fake_deps}
    assert vals["vocals.wav"] == [1.0]
    assert vals["minus.wav"] == [9.0], "минус = drums+bass+other"


def test_model_and_device_kwargs_passed(fake_deps, tmp_path):
    VocalSeparator(model="htdemucs", device="cpu", shifts=2, overlap=0.5).separate(
        tmp_path / "in.wav", tmp_path / "out")
    kw = FakeDemucs.created[0].kwargs
    assert kw["model"] == "htdemucs" and kw["device"] == "cpu"
    assert kw["shifts"] == 2 and kw["overlap"] == 0.5


def test_lazy_load_once_and_close(fake_deps, tmp_path):
    sep = VocalSeparator(device="cpu")
    sep.separate(tmp_path / "a.wav", tmp_path / "o1")
    sep.separate(tmp_path / "b.wav", tmp_path / "o2")
    assert len(FakeDemucs.created) == 1, "модель кэшируется между прогонами"
    sep.close()
    assert sep._sep is None
    sep.separate(tmp_path / "c.wav", tmp_path / "o3")
    assert len(FakeDemucs.created) == 2, "после close() — ленивая перезагрузка"


def test_bad_model_rejected(fake_deps):
    with pytest.raises(ValueError):
        VocalSeparator(model="htdemucs_v5")
    assert "htdemucs_ft" in ALLOWED_MODELS


def test_missing_vocals_stem_is_error(fake_deps, monkeypatch, tmp_path):
    monkeypatch.setattr(
        FakeDemucs, "separate_audio_file",
        lambda self, path: (path, {"drums": FakeTensor([1.0])}))
    with pytest.raises(RuntimeError, match="vocals"):
        VocalSeparator(device="cpu").separate(tmp_path / "in.wav", tmp_path / "out")


def test_pick_device_falls_back_to_cpu_without_cuda():
    import torch
    expected = "cuda" if torch.cuda.is_available() else "cpu"
    assert _pick_device("cuda") == expected
    assert _pick_device("cpu") == "cpu"
