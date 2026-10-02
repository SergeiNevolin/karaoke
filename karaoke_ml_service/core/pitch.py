"""
Анализ высоты тона (pitch) эталонного вокала + скоринг исполнения.
Эталон: CREPE (CNN, torchcrepe) по vocals.wav — держит октаву там, где
pyin прыгает по гармоникам/субгармоникам (белтинг, скрим). Делается один
раз при сборке песни, на GPU.
Скоринг: сравниваем ноты (MIDI, с точностью до октавы) микрофона и эталона.

Зависимости: librosa, numpy, soundfile, torch, torchcrepe
"""
import json
from pathlib import Path

import numpy as np


def hz_to_midi(hz: float) -> float:
    return 69 + 12 * np.log2(hz / 440.0)


def extract_reference(vocals_path: str | Path, out_json: str | Path | None = None,
                      sr: int = 22050, hop: int = 512, vad_db: float = -50.0,
                      periodicity: float = 0.3) -> dict:
    import librosa
    import torch
    import torchcrepe
    vocals_path = Path(vocals_path)
    print(f"[INFO] pitch-анализ {vocals_path.name} (CREPE) ...")
    y, _ = librosa.load(str(vocals_path), sr=sr, mono=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    # кусками по 60с: вся песня целиком может не влезть в VRAM
    f0_parts: list[np.ndarray] = []
    conf_parts: list[np.ndarray] = []
    chunk = 60 * sr
    for start in range(0, max(len(y), 1), chunk):
        audio = torch.from_numpy(y[start:start + chunk]).unsqueeze(0)
        pitch_hz, per = torchcrepe.predict(
            audio, sr, hop, 50, 880, "full",
            batch_size=512, device=device, return_periodicity=True,
        )
        f0_parts.append(pitch_hz.squeeze(0).cpu().numpy())
        conf_parts.append(per.squeeze(0).cpu().numpy())
    f0 = np.concatenate(f0_parts) if f0_parts else np.zeros(0)
    conf = np.concatenate(conf_parts) if conf_parts else np.zeros(0)
    times = np.arange(len(f0)) * hop / sr
    # VAD-гейт по энергии: тишина сепаратора (-80дБ) — не пение.
    # Без него трекер озвучивает инструментальный bleed и цифровые нули
    # (интро/соло/аутро). Порог -50дБ: пение идёт на -10..-30дБ.
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    loud = np.zeros(len(f0), dtype=bool)
    L = min(len(rms), len(f0))
    loud[:L] = 20 * np.log10(rms[:L] + 1e-9) > vad_db
    midi = np.full_like(f0, np.nan, dtype=float)
    voiced = (conf >= periodicity) & loud
    midi[voiced] = hz_to_midi(f0[voiced])

    data = {"sr": sr, "hop": hop,
            "t": [round(float(t), 3) for t in times],
            "midi": [None if np.isnan(m) else round(float(m), 2) for m in midi],
            "voiced": [bool(v) for v in voiced],
            "conf": [round(float(c), 3) for c in conf]}
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


def _load_ref(ref_pitch_json: str | Path | dict) -> dict:
    if isinstance(ref_pitch_json, dict):
        return ref_pitch_json
    return json.loads(Path(ref_pitch_json).read_text(encoding="utf-8"))


def score_performance(ref_pitch_json: str | Path | dict, mic_wav: str | Path,
                      offset: float = 0.0) -> dict:
    """
    Сравнение по классам высоты (pitch-class, 12 полутонов, октава игнорируется).
    offset — задержка старта записи микрофона относительно начала минуса (сек).
    Возвращает оценку 0..100 + детали.
    """
    ref = _load_ref(ref_pitch_json)
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


class PitchExtractor:
    """Эталонный pitch вокала (CREPE) — обёртка над extract_reference."""

    def extract(self, vocals: Path, out_json: Path | None = None) -> dict:
        return extract_reference(vocals, out_json)

    def close(self) -> None:
        """Пустить VRAM после CREPE (вызывается пайплайном между шагами)."""
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass
        import gc
        gc.collect()


class PitchScorer:
    """Скоринг исполнения — обёртка над score_performance (бывшие score_performance/midi_from_file)."""

    def score(self, ref_pitch: dict | Path, mic_wav: Path, offset: float = 0.0) -> dict:
        return score_performance(ref_pitch, mic_wav, offset)
