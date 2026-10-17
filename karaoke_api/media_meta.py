"""Обложка из метаданных аудиофайла: ID3 APIC / FLAC Picture / MP4 covr.

Как в mashups (bebradio music-service): тянем attached picture из тегов
исходника. Разница — в API нет ffmpeg («ffmpeg живёт только в GPU-сервисе»),
поэтому теги читаются mutagen'ом, чистым python без перекодирования.

Best-effort по контракту: кривые теги или их отсутствие — None и лог,
а не падение загрузки.
"""
from __future__ import annotations

import base64
import logging
from pathlib import Path

log = logging.getLogger(__name__)


def cover_bytes(path: Path | str) -> bytes | None:
    """Байты лучшей attached-картинки из тегов; None — если её нет или файл не открыт."""
    try:
        from mutagen import File as MutagenFile  # ленивый импорт: парсер нужен только здесь

        tags = MutagenFile(str(path), easy=False)
    except Exception as e:
        log.debug("cover: форматы %s не читаются целиком (%s) — пробую голый ID3", path, e)
        tags = None
    if tags is not None and getattr(tags, "tags", None) is not None:
        return _cover_from_tags(tags.tags)
    # MutagenFile не осилил файл (нет MPEG-кадра, урезанный аплоад...) — но сам
    # тег может лежать на месте: mp3 с одним ID3-v2-заголовком читается напрямую.
    try:
        from mutagen.id3 import ID3  # noqa: PLC0415 — лениво, как и всё mutagen

        return _cover_from_tags(ID3(str(path)))
    except Exception as e:
        log.info("cover: теги %s не читаются: %s", path, e)
        return None


def _cover_from_tags(tags) -> bytes | None:
    """Выбор лучшей картинки по содержимому тегов (mutagen-объект/«подобьёт»).

    Приоритет — фронт-обложка (type 3), среди равных — крупнее.
    """
    raws: list[tuple[int, int, bytes]] = []

    if hasattr(tags, "pictures"):  # FLAC / ogg-watch: список flac.Picture
        for p in tags.pictures or []:
            data = getattr(p, "data", None)
            if data:
                raws.append((0 if getattr(p, "type", 0) == 3 else 1, len(data), data))
    elif hasattr(tags, "getall"):  # ID3.2 (mp3): APIC-фреймы
        for p in tags.getall("APIC"):
            data = getattr(p, "data", None)
            if data:
                raws.append((0 if getattr(p, "picture_type", 0) == 3 else 1, len(data), data))
    else:  # словарные теги: MP4 (covr) и Ogg (METADATA_BLOCK_PICTURE)
        try:
            for c in tags.get("covr") or []:
                data = bytes(c) if isinstance(c, (bytes, bytearray)) else getattr(c, "data", None)
                if data:
                    raws.append((0, len(data), data))
        except Exception as e:
            log.debug("cover: covr не читается: %s", e)
        try:
            from mutagen.flac import Picture

            for b64 in tags.get("METADATA_BLOCK_PICTURE") or []:
                p = Picture(base64.b64decode(b64))
                if p.data:
                    raws.append((0 if p.type == 3 else 1, len(p.data), p.data))
        except Exception as e:
            log.debug("cover: METADATA_BLOCK_PICTURE не читается: %s", e)

    if not raws:
        return None
    raws.sort(key=lambda t: (t[0], -t[1]))  # фронт раньше «other», крупнее — лучше
    return raws[0][2]
