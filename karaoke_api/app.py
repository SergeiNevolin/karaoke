"""
Караоке-бэкенд: приём песен через интерфейс + GPU-пайплайн в фоне.

Канон данных — data/songs/<id>/ (см. karaoke_api.store.songs).
Роуты — karaoke_api.api.*, очередь — karaoke_api.worker.

Запуск:
  uvicorn karaoke_api.app:app --port 8000
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import worker
from .api import jobs as jobs_routes
from .api import songs as songs_routes
from .config import DATA_PUBLIC, DIST, LOG_LEVEL
from .errors import install_error_handlers


@asynccontextmanager
async def lifespan(_app: FastAPI):
    worker.start()
    try:
        yield
    finally:
        worker.stop()


def create_app() -> FastAPI:
    logging.basicConfig(
        level=LOG_LEVEL,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    application = FastAPI(title="Karaoke API", lifespan=lifespan)
    install_error_handlers(application)
    application.include_router(songs_routes.router)
    application.include_router(jobs_routes.router)
    if DATA_PUBLIC.exists():
        application.mount("/songs", StaticFiles(directory=str(DATA_PUBLIC)), name="songs")
    if DIST.exists():
        application.mount("/", StaticFiles(directory=str(DIST), html=True), name="front")
    return application


app = create_app()
