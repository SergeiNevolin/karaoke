"""
Перегон pitch.json песен через GPU-сервис (никакого torch здесь —
только HTTP): vocals.wav из store -> /v1/pitch -> store + паблиш.
Использование:
    GPU_URL=http://gpu:8001 python -m karaoke_api.cli.rebuild_pitch [--only <song-id>]

Проверяет voiced% и длину трека.
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from karaoke_api.config import KARAOKE_ML_SERVICE_URL, STORE
from karaoke_api.gpu_client import GpuClient
from karaoke_api.store.publish import publish_one
from karaoke_api.store.songs import all_ids


def _read_old_pitch(dest) -> dict:
    try:
        return json.loads(dest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"t": []}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None)
    args = ap.parse_args()

    if not KARAOKE_ML_SERVICE_URL:
        sys.exit("[ERROR] нужен GPU_URL (перегон считает GPU-сервис)")
    gpu = GpuClient(KARAOKE_ML_SERVICE_URL)
    sids = all_ids(STORE)
    if args.only:
        sids = [s for s in sids if s == args.only]

    ok, skipped, fails = 0, 0, []
    for sid in sids:
        t0 = time.time()
        src = STORE / sid / "vocals.wav"
        if not src.is_file():
            print(f"[SKIP] {sid}: нет vocals.wav в store")
            skipped += 1
            continue
        dest = STORE / sid / "pitch.json"
        old = _read_old_pitch(dest) if dest.exists() else {"t": []}
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
            dest.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            try:
                publish_one(sid)
            except Exception as e:  # noqa: BLE001
                print(f"[WARN] {sid}: паблиш упал: {e}")
                fails.append(sid)
                continue
            ok += 1
        dt = time.time() - t0
        print(f"[{status}] {sid}: voiced {cov:.1f}% frames={len(data['t'])} ({dt:.0f}с)")
    print(f"\n[DONE] ok={ok} skipped={skipped} fails={fails}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
