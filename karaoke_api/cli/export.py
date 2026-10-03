"""Переопубликация песен: канон songs/<id>/ -> те же mp3/JSON в бакете.

Полезно после правки quality или ручной порчи mp3; манифест API собирает сам.

Usage:
    python -m karaoke_api.cli.export [--only <song-id>] [--quality N]
"""
from __future__ import annotations

import argparse
import logging
import sys

from karaoke_api.store.publish import log, publish_song, select_sids


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description="переопубликация песен (mp3/JSON) в бакет")
    ap.add_argument("--quality", default="4", help="ffmpeg -q:a для mp3 (0..9, 4 ~= 165kbps)")
    ap.add_argument("--only", default=None, help="одна песня по id или по названию трека")
    a = ap.parse_args()

    sids = select_sids(a.only)
    if not sids:
        sys.exit("[ERROR] нет песен для публикации (бакет пуст?)")

    done = 0
    for sid in sids:
        entry = publish_song(sid, a.quality)
        if entry is None:
            continue
        done += 1
        log.info("%s (%sс)", entry["title"], entry.get("duration") or "?")
    print(f"\n[DONE] опубликовано: {done}")


if __name__ == "__main__":
    main()
