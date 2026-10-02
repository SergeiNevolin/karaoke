"""Мелкие общие помощники без зависимостей: slug, атомарный JSON, время, имена."""
from __future__ import annotations

import json
import os
import re
import tempfile
from contextlib import suppress
from datetime import datetime
from pathlib import Path

_RU = str.maketrans({
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
})


def slug(name: str) -> str:
    """Транслит + безопасный для файловой системы идентификатор."""
    s = name.lower().strip().translate(_RU).replace(" ", "-")
    s = re.sub(r"[^a-z0-9\-]", "", s)
    return re.sub(r"-+", "-", s).strip("-") or "song"


def now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def atomic_write_json(path: Path, data: dict) -> None:
    """Запись tmp-файлом + os.replace: читатель никогда не видит обрезанный JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    except BaseException:
        with suppress(OSError):
            os.unlink(tmp)
        raise


def unique_path(directory: Path, stem: str, suffix: str) -> tuple[Path, int]:
    """Первый свободный файл: stem, stem-2, stem-3... -> (путь, номер варианта)."""
    variant = 1
    candidate = directory / f"{stem}{suffix}"
    while candidate.exists():
        variant += 1
        candidate = directory / f"{stem}-{variant}{suffix}"
    return candidate, variant
