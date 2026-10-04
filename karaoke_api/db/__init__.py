"""PostgreSQL для лёгкого рантайма: пул, миграции, точка включения.

DATABASE_URL обязателен (см. karaoke_api.config, validate_config); psycopg
импортируется лениво — только при первом обращении к пулу/миграциям.
Канон данных остаётся в Silo: PG — производный каталог и история задач.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlparse

from karaoke_api import config

if TYPE_CHECKING:
    from psycopg_pool import ConnectionPool

log = logging.getLogger(__name__)

MIGRATIONS = Path(__file__).resolve().parent / "migrations"
#: размер пула: воркер + несколько потоков FastAPI; переполнение ждёт до 10 сек
MAX_POOL = 5
_pool: ConnectionPool | None = None
_lock = threading.Lock()


def _require_url() -> str:
    if not config.DATABASE_URL:
        raise RuntimeError("DATABASE_URL не задан — PostgreSQL обязателен (каталог и реестр задач)")
    return config.DATABASE_URL


def pool() -> ConnectionPool:
    """Открытый ленивый пул: первый вызов создаёт, дальше переиспользуем."""
    global _pool
    if _pool is None:
        with _lock:
            if _pool is None:
                from psycopg_pool import ConnectionPool

                _pool = ConnectionPool(
                    conninfo=_require_url(),
                    min_size=0,
                    max_size=MAX_POOL,
                    timeout=10.0,
                    open=True,  # явно: по умолчанию станет False
                    kwargs={"autocommit": True},
                )
                log.info("pg: пул открыт (%s)", _target())
    return _pool


def close() -> None:
    """Закрыть пул (идемпотентно) — в конце lifespan."""
    global _pool
    with _lock:
        if _pool is not None:
            _pool.close()
            _pool = None
            log.info("pg: пул закрыт")


def migrate() -> None:
    """Применить недостающие migrations/*.sql (идемпотентно, всё в одной транзакции)."""
    import psycopg  # ленивый импорт: пакет поднимается только при первом обращении

    files = sorted(MIGRATIONS.glob("*.sql"))
    with psycopg.connect(_require_url()) as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "version text PRIMARY KEY,"
            " applied_at timestamptz NOT NULL DEFAULT now())")
        applied = {r[0] for r in conn.execute("SELECT version FROM schema_migrations").fetchall()}
        for f in files:
            if f.stem in applied:
                continue
            log.info("pg: миграция %s", f.name)
            for stmt in _statements(f.read_text(encoding="utf-8")):
                conn.execute(stmt)
            conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (f.stem,))
    log.info("pg: схема актуальна (%d файлов)", len(files))


def _statements(sql: str) -> list[str]:
    """Разбить скрипт на statement'ы: сначала срезаем `--`-комментарии (в них тоже бывает `;`).

    Миграции пишем сами: никаких литералов с `--`/`;` внутри строк — только простые statement'ы.
    """
    lines = [ln.split("--", 1)[0] for ln in sql.splitlines()]
    return [s.strip() for s in "\n".join(lines).split(";") if s.strip()]


def _target() -> str:
    """Хост/база для лога — без логина и пароля."""
    u = urlparse(config.DATABASE_URL)
    port = f":{u.port}" if u.port else ""
    return f"{u.hostname or '?'}{port}/{u.path.lstrip('/')}"
