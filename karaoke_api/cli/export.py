"""Переопубликация песен: проверка/дозапись артефактов songs/<id>/ в бакете.

Полезно после ручной порчи mp3/JSON; манифест API собирает сам.
mp3 кодирует GPU-сервис — перекода здесь нет, отсутствие mp3 = ошибка песни.

Usage:
    python -m karaoke_api.cli.export [--only <song-id>]
"""
from __future__ import annotations

import argparse
import logging
import sys

from karaoke_api.store.publish import log, publish_song, select_sids


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description="переопубликация песен (JSON/waveform) в бакет")
    ap.add_argument("--only", default=None, help="одна песня по id или по названию трека")
    a = ap.parse_args()

    sids = select_sids(a.only)
    if not sids:
        sys.exit("[ERROR] нет песен для публикации (бакет пуст?)")

    done = 0
    failed = 0
    for sid in sids:
        try:
            entry = publish_song(sid)
        except Exception as e:  # noqa: BLE001 — отчёт по каждой песне, дальше идём
            failed += 1
            log.error("%s: %s", sid, e)
            continue
        done += 1
        log.info("%s (%sс)", entry["title"], entry.get("duration") or "?")
    print(f"\n[DONE] опубликовано: {done}" + (f", ошибок: {failed}" if failed else ""))


if __name__ == "__main__":
    main()
