"""
Vocal / accompaniment separation via Demucs (htdemucs_ft — лучшее качество).
Запуск — класс VocalSeparator (demucs.api, без subprocess): шаг пайплайна сервиса.
"""
from __future__ import annotations

import gc
import logging
from pathlib import Path

log = logging.getLogger(__name__)

ALLOWED_MODELS = {"htdemucs_ft", "htdemucs", "htdemucs_6s", "hdemucs_mmi"}


def _load_deps():
    """demucs/torch подтягиваются только при реальном разделении (тесты подменяют вход)."""
    from demucs.api import Separator, save_audio
    return Separator, save_audio


def _pick_device(device: str) -> str:
    if device != "cuda":
        return device
    try:
        import torch
    except ImportError:
        log.warning("torch не найден, demucs сам выберет устройство")
        return device
    if not torch.cuda.is_available():
        log.warning("torch.cuda недоступен, переключаюсь на CPU (будет очень медленно)")
        return "cpu"
    log.info("GPU: %s", torch.cuda.get_device_name(0))
    return device


class VocalSeparator:
    """Demucs: (vocals, минус); минус — сумма остальных стемов (бывший --two-stems vocals)."""

    def __init__(self, model: str = "htdemucs_ft", device: str = "cuda",
                 shifts: int = 1, overlap: float = 0.25):
        if model not in ALLOWED_MODELS:
            raise ValueError(f"model: {', '.join(sorted(ALLOWED_MODELS))}")
        self.model = model
        self.device = device
        self.shifts = shifts
        self.overlap = overlap
        self._sep = None
        self._save_audio = None

    def _ensure(self):
        if self._sep is None:
            separator_cls, save_audio = _load_deps()
            self._save_audio = save_audio
            self._sep = separator_cls(
                model=self.model, device=_pick_device(self.device),
                shifts=self.shifts, overlap=self.overlap, progress=False,
            )
        return self._sep

    def separate(self, src: Path, out_dir: Path) -> tuple[Path, Path]:
        """Разделить файл -> (out_dir/vocals.wav, out_dir/minus.wav)."""
        sep = self._ensure()
        _origin, sources = sep.separate_audio_file(Path(src))
        if "vocals" not in sources:
            raise RuntimeError(f"Demucs не вернул стем vocals: {sorted(sources)}")
        minus = None
        for name, tensor in sources.items():
            if name == "vocals":
                continue
            minus = tensor if minus is None else minus + tensor
        if minus is None:
            raise RuntimeError("Demucs не вернул стемов кроме vocals")
        out_dir.mkdir(parents=True, exist_ok=True)
        vocals_p = out_dir / "vocals.wav"
        minus_p = out_dir / "minus.wav"
        self._save_audio(sources["vocals"].detach().cpu(), str(vocals_p),
                         samplerate=sep.samplerate)
        self._save_audio(minus.detach().cpu(), str(minus_p), samplerate=sep.samplerate)
        log.info("разделил %s -> %s", src.name, out_dir)
        return vocals_p, minus_p

    def close(self) -> None:
        """Выгрузить модель (VRAM ~12 ГБ)."""
        if self._sep is None:
            return
        self._sep = None
        self._save_audio = None
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass
