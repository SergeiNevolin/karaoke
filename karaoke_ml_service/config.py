"""Конфиг GPU-микросервиса: модели, лимиты, стадии. Сервис самодостаточен (не импортирует karaoke_api)."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

SEPARATION_MODEL = "htdemucs_ft"
WHISPER_MODEL = "large-v3"
PITCH_MODEL = "crepe"
#: CTC-алайнер слов (второй проход таймингов после Whisper).
#: Мультиязычный XLSR с русской доводкой: русские слова тянет точно,
#: латиницу покрывает тем же словарём. Перекрывается env ALIGN_MODEL.
ALIGN_MODEL = os.environ.get(
    "ALIGN_MODEL", "jonatasgrosman/wav2vec2-large-xlsr-53-russian")

# Синк с karaoke_api/config.ALLOWED_EXT: общий импорт тянул бы сервер в GPU-образ ради трёх строк.
ALLOWED_EXT = {".mp3", ".wav", ".flac", ".m4a", ".ogg",
               ".mp4", ".mov", ".mkv", ".webm"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm"}
ALLOWED_LANG = {"ru", "en", "", "auto"}


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


#: предел размера загружаемого файла
MAX_UPLOAD_MB = _int_env("MAX_UPLOAD_MB", 1024)
#: предел пользовательского текста (лимит формы)
MAX_LYRICS_TEXT = _int_env("MAX_LYRICS_TEXT", 20000)
#: как долго результат лежит на диске, потом вычищается
RESULT_TTL_SEC = _float_env("RESULT_TTL_SEC", 3600.0)
#: кэшировать whisper large-v3 на всё время процесса (главный выигрыш повторных джоб)
KEEP_WHISPER = os.environ.get("KEEP_WHISPER", "1").lower() not in ("0", "false", "no")
#: второй проход таймингов слов (CTC + onset-снап внутри стадии lyrics,
#: отдельного ключа стадий нет — см. STAGE_PROGRESS). 0 — оставить whisper как есть
ALIGN_ENABLED = os.environ.get("ALIGN_ENABLED", "1").lower() not in ("0", "false", "no")
#: окно onset-снапа вокруг начала слова (сек). Whisper спешит — тянем вперёд
ALIGN_WINDOW_SEC = _float_env("ALIGN_WINDOW_SEC", 0.25)
#: ниже этой уверенности CTC слово дополнительно тянется к onset'у
ALIGN_MIN_CONF = _float_env("ALIGN_MIN_CONF", 0.3)
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

#: каталог задач (каждая джоба — свой подкаталог с результатом)
JOBS_DIR = Path(os.environ.get("KARAOKE_JOBS_DIR")
                or Path(tempfile.gettempdir()) / "karaoke-jobs")

#: стадии: ключи синхронны с karaoke_api.config.STAGE_LABELS;
#: значение — (progress в начале этапа, progress в конце)
STAGE_PROGRESS: dict[str, tuple[int, int]] = {
    "queued": (0, 0),
    "separation": (2, 60),
    "lyrics": (62, 85),
    "pitch": (87, 92),
    "export": (94, 100),
}
FINAL_STAGE = "done"
FINAL_PROGRESS = 100
