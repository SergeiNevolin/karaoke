"""Аутентификация: общий с bebradio JWT (HS256) + cookie для статики песен.

Чтение (GET/HEAD/OPTIONS) открыто без регистрации: каталог, стриминг песен,
тексты и документация доступны анонимно. Запись (загрузка песен, правка
текстов) требует валидного входа в bebradio.
Работает только когда задан AUTH_JWT_SECRET (иначе режим standalone без входа,
открыто всё).
Принимаем токен из заголовка Authorization: Bearer или из cookie karaoke_auth —
cookie нужен, чтобы <audio>/<img> с /songs/* ходили без заголовка.
Токены bebradio без sub (room-токены) отвергаются: требуем непустой sub.
"""
from __future__ import annotations

import logging
import time

import jwt
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import config

log = logging.getLogger(__name__)

COOKIE_NAME = "karaoke_auth"
UNAUTHORIZED = {"error": "Требуется вход в bebradio"}

#: области с закрытой записью (чтение всегда открыто): API, статика песен, доки
_PROTECTED = ("/api/", "/songs/", "/docs", "/redoc", "/openapi.json")
#: безопасные методы — чтение, ими ничего не пишем
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _needs_auth(path: str) -> bool:
    if path == "/api" or path == "/songs":
        return True
    return any(path.startswith(p) for p in _PROTECTED)


def _extract_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        token = header[7:].strip()
        if token:
            return token
    cookie = request.cookies.get(COOKIE_NAME)
    return cookie or None


def _decode(token: str, secret: str) -> dict | None:
    try:
        claims = jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        return None  # room-токены bebradio (без sub) и прочие «чужие» токены
    return claims


def install_auth(app: FastAPI) -> None:
    # секрет читается на каждый запрос: тесты включают auth monkeypatch-ем,
    # а в рантайме решение не меняется — env фиксируется на старте
    if config.AUTH_JWT_SECRET:
        log.info("AUTH_JWT_SECRET задан — включён вход через bebradio")
    else:
        log.info("AUTH_JWT_SECRET не задан — авторизация выключена")

    @app.middleware("http")
    async def auth_middleware(request: Request, call_next):
        path = request.url.path
        secret = config.AUTH_JWT_SECRET
        token = _extract_token(request)
        claims = _decode(token, secret) if (secret and token) else None
        # чтение открыто без входа; запись (upload, правка текстов) — только с JWT
        if secret and claims is None and _needs_auth(path) \
                and request.method not in _SAFE_METHODS:
            log.info("401 %s %s", request.method, path)
            return JSONResponse(UNAUTHORIZED, status_code=401)
        response = await call_next(request)
        # cookie для медиа-тегов: выдаём/освежаем при запросе с Bearer
        if claims is not None and request.headers.get("authorization", "").lower().startswith("bearer "):
            exp = claims.get("exp")
            max_age = max(60, int(exp - time.time())) if isinstance(exp, (int, float)) else 7 * 24 * 3600
            response.set_cookie(
                COOKIE_NAME,
                token,
                max_age=max_age,
                httponly=True,
                samesite="lax",
                path="/",
            )
        return response
