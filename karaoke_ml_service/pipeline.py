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
from .core.custom_align import align_custom_text
from .core.lyrics import clean_lines, sanitize_segments
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
        lyrics = self._sanitize_lyrics(lyrics)
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
            return self._with_alignment(vocals, data, lang=lang, text=text)
        finally:
            if owned:
                tr.close()

    def _get_aligner(self):
        """Инжектированный или свой (свой закрывает вызыватель). Возвращает (aligner, owned)."""
        if self._aligner is not None:
            return self._aligner, False
        return WordAligner(model=ALIGN_MODEL, snap_window=ALIGN_WINDOW_SEC,
                           min_conf=ALIGN_MIN_CONF), True

    def _with_alignment(self, vocals: Path, data: dict, *, lang: str, text: str) -> dict:
        """Тайминги слов + правка слов приложенным текстом (всё внутри стадии lyrics).

        Отдельного ключа стадий нет — фронт видит те же STAGE_PROGRESS.
        Тайминги слов Whisper не меняются; правится только текст слов.
        Любая ошибка -> whisper как есть (задачу не роняем).
        """
        segments = data.get("segments", []) or []
        if not segments or not self.enable_align:
            return data
        lines = clean_lines(text) if text.strip() else []
        aligner, owned_al = self._get_aligner()
        try:
            try:
                data = {**data, "segments": aligner.align(vocals, segments, lang=lang)}
            except Exception:
                log.exception("алайнер слов упал, оставляю whisper")
            if not lines:
                return data
            try:
                out, stats = align_custom_text(data, lines)
            except Exception:
                log.exception("правка слов упала — whisper как есть")
                return data
            log.info("правка слов приложенным текстом: %s", stats)
            return {**data, "segments": out}
        finally:
            if owned_al:
                aligner.close()

    @staticmethod
    def _sanitize_lyrics(data: dict) -> dict:
        """Финальная страховка перед бандлом: чиним/режем битые сегменты.

        Дегенераты [x, x] прилетают из самого Whisper (схлопывание r3),
        из переписанных алайнером границ и из точечных строк — любой из них
        роняет публикацию в бэкенде (validate_lyrics требует end > start).
        """
        segments = data.get("segments", []) or []
        clean, info = sanitize_segments(segments)
        if info["repaired"] or info["dropped"]:
            log.warning("санация сегментов: %s", info)
        return {**data, "segments": clean}

    def _pitch_of(self, vocals: Path) -> dict:
        owned = self._pitch is None
        px = self._pitch if self._pitch is not None else PitchExtractor()
        try:
            return px.extract(vocals)
        finally:
            if owned:
                px.close()
