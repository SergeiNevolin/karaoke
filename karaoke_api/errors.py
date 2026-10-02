"""Единая ошибка API: тело {"error": ...} + честный HTTP-статус."""
from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

log = logging.getLogger(__name__)


class ApiError(Exception):
    """Ожидаемая ошибка запроса: клиенту уходит message, статус — свой."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _validation_message(exc: RequestValidationError) -> str:
    parts = []
    for e in exc.errors()[:3]:
        loc = ".".join(str(x) for x in e.get("loc", ())[1:]) or "тело"
        parts.append(f"{loc}: {e.get('msg', 'ошибка валидации')}")
    return "; ".join(parts)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse({"error": exc.message}, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse({"error": _validation_message(exc)}, status_code=400)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("необработанная ошибка: %s %s", request.method, request.url.path)
        return JSONResponse({"error": "Внутренняя ошибка сервера"}, status_code=500)
