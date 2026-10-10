"""Каталог песен в PostgreSQL: производная копия meta.json (канон — Silo).

Запись best-effort: сбой PG логируется — падение производной базы не ломает
запись канона. Чтение — строгое (build_manifest).
"""
from __future__ import annotations

import logging

from karaoke_api import db

log = logging.getLogger(__name__)


def manifest_rows(limit: int = 200, offset: int = 0) -> list[dict]:
    """Строки каталога в форме манифеста API, сортировка по lower(title).

    Чанки: limit/offset режут выдачу (дефолт покрывает витрины, полный список —
    явным ?limit=)."""
    with db.pool().connection() as conn:
        rows = conn.execute(
            "SELECT id, title, language, lines, duration, has_original, has_vocals, "
            "artist, owner_id, owner_name "
            "FROM songs ORDER BY lower(title) LIMIT %s OFFSET %s",
            (limit, offset),
        ).fetchall()
    return [
        {
            "id": r[0],
            "title": r[1],
            "audio": f"songs/{r[0]}/minus.mp3",
            "original": f"songs/{r[0]}/original.mp3" if r[5] else None,
            "vocals": f"songs/{r[0]}/vocals.mp3" if r[6] else None,
            "language": r[2],
            "lines": r[3],
            "duration": r[4],
            "artist": r[7],
            "owner_id": r[8],
            "owner_name": r[9],
        }
        for r in rows
    ]


def delete(sid: str) -> None:
    """Убрать песню из производного каталога (best-effort, как upsert)."""
    try:
        with db.pool().connection() as conn:
            conn.execute("DELETE FROM songs WHERE id = %s", (sid,))
    except Exception:
        log.exception("pg: не удалось удалить песню %s", sid)


def upsert(sid: str, *, strict: bool = False, **fields) -> None:
    """INSERT ... ON CONFLICT: обновляет только переданные поля, остальные не трогает.

    Ключи полей — лишь константы нашего кода (SQL собирается f-строкой).
    title в INSERT-ветке подставляем по id: PG проверяет NOT NULL новой записи
    ДО поиска конфликта, и частичный upsert без title падал бы даже для уже
    существующей песни; в DO UPDATE title не входит — существующий не трогаем.
    strict=False (по умолчанию): ошибка уходит в лог — канон в Silo не падает.
    """
    if not fields:
        return
    insert_fields = {**fields}
    insert_fields.setdefault("title", sid)
    cols = ["id", *insert_fields]
    sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in fields)
    sql = (f"INSERT INTO songs ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))}) "
           f"ON CONFLICT (id) DO UPDATE SET {sets}")
    try:
        with db.pool().connection() as conn:
            conn.execute(sql, [sid, *insert_fields.values()])
    except Exception:
        if strict:
            raise
        log.exception("pg: не удалось записать песню %s", sid)
