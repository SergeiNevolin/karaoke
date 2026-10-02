"""Каталог и текст песен: всё поверх store (data/songs)."""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter
from starlette.concurrency import run_in_threadpool

from ..config import DATA_PUBLIC, STORE
from ..errors import ApiError
from ..schemas import LyricsPut
from ..store.publish import publish_one
from ..store.songs import all_ids, build_manifest, read_lyrics, save_lyrics

log = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/songs")
async def songs() -> dict:
    if await run_in_threadpool(all_ids, STORE):
        return await run_in_threadpool(build_manifest, STORE)
    mp = DATA_PUBLIC / "manifest.json"
    if not mp.exists():
        return {"songs": []}
    return json.loads(mp.read_text(encoding="utf-8"))


@router.get("/api/songs/{sid}/lyrics")
async def song_lyrics(sid: str) -> dict:
    data = await run_in_threadpool(read_lyrics, STORE, sid)
    if data is None:
        raise ApiError(404, "Песня не найдена")
    return data


@router.put("/api/songs/{sid}/lyrics")
async def song_lyrics_put(sid: str, body: LyricsPut) -> dict:
    try:
        saved = await run_in_threadpool(save_lyrics, STORE, sid, body.model_dump())
    except KeyError:
        raise ApiError(404, "Песня не найдена") from None
    except ValueError as e:
        raise ApiError(400, str(e)) from e
    lines = len(saved["segments"])
    try:
        await run_in_threadpool(publish_one, sid)
    except Exception:
        # данные сохранены — это не ошибка запроса; логируем и предупреждаем
        log.exception("паблиш %s упал после сохранения", sid)
        return {"ok": True, "lines": lines, "warning": "Сохранено, но паблиш упал"}
    return {"ok": True, "lines": lines}
