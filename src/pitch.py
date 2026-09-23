"""
Анализ высоты тона (pitch) эталонного вокала + скоринг исполнения.
Эталон: librosa.pyin по vocals.wav (CPU, делается один раз при сборке песни).
Скоринг: сравниваем ноты (MIDI, с точностью до октавы) микрофона и эталона.

Зависимости: librosa, numpy, soundfile
"""
import json
from pathlib import Path

import numpy as np


def hz_to_midi(hz: float) -> float:
    return 69 + 12 * np.log2(hz / 440.0)


def extract_reference(vocals_path: str | Path, out_json: str | Path | None = None,
                      sr: int = 22050, hop: int = 512) -> dict:
    import librosa
    vocals_path = Path(vocals_path)
    print(f"[INFO] pitch-анализ {vocals_path.name} ...")
    y, _ = librosa.load(str(vocals_path), sr=sr, mono=True)
    f0, voiced_flag, _ = librosa.pyin(y, fmin=50, fmax=880, sr=sr, hop_length=hop)
    times = librosa.times_like(f0, sr=sr, hop_length=hop)
    midi = np.full_like(f0, np.nan, dtype=float)
    voiced = (~np.isnan(f0)) & voiced_flag
    midi[voiced] = hz_to_midi(f0[voiced])

    data = {"sr": sr, "hop": hop,
            "t": [round(float(t), 3) for t in times],
            "midi": [None if np.isnan(m) else round(float(m), 2) for m in midi],
            "voiced": [bool(v) for v in voiced]}
    if out_json is None:
        out_json = vocals_path.parent / (vocals_path.stem + "_pitch.json")
    Path(out_json).write_text(json.dumps(data), encoding="utf-8")
    cov = np.mean(voiced) * 100
    print(f"[OK] {out_json} (voiced {cov:.1f}%)")
    return data


def midi_from_file(path: str | Path, sr=22050, hop=512) -> tuple[np.ndarray, np.ndarray]:
    """Быстрый pitch-трек для записи микрофона (для скоринга)."""
    import librosa
    y, _ = librosa.load(str(path), sr=sr, mono=True)
    f0, voiced_flag, _ = librosa.pyin(y, fmin=50, fmax=880, sr=sr, hop_length=hop)
    times = librosa.times_like(f0, sr=sr, hop_length=hop)
    midi = np.full_like(f0, np.nan, dtype=float)
    voiced = (~np.isnan(f0)) & voiced_flag
    midi[voiced] = hz_to_midi(f0[voiced])
    return times, midi


def score_performance(ref_pitch_json: str | Path, mic_wav: str | Path,
                      offset: float = 0.0) -> dict:
    """
    Сравнение по классам высоты (pitch-class, 12 полутонов, октава игнорируется).
    offset — задержка старта записи микрофона относительно начала минуса (сек).
    Возвращает оценку 0..100 + детали.
    """
    ref = json.loads(Path(ref_pitch_json).read_text(encoding="utf-8"))
    ref_t = np.array(ref["t"], dtype=float)
    ref_m = np.array([np.nan if m is None else m for m in ref["midi"]], dtype=float)

    mic_t, mic_m = midi_from_file(mic_wav, sr=ref.get("sr", 22050), hop=ref.get("hop", 512))
    mic_t = mic_t + offset

    hits, total, errs = 0, 0, []
    for i, tm in enumerate(mic_t):
        if np.isnan(mic_m[i]):
            continue
        j = int(np.argmin(np.abs(ref_t - tm)))
        if np.isnan(ref_m[j]):
            continue
        total += 1
        # разница в полутонах по модулю октавы
        d = abs((mic_m[i] - ref_m[j] + 6) % 12 - 6)
        errs.append(float(d))
        if d <= 1.0:  # допуск ±1 полутон
            hits += 1
    acc = (hits / total * 100) if total else 0.0
    med_err = float(np.median(errs)) if errs else 99.0
    # штраф за молчание: если спели <30% озвученных мест — режем оценку
    result = {"score": round(acc, 1), "median_error_semitones": round(med_err, 2),
              "compared_frames": total, "hits": hits}
    print(f"[SCORE] {result['score']} (попадания {hits}/{total}, медиана ошибки {med_err:.2f} пт)")
    return result


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("vocals", help="vocals.wav")
    ap.add_argument("--mic", default=None, help="запись микрофона для теста скоринга")
    a = ap.parse_args()
    pj = Path(a.vocals).parent / (Path(a.vocals).stem + "_pitch.json")
    extract_reference(a.vocals, pj)
    if a.mic:
        score_performance(pj, a.mic)
