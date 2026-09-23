"""
Экспорт готовых бандлов (output/**/karaoke.json) в веб-каталог web/public/songs/:
  songs/<id>/minus.mp3    (ffmpeg из no_vocals.wav — минус для пения)
  songs/<id>/vocals.mp3   (ffmpeg из vocals.wav — оригинал для редактора тайминга)
  songs/<id>/waveform.json (пики громкости вокала для отрисовки редактора)
  songs/<id>/lyrics.json  (segments + language)
  songs/<id>/pitch.json   (эталон тона)
  songs/manifest.json     (каталог для React)

Usage:
    python web/scripts/export_songs.py [--out web/public/songs]
"""
import argparse
import array
import json
import re
import subprocess
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent  # C:\projects\karaoke
WEB = ROOT / "web"


_RU = str.maketrans({
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
})


def slug(name: str) -> str:
    s = name.lower().strip().translate(_RU).replace(" ", "-")
    s = re.sub(r"[^a-z0-9\-]", "", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "song"


def wav_duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as w:
            return w.getnframes() / w.getframerate()
    except Exception:
        return 0.0


def waveform_peaks(path: Path, buckets: int = 1200) -> tuple[list[float], float]:
    """Пики громкости вокала для отрисовки waveform (только stdlib)."""
    try:
        with wave.open(str(path), "rb") as w:
            n, ch, sw, sr = w.getnframes(), w.getnchannels(), w.getsampwidth(), w.getframerate()
            raw = w.readframes(n)
        if sw == 1:
            a = array.array("h", (x - 128 for x in raw))
        elif sw == 2:
            a = array.array("h", raw)
        elif sw == 4:
            a = array.array("i", raw)
        else:
            return [], 0.0
        if ch > 1:
            a = array.array(a.typecode, (sum(a[i:i + ch]) // ch for i in range(0, len(a), ch)))
        peak = max(1, max((abs(x) for x in a), default=1))
        bs = max(1, len(a) // buckets)
        peaks = [round(max((abs(x) for x in a[i:i + bs]), default=0) / peak, 3)
                 for i in range(0, len(a), bs)]
        return peaks, round(n / sr, 1)
    except Exception as e:
        print(f"[WARN] waveform: {e}")
        return [], 0.0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(WEB / "public" / "songs"))
    ap.add_argument("--quality", default="4", help="ffmpeg -q:a для mp3 (0..9, 4 ~= 165kbps)")
    ap.add_argument("--only", default=None, help="только бандл с таким именем папки или названием трека")
    a = ap.parse_args()

    out_root = Path(a.out)
    out_root.mkdir(parents=True, exist_ok=True)
    manifest_p = out_root / "manifest.json"
    manifest: list = []
    if manifest_p.exists():
        try:
            manifest = json.loads(manifest_p.read_text(encoding="utf-8")).get("songs", [])
        except Exception:
            manifest = []

    bundles = sorted((ROOT / "output").rglob("karaoke.json"))
    if a.only:
        bundles = [b for b in bundles
                   if b.parent.name == a.only
                   or json.loads(b.read_text(encoding="utf-8")).get("track") == a.only]
    if not bundles:
        sys.exit("[ERROR] бандлы не найдены. Сначала: python src/make_karaoke.py music/")

    for bpath in bundles:
        b = json.loads(bpath.read_text(encoding="utf-8"))
        bdir = bpath.parent
        title = b.get("track") or bdir.name
        sid = slug(title)

        minus_src = Path(b["minus"]) if b.get("minus") else bdir / "no_vocals.wav"
        if not minus_src.exists():
            print(f"[SKIP] {title}: нет минуса")
            continue

        dest = out_root / sid
        dest.mkdir(parents=True, exist_ok=True)
        minus_mp3 = dest / "minus.mp3"
        print(f"[..] {title} -> songs/{sid}/minus.mp3")
        r = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(minus_src),
             "-codec:a", "libmp3lame", "-q:a", a.quality, str(minus_mp3)]
        )
        if r.returncode != 0:
            print(f"[ERROR] ffmpeg упал на {minus_src}")
            continue

        lyr = (b.get("lyrics") or {})
        (dest / "lyrics.json").write_text(
            json.dumps({"language": lyr.get("language"),
                        "segments": lyr.get("segments", [])}, ensure_ascii=False),
            encoding="utf-8",
        )
        pitch_src = Path(b["pitch"]) if b.get("pitch") else bdir / "vocals_pitch.json"
        if pitch_src.exists():
            (dest / "pitch.json").write_bytes(pitch_src.read_bytes())
        else:
            (dest / "pitch.json").write_text('{"t":[],"midi":[]}', encoding="utf-8")

        # оригинал вокала — слушать в редакторе тайминга
        vocals_src = Path(b["vocals"]) if b.get("vocals") else bdir / "vocals.wav"
        vocals_rel = None
        if vocals_src.exists():
            r = subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-i", str(vocals_src),
                 "-codec:a", "libmp3lame", "-q:a", a.quality, str(dest / "vocals.mp3")]
            )
            if r.returncode == 0:
                vocals_rel = f"songs/{sid}/vocals.mp3"
            # пики waveform по вокалу
            peaks, wdur = waveform_peaks(vocals_src)
            (dest / "waveform.json").write_text(
                json.dumps({"peaks": peaks, "duration": wdur}), encoding="utf-8")
        else:
            print(f"[WARN] {title}: нет vocals.wav, редактор тайминга без оригинала")

        dur = wav_duration(minus_src)
        entry = {
            "id": sid,
            "title": title,
            "audio": f"songs/{sid}/minus.mp3",
            "vocals": vocals_rel,
            "language": lyr.get("language"),
            "lines": len(lyr.get("segments", [])),
            "duration": round(dur, 1),
        }
        # upsert по id, чтобы --only не затирал остальные песни
        manifest = [m for m in manifest if m.get("id") != sid] + [entry]
        print(f"[OK] {title} ({dur:.0f}с)")

    (out_root / "manifest.json").write_text(
        json.dumps({"songs": manifest}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n[DONE] песен: {len(manifest)} -> {out_root / 'manifest.json'}")


if __name__ == "__main__":
    main()
