"""
Speech-to-lyrics with word timestamps via faster-whisper (CTranslate2 + CUDA).
Вход: vocals.wav (после Demucs) — так точнее, чем по миксу.
Запуск — класс Transcriber (модель кэшируется на время жизни экземпляра),
его держит KaraokePipeline и переиспользует между джобами.
"""
from __future__ import annotations

import gc
import logging
from pathlib import Path

log = logging.getLogger(__name__)


def fmt_lrc_time(sec: float) -> str:
    m = int(sec // 60)
    s = sec - m * 60
    return f"[{m:02d}:{s:05.2f}]"


def r3(v: float) -> float:
    return round(float(v), 3)


def normalize_words(words: list[dict], seg_s: float, seg_e: float) -> list[dict]:
    """Границы слов в мс: внутри сегмента, монотонно, без инверсий.

    Whisper иногда выдаёт налезающие друг на друга слова — чиним минимально,
    никого не удаляя и не меняя порядок.
    Нулевые слова (s == e) оставляем как есть — это точки, а не баг.
    """
    seg_s = round(float(seg_s), 3)
    seg_e = round(float(seg_e), 3)
    out = []
    prev = seg_s
    for w in words:
        s = r3(max(seg_s, min(float(w.get("s", seg_s)), seg_e)))
        e = r3(max(seg_s, min(float(w.get("e", seg_e)), seg_e)))
        s = max(s, prev)
        if e < s:
            e = min(seg_e, r3(s + 0.03))
            if e < s:
                e = s
        out.append({**w, "s": s, "e": e})
        prev = e
    return out


class Transcriber:
    """faster-whisper: экземпляр = одна загруженная модель (повторные джобы без перезагрузки)."""

    def __init__(self, model: str = "large-v3", device: str = "cuda",
                 compute: str = "float16", vad: bool = True):
        self.model_name = model
        self.device = device
        self.compute = compute
        self.vad = vad
        self._model = None
        self._resolved: tuple[str, str] | None = None

    def _ensure(self):
        if self._model is None:
            from faster_whisper import WhisperModel
            device, compute = self.device, self.compute
            if device == "cuda":
                try:
                    import torch
                    if not torch.cuda.is_available():
                        log.warning("CUDA нет, перехожу на cpu/int8")
                        device, compute = "cpu", "int8"
                except ImportError:
                    pass
            log.info("model=%s device=%s compute=%s vad=%s",
                     self.model_name, device, compute, self.vad)
            self._model = WhisperModel(self.model_name, device=device, compute_type=compute)
            self._resolved = (device, compute)
        return self._model

    def transcribe(self, audio: Path, lang: str | None = None) -> dict:
        """{language, segments: [{start, end, text, words}]}."""
        model = self._ensure()
        language = None if lang in (None, "", "auto") else lang
        segments_iter, info = model.transcribe(
            str(audio),
            language=language,
            word_timestamps=True,
            vad_filter=self.vad,
            vad_parameters=dict(min_silence_duration_ms=500),
            beam_size=5,
            condition_on_previous_text=False,  # меньше "залипаний" на песнях
        )
        log.info("detected language: %s p=%.2f", info.language, info.language_probability)

        segments = []
        for seg in segments_iter:
            words = []
            if seg.words:
                for w in seg.words:
                    words.append({"w": w.word.strip(), "s": w.start, "e": w.end,
                                  "p": round(float(w.probability), 3)})
            seg_s, seg_e = r3(seg.start), r3(seg.end)
            words = normalize_words(words, seg_s, seg_e)
            segments.append({"start": seg_s, "end": seg_e,
                             "text": seg.text.strip(), "words": words})
            log.debug("[%7.2f->%7.2f] %s", seg.start, seg.end, seg.text.strip())
        return {"language": info.language, "segments": segments}

    def close(self) -> None:
        """Выгрузить модель (VRAM), если она грузилась."""
        if self._model is None:
            return
        self._model = None
        self._resolved = None
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass
