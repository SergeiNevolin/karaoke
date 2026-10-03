"""Миграция легаси-файловой системы в бакет MinIO.

Переносит (НЕ удаляя локальные файлы):
  data/public/songs/**  -> songs/**     (сначала публикация)
  data/songs/**         -> songs/**     (канон поверх публикации при конфликте)
  music/**              -> music/**
и нормализует meta.source.file: абсолютные пути внутрь music/ -> music/<файл>.

Идемпотентно: объект того же размера пропускается (--force — залить заново).
Запуск из контейнера: docker compose run --rm karaoke-service \
    python -m karaoke_api.cli.migrate_storage
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from karaoke_api import minio
from karaoke_api.config import DATA_PUBLIC, MUSIC, STORE


def _upload_tree(src_root: Path, key_prefix: str, force: bool,
                 skip_names: tuple[str, ...] = ()) -> tuple[int, int]:
    """Дерево файлов -> ключи. Возвращает (залито, пропущено)."""
    ok = skip = 0
    if not src_root.is_dir():
        return 0, 0
    for p in sorted(src_root.rglob("*")):
        if not p.is_file() or p.name in skip_names:
            continue
        key = key_prefix + p.relative_to(src_root).as_posix()
        h = minio.head(key)
        if not force and h is not None and h["size"] == p.stat().st_size:
            skip += 1
            continue
        minio.put_file(key, p)
        ok += 1
    return ok, skip


def _normalize_source_meta() -> int:
    """meta.source.file вида /путь/к/music/x.mp3 -> music/x.mp3 (объект уже залит)."""
    fixed = 0
    for key in [k for k in minio.list_keys("songs/") if k.endswith("/meta.json")]:
        meta = minio.get_json(key)
        if not isinstance(meta, dict):
            continue
        src = str((meta.get("source") or {}).get("file") or "")
        if not src or src.startswith("music/"):
            continue
        p = Path(src)
        if p.is_absolute():
            try:
                new = "music/" + p.relative_to(MUSIC).as_posix()
            except ValueError:
                new = None
        else:
            new = p.as_posix() if p.parts[:1] == ("music",) else None
        if new and new != src and minio.exists(new):
            meta["source"]["file"] = new
            minio.put_json(key, meta)
            fixed += 1
    return fixed


def main() -> None:
    ap = argparse.ArgumentParser(description="миграция data/ + music/ в бакет MinIO")
    ap.add_argument("--force", action="store_true",
                    help="залить заново даже совпадающие по размеру объекты")
    a = ap.parse_args()

    print(f"бакет: {minio.bucket()} на minio endpoint, локальные файлы остаются на месте")
    pub_ok, pub_skip = _upload_tree(DATA_PUBLIC, "songs/", a.force, skip_names=("manifest.json",))
    print(f"[1/4] data/public/songs -> songs/: +{pub_ok} (пропущено {pub_skip})")
    can_ok, can_skip = _upload_tree(STORE, "songs/", a.force)
    print(f"[2/4] data/songs -> songs/:       +{can_ok} (пропущено {can_skip})")
    mus_ok, mus_skip = _upload_tree(MUSIC, "music/", a.force)
    print(f"[3/4] music -> music/:            +{mus_ok} (пропущено {mus_skip})")
    fixed = _normalize_source_meta()
    print(f"[4/4] meta.source.file нормализован: {fixed}")

    total = pub_ok + can_ok + mus_ok
    if total == 0 and fixed == 0:
        print("[DONE] переносить нечего — данные уже в бакете (или каталоги пусты)")
        return
    print(f"[DONE] перенесено объектов: {total}")


if __name__ == "__main__":
    main()
    sys.exit(0)
