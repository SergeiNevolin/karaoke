"""Общие пути, константы и лимиты бэкенда. Импортов внутрь пакета нет."""
from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
MUSIC = ROOT / "music"
STORE = ROOT / "data" / "songs"
DATA_PUBLIC = ROOT / "data" / "public" / "songs"
DIST = ROOT / "web" / "dist"

# GPU-микросервис. Пусто — считаем локально на этой машине.
KARAOKE_ML_SERVICE_URL = os.environ.get("KARAOKE_ML_SERVICE_URL", "http://127.0.0.1:8001").strip()

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

#: секрет JWT bebradio (HS256) для входа через /karaoke. Пусто — авторизация выключена.
AUTH_JWT_SECRET = os.environ.get("AUTH_JWT_SECRET", "").strip()


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


def validate_config() -> None:
    """Fail-fast на старте: плохой env лучше убить контейнер, чем удивлять в рантайме."""
    errors = []
    if MAX_UPLOAD_MB < 1:
        errors.append(f"MAX_UPLOAD_MB={MAX_UPLOAD_MB} — ждём целое >= 1")
    if MAX_BUNDLE_MB < 1:
        errors.append(f"MAX_BUNDLE_MB={MAX_BUNDLE_MB} — ждём целое >= 1")
    url = urlparse(KARAOKE_ML_SERVICE_URL)
    if url.scheme not in ("http", "https") or not url.netloc:
        errors.append(
            f"KARAOKE_ML_SERVICE_URL={KARAOKE_ML_SERVICE_URL!r} — ждём http(s)://host[:port]")
    if LOG_LEVEL not in {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG", "NOTSET"}:
        errors.append(f"LOG_LEVEL={LOG_LEVEL!r} — нет такого уровня")
    if errors:
        raise ValueError("Плохая конфигурация karaoke_api: " + "; ".join(errors))


#: предел размера загружаемого файла
MAX_UPLOAD_MB = _int_env("MAX_UPLOAD_MB", 1024)
#: предел распакованного бандла GPU-сервиса
MAX_BUNDLE_MB = _int_env("MAX_BUNDLE_MB", 2048)
#: пауза между опросами GPU-статуса
POLL_INTERVAL_SEC = _float_env("POLL_INTERVAL_SEC", 3.0)
#: предел жизни одной задачи в пайплайне (защита от вечного running)
JOB_TIMEOUT_SEC = _float_env("JOB_TIMEOUT_SEC", 7200.0)
#: как долго завершённые задачи отдаются API (потом вычищаются)
JOB_TTL_SEC = _float_env("JOB_TTL_SEC", 3600.0)
#: таймаут HTTP-запроса к Genius
GENIUS_TIMEOUT_SEC = _int_env("GENIUS_TIMEOUT_SEC", 20)
#: предел размера HTML-страницы Genius
MAX_HTML_BYTES = 5 * 1024 * 1024
#: пределы полей формы загрузки
MAX_LYRICS_TEXT = 20000
MAX_LYRICS_URL = 500

ALLOWED_EXT = {".mp3", ".wav", ".flac", ".m4a", ".ogg",
               ".mp4", ".mov", ".mkv", ".webm"}
ALLOWED_LANG = {"ru", "en", ""}

STAGE_LABELS = {
    "queued": "В очереди",
    "separation": "Отделяю вокал (GPU)",
    "lyrics": "Распознаю текст (GPU)",
    "pitch": "Строю эталон тона",
    "export": "Готовлю файлы для плеера",
    "done": "Готово",
    "error": "Ошибка",
}
