"""
GPU-микросервис: ВЕСЬ пайплайн «аудио -> караоке» на машине с видеокартой.

Запуск на GPU-боксе:
  uvicorn karaoke_ml_service.app:app --host 0.0.0.0 --port 8001

Job API (бэкенд только сабмитит и поллит статус):
  POST /v1/jobs {file, lang, lyrics_text} -> {job_id}
  GET  /v1/jobs/{id} -> {state, stage, progress, error?}
  GET  /v1/jobs/{id}/result -> zip {vocals.wav, minus.wav, minus.mp3,
                                    vocals.mp3, original.mp3, lyrics.json, pitch.json}
  GET  /v1/info -> {demucs, whisper, pitch}: чем реально считаем
  POST /v1/pitch -> {t, midi, conf} (пошаговый перегон, для rebuild_pitch)

Шаги — классы core/ (VocalSeparator/Transcriber/PitchExtractor), оркестратор —
pipeline.KaraokePipeline. Модели живут только здесь (максимум качества).
Результат — zip на диске (каталог джобы), чистится по RESULT_TTL_SEC.
Стадии/прогресс — config.STAGE_PROGRESS (ключи синхронны с karaoke_api.config.STAGE_LABELS).
Одна GPU — один пайплайн разом: второй сабмит получает 429.
"""
from __future__ import annotations

import json
import logging
import shutil
import tempfile
import threading
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import FileResponse

from .config import (
    ALLOWED_EXT,
    ALLOWED_LANG,
    JOBS_DIR,
    LOG_LEVEL,
    MAX_LYRICS_TEXT,
    MAX_UPLOAD_MB,
    PITCH_MODEL,
    RESULT_TTL_SEC,
    SEPARATION_MODEL,
    VIDEO_EXT,
    WHISPER_MODEL,
)
from .core.pitch import PitchExtractor
from .errors import ApiError, install_error_handlers
from .jobs import Job, JobRegistry
from .pipeline import KaraokePipeline, encode_mp3

log = logging.getLogger(__name__)
logging.basicConfig(level=LOG_LEVEL,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")

#: «одна GPU — один пайплайн»: сабмит без свободного семафора -> 429
_gpu_lock = threading.Lock()
registry = JobRegistry(root=JOBS_DIR, ttl_sec=RESULT_TTL_SEC)

CHUNK = 1024 * 1024


@asynccontextmanager
async def lifespan(_app: FastAPI):
    registry.wipe()  # после рестарта прошлые джобы не живут — вычищаем осиротевшие каталоги
    yield


app = FastAPI(title="Karaoke GPU", lifespan=lifespan)
install_error_handlers(app)


def make_pipeline() -> KaraokePipeline:
    """Фабрика пайплайна на задачу (тесты подменяют шаги здесь)."""
    return KaraokePipeline()


def make_pitch_extractor() -> PitchExtractor:
    """Фабрика для /v1/pitch (тесты подменяют здесь)."""
    return PitchExtractor()


async def _save_upload(file: UploadFile, dest: Path) -> None:
    """Чанками на диск, лимит MAX_UPLOAD_MB (лишнее не держим в памяти)."""
    limit = MAX_UPLOAD_MB * 1024 * 1024
    total = 0
    with open(dest, "wb") as out:
        while chunk := await file.read(CHUNK):
            total += len(chunk)
            if total > limit:
                raise ApiError(413, f"Файл больше {MAX_UPLOAD_MB} МБ")
            out.write(chunk)
    if total == 0:
        raise ApiError(400, "Пустой файл")


def _write_bundle(zip_path: Path, result: dict) -> None:
    """Бандл: wav + mp3 (кодирует тут же, ffmpeg есть только у нас) + JSON."""
    for key, suffix in (("vocals", ".wav"), ("minus", ".wav"), ("original", "")):
        if key not in result or not Path(result[key]).is_file():
            raise RuntimeError(f"пайплайн не вернул {key}{suffix}")
    with tempfile.TemporaryDirectory(prefix="karaoke-mp3-") as td:
        mp3s: dict[str, Path] = {}
        for key in ("minus", "vocals", "original"):
            dst = Path(td) / f"{key}.mp3"
            encode_mp3(Path(result[key]), dst)
            mp3s[key] = dst
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(result["vocals"], "vocals.wav")
            z.write(result["minus"], "minus.wav")
            for key, path in mp3s.items():
                z.write(path, f"{key}.mp3")
            z.writestr("lyrics.json", json.dumps(
                {"language": result["lyrics"].get("language"),
                 "segments": result["lyrics"].get("segments", [])},
                ensure_ascii=False))
            z.writestr("pitch.json", json.dumps(result["pitch"]))


def _run_job(job: Job) -> None:
    """Воркер-поток: пайплайн -> бандл на диск -> ровно один release семафора."""
    try:
        job.work.mkdir(parents=True, exist_ok=True)
        result = make_pipeline().run(
            job.src, job.work, lang=job.lang, text=job.text,
            on_stage=lambda stage, progress: registry.update(
                job.id, stage=stage, progress=progress))
        zip_path = job.dir / "bundle.zip"
        _write_bundle(zip_path, result)
        job.src.unlink(missing_ok=True)          # вход больше не нужен
        shutil.rmtree(job.work, ignore_errors=True)
        registry.update(job.id, state="done", stage="done", progress=100,
                        result_path=zip_path)
        log.info("задача %s готова: %s", job.id, zip_path.name)
    except Exception as e:
        log.exception("задача %s упала", job.id)
        registry.update(job.id, state="error", stage="error", error=str(e))
    finally:
        _gpu_lock.release()


@app.post("/v1/jobs")
async def submit(file: UploadFile = File(...),
                 lang: str = Form("ru"),
                 lyrics_text: str = Form("")) -> dict:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise ApiError(400, f"нужно аудио/видео, а не {ext or '???'}")
    if lang not in ALLOWED_LANG:
        raise ApiError(400, f"lang: допустимы {sorted(ALLOWED_LANG)}")
    if len(lyrics_text) > MAX_LYRICS_TEXT:
        raise ApiError(400, f"lyrics_text длиннее {MAX_LYRICS_TEXT} символов")
    if not _gpu_lock.acquire(blocking=False):
        raise ApiError(429, "GPU занят другим пайплайном")

    job: Job | None = None
    try:
        job = registry.create(filename=Path(file.filename or "audio").name,
                              suffix=ext, lang=lang, text=lyrics_text)
        await _save_upload(file, job.src)
    except BaseException:
        if job is not None:
            registry.drop(job.id)
        _gpu_lock.release()
        raise
    try:
        threading.Thread(target=_run_job, args=(job,), daemon=True).start()
    except BaseException:
        registry.drop(job.id)
        _gpu_lock.release()
        raise
    return {"job_id": job.id}


@app.get("/v1/jobs/{job_id}")
async def job_status(job_id: str) -> dict:
    job = registry.get(job_id)
    if job is None:
        raise ApiError(404, "Задача не найдена")
    return job.public()


@app.get("/v1/jobs/{job_id}/result")
async def job_result(job_id: str):
    job = registry.get(job_id)
    if (job is None or job.state != "done" or job.result_path is None
            or not job.result_path.is_file()):
        raise ApiError(404, "Результат не готов")
    return FileResponse(job.result_path, media_type="application/zip",
                        filename="bundle.zip")


@app.get("/v1/info")
async def info() -> dict:
    """Чем реально считаем (для meta.pipeline на бэкенде)."""
    return {"demucs": SEPARATION_MODEL, "whisper": WHISPER_MODEL, "pitch": PITCH_MODEL}


@app.post("/v1/pitch")
async def pitch(file: UploadFile = File(...)) -> dict:
    """Пошаговый pitch (rebuild_pitch): {t, midi, conf}, без семафора пайплайна."""
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT - VIDEO_EXT:
        raise ApiError(400, f"нужно аудио, а не {ext or '???'}")
    suffix = ext
    with tempfile.TemporaryDirectory(prefix="karaoke-pitch-") as td:
        src = Path(td) / f"vocals{suffix}"
        await _save_upload(file, src)
        extractor = make_pitch_extractor()
        try:
            data = extractor.extract(src)
        finally:
            extractor.close()
    if not isinstance(data.get("t"), list) or not isinstance(data.get("midi"), list):
        raise ApiError(500, "pitch: нет t/midi в ответе")
    return data
