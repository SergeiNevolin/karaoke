"""Каталог и текст песен + отдача статики из бакета (/songs/* c Range)."""
from __future__ import annotations

import logging
import mimetypes
from email.utils import formatdate

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

from .. import silo
from ..errors import ApiError
from ..schemas import LyricsPut, SongMetaPut
from ..store.publish import publish_one
from ..store.songs import build_manifest, check_owner, delete_song, read_lyrics, read_meta, save_lyrics, set_song_meta

log = logging.getLogger(__name__)

router = APIRouter()

_NOT_FOUND = JSONResponse({"detail": "Not Found"}, status_code=404)
_CHUNK = 64 * 1024


@router.get("/api/songs")
async def songs() -> dict:
    return await run_in_threadpool(build_manifest)


@router.get("/api/songs/{sid}/lyrics")
async def song_lyrics(sid: str) -> dict:
    data = await run_in_threadpool(read_lyrics, sid)
    if data is None:
        raise ApiError(404, "Песня не найдена")
    return data


@router.put("/api/songs/{sid}/lyrics")
async def song_lyrics_put(sid: str, request: Request, body: LyricsPut) -> dict:
    sub = getattr(request.state, "sub", None)
    if check_owner(sid, sub) is None:
        if not (await run_in_threadpool(read_meta, sid)):
            raise ApiError(404, "Песня не найдена")
        raise ApiError(403, "Править может только загрузивший песню")
    try:
        saved = await run_in_threadpool(save_lyrics, sid, body.model_dump())
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


@router.put("/api/songs/{sid}/meta")
async def song_meta_put(sid: str, request: Request, body: SongMetaPut) -> dict:
    """Обновить название и автора. Только владелец (легаси без владельца — любой вошедший)."""
    sub = getattr(request.state, "sub", None)
    if check_owner(sid, sub) is None:
        if not (await run_in_threadpool(read_meta, sid)):
            raise ApiError(404, "Песня не найдена")
        raise ApiError(403, "Править может только загрузивший песню")
    try:
        meta = await run_in_threadpool(set_song_meta, sid, body.title, body.artist)
    except KeyError:
        raise ApiError(404, "Песня не найдена") from None
    except ValueError as e:
        raise ApiError(400, str(e)) from e
    try:
        await run_in_threadpool(publish_one, sid)
    except Exception:
        log.exception("паблиш %s упал после сохранения меты", sid)
    return {"ok": True, "title": meta.get("title"), "artist": meta.get("artist")}


@router.delete("/api/songs/{sid}")
async def song_delete(sid: str, request: Request) -> dict:
    """Удалить песню целиком. Только владелец (легаси без владельца — любой вошедший)."""
    sub = getattr(request.state, "sub", None)
    if check_owner(sid, sub) is None:
        if not (await run_in_threadpool(read_meta, sid)):
            raise ApiError(404, "Песня не найдена")
        raise ApiError(403, "Удалить может только загрузивший песню")
    ok = await run_in_threadpool(delete_song, sid)
    if not ok:
        raise ApiError(404, "Песня не найдена")
    return {"ok": True}


def _content_type(rel: str) -> str:
    return mimetypes.guess_type(rel)[0] or "application/octet-stream"


@router.api_route("/songs/{rel:path}", methods=["GET", "HEAD"])
async def song_static(rel: str, request: Request):
    """Статика песен из бакета: Range обязателен — без него плеер не перематывает."""
    key = f"songs/{rel}"

    if request.method == "HEAD":
        h = await run_in_threadpool(silo.head, key)
        if h is None:
            return _NOT_FOUND
        return Response(status_code=200, headers=_base_headers(rel, h))

    try:
        obj = await run_in_threadpool(silo.open_stream, key, request.headers.get("range"))
    except silo.InvalidRange as e:
        return Response(status_code=416, headers={
            "Content-Range": f"bytes */{e.size}",
            "Accept-Ranges": "bytes",
        })
    if obj is None:
        return _NOT_FOUND

    headers = _base_headers(rel, None)
    headers["Content-Length"] = str(obj["ContentLength"])
    if obj.get("ContentRange"):
        headers["Content-Range"] = obj["ContentRange"]
    if obj.get("ETag"):
        headers["ETag"] = obj["ETag"]
    if obj.get("LastModified"):
        headers["Last-Modified"] = formatdate(obj["LastModified"].timestamp(), usegmt=True)
    status = 206 if obj.get("ContentRange") else 200

    body = obj["Body"]

    def iterate():
        try:
            while chunk := body.read(_CHUNK):
                yield chunk
        finally:
            body.close()

    return StreamingResponse(iterate(), status_code=status, headers=headers)


def _base_headers(rel: str, head: dict | None) -> dict:
    headers = {
        "Content-Type": _content_type(rel),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
    }
    if head is not None:
        headers["Content-Length"] = str(head["size"])
        if head.get("etag"):
            headers["ETag"] = f'"{head["etag"]}"'
        if head.get("last_modified"):
            headers["Last-Modified"] = formatdate(
                head["last_modified"].timestamp(), usegmt=True)
    return headers
