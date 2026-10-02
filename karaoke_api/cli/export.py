"""CLI публикации песен: data/songs/ -> data/public/songs/ + манифест.

Логика живёт в karaoke_api.store.publish (её же зовут API и воркер — без subprocess).

Usage:
    python -m karaoke_api.cli.export [--only <song-id>] [--quality N] [--out DIR]
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from karaoke_api.config import DATA_PUBLIC, STORE
from karaoke_api.store.publish import (
    log,
    publish_song,
    read_manifest,
    select_sids,
    write_manifest,
)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description="Публикация data/songs -> data/public/songs")
    ap.add_argument("--out", default=str(DATA_PUBLIC))
    ap.add_argument("--quality", default="4", help="ffmpeg -q:a для mp3 (0..9, 4 ~= 165kbps)")
    ap.add_argument("--only", default=None, help="только песня с таким id (или названием трека)")
    a = ap.parse_args()

    out_root = Path(a.out)
    out_root.mkdir(parents=True, exist_ok=True)

    sids = select_sids(a.only, STORE)
    if not sids:
        sys.exit("[ERROR] песен нет — сначала загрузите песню через интерфейс")

    # --only: перезаписываем одну строку, остальные сохраняем;
    # полный прогон: манифест собирается заново из опубликованного.
    entries = read_manifest(out_root) if a.only else []
    for sid in sids:
        entry = publish_song(sid, STORE / sid, out_root, a.quality, STORE)
        if entry is None:
            continue
        entries = [m for m in entries if m.get("id") != sid] + [entry]
        log.info("%s (%sс)", entry["title"], entry.get("duration") or "?")
    write_manifest(out_root, entries)
    print(f"\n[DONE] песен: {len(entries)} -> {out_root / 'manifest.json'}")


if __name__ == "__main__":
    main()
