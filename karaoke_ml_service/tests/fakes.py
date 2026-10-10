"""Общие фейки шагов пайплайна: ни моделей, ни сети, ни GPU в тестах."""
from __future__ import annotations

import array
import wave
from pathlib import Path


def wav(path: Path, seconds: float = 0.2, sr: int = 8000) -> Path:
    n = int(seconds * sr)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(array.array("h", [0] * n).tobytes())
    return path


class FakeSeparator:
    """Пишет vocals.wav/minus.wav и помнит, какой файл разделял."""

    def __init__(self, **kwargs):
        self.init_kwargs = kwargs
        self.calls: list[Path] = []
        self.closed = False

    def separate(self, src: Path, out_dir: Path) -> tuple[Path, Path]:
        self.calls.append(Path(src))
        out_dir.mkdir(parents=True, exist_ok=True)
        return wav(out_dir / "vocals.wav"), wav(out_dir / "minus.wav")

    def close(self) -> None:
        self.closed = True


class FakeTranscriber:
    def __init__(self, **kwargs):
        self.init_kwargs = kwargs
        self.calls: list[tuple[Path, str | None]] = []
        self.closed = False

    def transcribe(self, audio: Path, lang: str | None = None) -> dict:
        self.calls.append((Path(audio), lang))
        return {"language": (lang if lang not in (None, "", "auto") else "ru"),
                "segments": [{"start": 0.0, "end": 1.0, "text": "a",
                              "words": [{"w": "a", "s": 0.0, "e": 1.0}]}]}

    def close(self) -> None:
        self.closed = True


class FakePitch:
    def __init__(self, **kwargs):
        self.init_kwargs = kwargs
        self.calls: list[Path] = []
        self.closed = False

    def extract(self, vocals: Path, out_json: Path | None = None) -> dict:
        self.calls.append(Path(vocals))
        return {"t": [0.0], "midi": [60], "conf": [0.9]}

    def close(self) -> None:
        self.closed = True


class FakeAligner:
    """No-op алайнер: возвращает сегменты как есть, помнит вызовы."""

    def __init__(self, **kwargs):
        self.init_kwargs = kwargs
        self.calls: list[tuple[Path, str | None]] = []
        self.closed = False

    def align(self, vocals: Path, segments: list, lang: str | None = None) -> list:
        self.calls.append((Path(vocals), lang))
        return segments

    def close(self) -> None:
        self.closed = True


class BoomPipeline:
    def run(self, *args, **kwargs):
        raise RuntimeError("gpu сгорел")
