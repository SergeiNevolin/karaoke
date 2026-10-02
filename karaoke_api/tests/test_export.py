"""Чистые куски экспорта: slug и пики waveform на синтетическом wav."""
import array
import wave
from pathlib import Path

from karaoke_api.store.publish import waveform_peaks
from karaoke_api.store.songs import wav_seconds
from karaoke_api.utils import slug


def test_slug_translit():
    assert slug("Ты Шлюха Не Моя") == "ty-shlyuha-ne-moya"
    assert slug("  Пошлая   Молли: Контракт!  ") == "poshlaya-molli-kontrakt"
    assert slug("Egor Kreed - Samaya Samaya") == "egor-kreed-samaya-samaya"


def _sine_wav(path: Path, seconds=1.0, sr=8000):
    import math

    n = int(seconds * sr)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(array.array("h", (int(10000 * math.sin(i / 10)) for i in range(n))).tobytes())


def test_wav_duration_and_peaks(tmp_path):
    p = tmp_path / "v.wav"
    _sine_wav(p)
    assert wav_seconds(p) == 1.0
    peaks, dur = waveform_peaks(p, buckets=10)
    assert dur == 1.0
    assert len(peaks) == 10
    assert all(0.0 <= v <= 1.0 for v in peaks)
    assert max(peaks) == 1.0  # нормированы на пик


def test_wav_missing():
    assert wav_seconds(Path("nope.wav")) == 0.0
    assert waveform_peaks(Path("nope.wav")) == ([], 0.0)
