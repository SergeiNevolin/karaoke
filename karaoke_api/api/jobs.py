"""Загрузка песен и статусы задач."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile
from starlette.concurrency import run_in_threadpool

from .. import minio, worker
from ..config import (
    ALLOWED_EXT,
    ALLOWED_LANG,
    GENIUS_TIMEOUT_SEC,
    MAX_LYRICS_TEXT,
    MAX_LYRICS_URL,
    MAX_UPLOAD_MB,
    SCRATCH,
    STAGE_LABELS,
)
from ..errors import ApiError
from ..utils import slug

router = APIRouter()

CHUNK = 1024 * 1024


def _unique_music_key(stem: str, ext: str) -> tuple[str, int]:
    """Свободный ключ исходника: music/stem, music/stem-2, music/stem-3..."""
    taken = set(minio.list_keys("music/"))
    variant = 1
    key = f"music/{stem}{ext}"
    while key in taken:
        variant += 1
        key = f"music/{stem}-{variant}{ext}"
    return key, variant


@router.post("/api/upload")
async def upload(
    file: UploadFile = File(...),
    lang: str = Form("ru"),
    lyrics_text: str = Form(""),
    lyrics_url: str = Form(""),
) -> dict:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise ApiError(400, f"Нужно аудио {sorted(ALLOWED_EXT)}, а не {ext or '???'}")
    if lang not in ALLOWED_LANG:
        lang = "ru"

    title = Path(file.filename or "song").stem.strip() or "Без названия"

    SCRATCH.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(SCRATCH), prefix="upload-", suffix=ext)
    total = 0
    limit = MAX_UPLOAD_MB * 1024 * 1024
    try:
        with os.fdopen(fd, "wb") as out:
            while chunk := await file.read(CHUNK):
                total += len(chunk)
                if total > limit:
                    raise ApiError(413, f"Файл больше {MAX_UPLOAD_MB} МБ")
                out.write(chunk)
        if total == 0:
            raise ApiError(400, "Пустой файл")
    except ApiError:
        os.unlink(tmp_name)
        raise
    except BaseException:
        os.unlink(tmp_name)
        raise

    key, variant = await run_in_threadpool(_unique_music_key, slug(title), ext)
    if variant > 1:
        title = f"{title} ({variant})"
    try:
        await run_in_threadpool(minio.put_file, key, Path(tmp_name))
    finally:
        os.unlink(tmp_name)

    job = worker.submit(
        title=title, audio=key, lang=lang,
        lyrics_text=lyrics_text[:MAX_LYRICS_TEXT], lyrics_url=lyrics_url[:MAX_LYRICS_URL],
    )
    return {"jobId": job.id}


@router.get("/api/jobs/{job_id}")
async def job_status(job_id: str) -> dict:
    job = worker.registry.get(job_id)
    if job is None:
        raise ApiError(404, "Задача не найдена")
    out = job.public()
    out["stageLabel"] = STAGE_LABELS.get(job.stage, job.stage)
    return out


@router.get("/api/lyrics/fetch")
async def lyrics_fetch(url: str) -> dict:
    """Подтянуть текст с Genius по URL (обход CORS — качает сервер)."""
    from ..lyrics import fetch_genius_lines
    try:
        lines = await run_in_threadpool(fetch_genius_lines, url, GENIUS_TIMEOUT_SEC)
        return {"lines": lines}
    except ValueError as e:
        raise ApiError(400, str(e)) from e
    except Exception as e:
        raise ApiError(502, f"Genius недоступен: {e}") from e
