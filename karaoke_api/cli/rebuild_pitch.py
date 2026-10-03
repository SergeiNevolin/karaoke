"""Пересборка pitch.json для песен без GPU-пайплайна (без torch — только HTTP).

vocals.wav из бакета -> /v1/pitch -> pitch.json в бакет + переопубликация.
Запуск: GPU_URL=http://gpu:8001 python -m karaoke_api.cli.rebuild_pitch [--only <song-id>]

Следите за voiced% — он не должен резко упасть.
"""
from __future__ import annotations

import argparse
import sys
import tempfile
import time
from pathlib import Path

from karaoke_api import minio
from karaoke_api.config import KARAOKE_ML_SERVICE_URL
from karaoke_api.gpu_client import GpuClient
from karaoke_api.store.publish import publish_one
from karaoke_api.store.songs import all_ids, song_key


def _old_pitch(sid: str) -> dict:
    return minio.get_json(song_key(sid, "pitch.json"), {"t": []}) or {"t": []}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None)
    args = ap.parse_args()

    if not KARAOKE_ML_SERVICE_URL:
        sys.exit("[ERROR] задайте KARAOKE_ML_SERVICE_URL (нужен поднятый GPU-сервис)")
    gpu = GpuClient(KARAOKE_ML_SERVICE_URL)
    sids = all_ids()
    if args.only:
        sids = [s for s in sids if s == args.only]

    ok, skipped, fails = 0, 0, []
    for sid in sids:
        t0 = time.time()
        vocals_key = song_key(sid, "vocals.wav")
        if minio.head(vocals_key) is None:
            print(f"[SKIP] {sid}: нет vocals.wav в бакете")
            skipped += 1
            continue
        old = _old_pitch(sid)
        with tempfile.TemporaryDirectory(prefix="rebuild-pitch-") as td:
            src = minio.download(vocals_key, Path(td) / "vocals.wav")
            try:
                data = gpu.pitch(src)
            except Exception as e:  # noqa: BLE001
                print(f"[WARN] {sid}: GPU pitch упал: {e}")
                fails.append(sid)
                continue
        vv = sum(1 for m in data["midi"] if m is not None)
        cov = 100 * vv / max(1, len(data["midi"]))
        old_n = len(old.get("t", []))
        ok_len = not old_n or abs(len(data["t"]) - old_n) / max(1, old_n) <= 0.01
        ok_cov = 20 <= cov <= 98
        status = "OK " if (ok_len and ok_cov) else "WARN"
        if not (ok_len and ok_cov):
            fails.append(sid)
        else:
            minio.put_json(song_key(sid, "pitch.json"), data)
            try:
                publish_one(sid)
            except Exception as e:  # noqa: BLE001
                print(f"[WARN] {sid}: переопубликация упала: {e}")
                fails.append(sid)
                continue
            ok += 1
        dt = time.time() - t0
        print(f"[{status}] {sid}: voiced {cov:.1f}% frames={len(data['t'])} ({dt:.0f}с)")
    print(f"\n[DONE] ok={ok} skipped={skipped} fails={fails}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
