"""Оркестрация шагов пайплайна: separation -> lyrics -> pitch (классы core/, не subprocess)."""
from __future__ import annotations

import logging
import shutil
import subprocess
import threading
from pathlib import Path

from .config import (
    ALIGN_ENABLED,
    ALIGN_MIN_CONF,
    ALIGN_MODEL,
    ALIGN_WINDOW_SEC,
    KEEP_WHISPER,
    SEPARATION_MODEL,
    STAGE_PROGRESS,
    VIDEO_EXT,
    WHISPER_MODEL,
)
from .core.align import WordAligner
from .core.lyrics import apply_text_to_segments, clean_lines
from .core.pitch import PitchExtractor
from .core.separate import VocalSeparator
from .core.transcribe import Transcriber

log = logging.getLogger(__name__)

_whisper_lock = threading.Lock()
_shared_transcriber: Transcriber | None = None


def shared_transcriber() -> Transcriber:
    """Одна модель whisper на весь процесс: повторные джобы без перезагрузки large-v3."""
    global _shared_transcriber
    with _whisper_lock:
        if _shared_transcriber is None:
            _shared_transcriber = Transcriber(model=WHISPER_MODEL)
        return _shared_transcriber


class PipelineError(RuntimeError):
    pass


def demux(src: Path, dst: Path) -> None:
    """Видео -> wav. ffmpeg — внешний бинарник, остаётся subprocess."""
    if not shutil.which("ffmpeg"):
        raise PipelineError("ffmpeg не найден, видео не обработать")
    log.info("демультиплекс %s -> %s", src.name, dst.name)
    r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src),
                        "-vn", "-ar", "44100", "-ac", "2", str(dst)])
    if r.returncode != 0 or not dst.is_file():
        raise PipelineError("ffmpeg не смог извлечь аудиодорожку")


def encode_mp3(src: Path, dst: Path, quality: str = "4") -> None:
    """mp3 для бандла (-q:a 4 ~= VBR 165kbps). Кодирует ТОЛЬКО GPU-сервис —
    в karaoke_api ffmpeg нет, задача без mp3 там упадёт при публикации."""
    if not shutil.which("ffmpeg"):
        raise PipelineError("ffmpeg не найден, mp3 не закодировать")
    log.info("mp3 %s -> %s", src.name, dst.name)
    r = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(src), "-vn",
         "-codec:a", "libmp3lame", "-q:a", quality, str(dst)])
    if r.returncode != 0 or not dst.is_file():
        raise PipelineError(f"ffmpeg не смог закодировать {dst.name}")


class KaraokePipeline:
    """Один прогон: владеет созданными шагами, Demucs/CREPE выгружает между шагами."""

    def __init__(self, *, separator=None, transcriber=None, pitch_extractor=None,
                 aligner=None, keep_whisper: bool | None = None,
                 enable_align: bool | None = None):
        self._sep = separator
        self._transcriber = transcriber
        self._pitch = pitch_extractor
        self._aligner = aligner
        self.keep_whisper = KEEP_WHISPER if keep_whisper is None else keep_whisper
        self.enable_align = ALIGN_ENABLED if enable_align is None else enable_align

    def run(self, src: Path, work: Path, *, lang: str = "", text: str = "",
            on_stage=None) -> dict:
        """{vocals, minus, original, lyrics, pitch}; on_stage(stage, progress) — границы этапов."""
        report = on_stage or (lambda stage, progress: None)
        work.mkdir(parents=True, exist_ok=True)
        audio = self._to_audio(src, work)

        report("separation", STAGE_PROGRESS["separation"][0])
        vocals, minus = self._separate(audio, work)
        report("separation", STAGE_PROGRESS["separation"][1])

        report("lyrics", STAGE_PROGRESS["lyrics"][0])
        lyrics = self._transcribe(vocals, lang=lang, text=text)
        report("lyrics", STAGE_PROGRESS["lyrics"][1])

        report("pitch", STAGE_PROGRESS["pitch"][0])
        pitch = self._pitch_of(vocals)
        report("pitch", STAGE_PROGRESS["pitch"][1])

        report("export", STAGE_PROGRESS["export"][0])
        # original — полная песня: путь к demux-входу (для аудио — сам src),
        # по нему в бандл кодируется original.mp3 для редактора
        return {"vocals": vocals, "minus": minus, "original": str(audio),
                "lyrics": lyrics, "pitch": pitch}

    def _to_audio(self, src: Path, work: Path) -> Path:
        if src.suffix.lower() not in VIDEO_EXT:
            return src
        wav = work / "in.wav"
        demux(src, wav)
        return wav

    def _separate(self, audio: Path, work: Path) -> tuple[Path, Path]:
        owned = self._sep is None
        sep = self._sep if self._sep is not None else VocalSeparator(model=SEPARATION_MODEL)
        try:
            return sep.separate(audio, work / "separated")
        finally:
            if owned:
                sep.close()

    def _transcribe(self, vocals: Path, *, lang: str, text: str) -> dict:
        if self._transcriber is not None:
            tr, owned = self._transcriber, False
        elif self.keep_whisper:
            tr, owned = shared_transcriber(), False  # кэш процесса — не закрываем
        else:
            tr, owned = Transcriber(model=WHISPER_MODEL), True
        try:
            data = tr.transcribe(vocals, lang=lang)
            data = self._refine_timing(vocals, data, lang=lang)
            if text.strip():
                segments, stats = apply_text_to_segments(
                    data.get("segments", []), clean_lines(text))
                data = {"language": data.get("language"), "segments": segments}
                log.info("наложение своего текста: %s", stats)
            return data
        finally:
            if owned:
                tr.close()

    def _refine_timing(self, vocals: Path, data: dict, *, lang: str) -> dict:
        """Второй проход таймингов (forced alignment) внутри стадии lyrics.

        Отдельного ключа стадий нет — фронт видит те же STAGE_PROGRESS.
        Любая ошибка алайнера -> whisper-тайминги как есть (не роняем задачу).
        """
        if not self.enable_align:
            return data
        segments = data.get("segments", []) or []
        if not segments:
            return data
        if self._aligner is not None:
            try:
                data = {**data, "segments": self._aligner.align(vocals, segments, lang=lang)}
            except Exception:
                log.exception("инжектированный алайнер упал, оставляю whisper")
            return data
        aligner = WordAligner(model=ALIGN_MODEL, snap_window=ALIGN_WINDOW_SEC,
                              min_conf=ALIGN_MIN_CONF)
        try:
            data = {**data, "segments": aligner.align(vocals, segments, lang=lang)}
        except Exception:
            log.exception("align упал, оставляю whisper-тайминги")
        finally:
            aligner.close()
        return data

    def _pitch_of(self, vocals: Path) -> dict:
        owned = self._pitch is None
        px = self._pitch if self._pitch is not None else PitchExtractor()
        try:
            return px.extract(vocals)
        finally:
            if owned:
                px.close()
