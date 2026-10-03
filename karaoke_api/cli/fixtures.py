"""Калибровочная фикстура: изолированный вокал как идеальное исполнение.

Берёт pitch.json песни и сэмплирует его с каденцией живого цикла (0.12с)
в детекции {t, freq|null}. Тест скармливает их через sampleFrame ->
scoreNotes -> buildSongScore: идеальный певец обязан набрать высоко.

Запуск: python -m karaoke_api.cli.fixtures [song-id]
"""
from __future__ import annotations

import argparse
import json

from karaoke_api import minio
from karaoke_api.config import ROOT

CADENCE = 0.12
DEFAULT_SONG = "icegergert-evrodensru"


def midi_to_hz(m: float) -> float:
    return 440.0 * (2.0 ** ((m - 69) / 12))


def build_fixture(song: str) -> dict:
    """Сэмпллировать pitch.json песни с каденцией живого цикла."""
    raw = minio.get(f"songs/{song}/pitch.json")
    if raw is None:
        raise FileNotFoundError(f"в бакете нет songs/{song}/pitch.json")
    pitch = json.loads(raw.decode("utf-8"))
    t = pitch["t"]
    midi = pitch["midi"]
    dur = t[-1]
    voiced = sum(1 for m in midi if m is not None)
    print(f"[INFO] {song}: {len(t)} сэмплов, voiced {voiced / len(t) * 100:.1f}%, dur {dur:.1f}c")

    detections = []
    tt = 0.0
    while tt <= dur:
        # ближайший сэмпл, как lookup.at
        bi = min(range(len(t)), key=lambda i: abs(t[i] - tt))
        m = midi[bi]
        detections.append({
            "t": round(tt, 3),
            "f": round(midi_to_hz(m), 2) if m is not None else None,
        })
        tt = round(tt + CADENCE, 3)

    return {
        "songId": song,
        "cadence": CADENCE,
        "ref": {"t": t, "midi": midi},
        "detections": detections,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Калибровочная фикстура для web-тестов")
    ap.add_argument("song", nargs="?", default=DEFAULT_SONG, help="id песни в data/songs")
    args = ap.parse_args()

    out = build_fixture(args.song)
    dest = ROOT / "web" / "src" / "lib" / "__fixtures__" / f"{args.song}.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out), encoding="utf-8")
    print(f"[OK] {dest} ({len(out['detections'])} детекций, {dest.stat().st_size // 1024}КБ)")


if __name__ == "__main__":
    main()
