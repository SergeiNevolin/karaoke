"""
Караоке-бэкенд: приём песен через интерфейс + GPU-пайплайн в фоне.

Канон данных — data/songs/<id>/ (см. karaoke_api.store.songs).
Роуты — karaoke_api.api.*, очередь — karaoke_api.worker.

Запуск:
  uvicorn karaoke_api.app:app --port 8000
"""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import worker
from .api import jobs as jobs_routes
from .api import songs as songs_routes
from .auth import install_auth
from .config import DATA_PUBLIC, DIST, LOG_LEVEL, validate_config
from .errors import install_error_handlers

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    worker.start()
    try:
        yield
    finally:
        worker.stop()


def create_app() -> FastAPI:
    validate_config()
    logging.basicConfig(
        level=LOG_LEVEL,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    application = FastAPI(title="Karaoke API", lifespan=lifespan)
    install_error_handlers(application)
    install_auth(application)
    application.include_router(songs_routes.router)
    application.include_router(jobs_routes.router)

    @application.get("/healthz")
    async def healthz() -> dict[str, bool]:
        return {"ok": True}

    @application.middleware("http")
    async def request_log(request, call_next):
        start = time.perf_counter()
        response = await call_next(request)
        path = request.url.path
        if path != "/healthz" and not path.startswith("/assets"):
            log.info("%s %s -> %s %.0fms", request.method, path, response.status_code,
                     (time.perf_counter() - start) * 1000)
        return response

    # volume на первом старте может быть пустым: монтируем всегда, иначе
    # статика песен «повиснет» до рестарта контейнера
    DATA_PUBLIC.mkdir(parents=True, exist_ok=True)
    application.mount("/songs", StaticFiles(directory=str(DATA_PUBLIC)), name="songs")
    if DIST.exists():
        application.mount("/", StaticFiles(directory=str(DIST), html=True), name="front")
    return application


app = create_app()
