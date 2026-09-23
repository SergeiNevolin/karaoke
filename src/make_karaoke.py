"""
Полный пайплайн: mp3 -> Demucs(GPU) -> faster-whisper(GPU) -> pitch -> song_bundle.json
Всё тяжёлое едет на RTX 5070.

Usage:
    python src/make_karaoke.py "music/Серега Пират - Прости я не знаю.mp3" --model htdemucs --whisper large-v3
    python src/make_karaoke.py music/   # вся папка

На выходе:
    output/<model>/<track>/
        vocals.wav
        no_vocals.wav        <- это "минус"
        vocals_lyrics.json   <- сегменты + слова с таймингами
        vocals.lrc
        vocals_pitch.json    <- эталон высоты для скоринга
        karaoke.json         <- единый бандл для плеера
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run(cmd: list[str]) -> None:
    print(">>> " + " ".join(cmd))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        sys.exit(f"[FATAL] упало: {cmd}")


def build_bundle(track_dir: Path) -> Path:
    vocals = track_dir / "vocals.wav"
    minus = track_dir / "no_vocals.wav"
    lyrics = track_dir / "vocals_lyrics.json"
    pitch = track_dir / "vocals_pitch.json"
    if not vocals.exists():
        # demucs с --two-stems vocals даёт именно эти имена
        cands = list(track_dir.glob("*vocals*.wav"))
        if cands:
            vocals = cands[0]
    data = {"track": track_dir.name,
            "vocals": str(vocals) if vocals.exists() else None,
            "minus": str(minus) if minus.exists() else None,
            "lyrics": None, "pitch": str(pitch) if pitch.exists() else None}
    if lyrics.exists():
        data["lyrics"] = json.loads(lyrics.read_text(encoding="utf-8"))
    out = track_dir / "karaoke.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


def process_one(audio: Path, out_root: Path, demucs_model: str, whisper_model: str,
                lang: str, device: str, skip_separation: bool, skip_transcribe: bool,
                skip_pitch: bool) -> Path:
    print(f"\n{'='*60}\n[a] {audio.name}\n{'='*60}")

    track_dir = out_root / demucs_model / audio.stem

    # 1. Separation (GPU)
    if not skip_separation or not (track_dir / "no_vocals.wav").exists():
        run([sys.executable, str(ROOT / "src" / "separate.py"),
             str(audio), "--out", str(out_root),
             "--model", demucs_model, "--two-stems", "vocals",
             "--device", device])
    else:
        print("[skip] separation")

    # 2. Transcribe vocals (GPU)
    vocals = track_dir / "vocals.wav"
    if not skip_transcribe:
        run([sys.executable, str(ROOT / "src" / "transcribe.py"),
             str(vocals), "--model", whisper_model, "--lang", lang, "--device", device])
    else:
        print("[skip] transcribe")

    # 3. Pitch reference (CPU, быстро)
    if not skip_pitch:
        run([sys.executable, str(ROOT / "src" / "pitch.py"), str(vocals)])
    else:
        print("[skip] pitch")

    bundle = build_bundle(track_dir)
    print(f"[OK] бандл: {bundle}")
    return bundle


def main():
    ap = argparse.ArgumentParser(description="Karaoke pipeline for RTX 5070")
    ap.add_argument("input", help="mp3/wav или папка music/")
    ap.add_argument("--out", default=str(ROOT / "output"))
    ap.add_argument("--model", default="htdemucs",
                    help="htdemucs (быстро, ~15с/трек на 5070) | htdemucs_ft (качество, ~40с)")
    ap.add_argument("--whisper", default="large-v3", help="large-v3 | medium | small")
    ap.add_argument("--lang", default="ru")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--skip-separation", action="store_true")
    ap.add_argument("--skip-transcribe", action="store_true")
    ap.add_argument("--skip-pitch", action="store_true")
    a = ap.parse_args()

    inp, out_root = Path(a.input), Path(a.out)
    files = sorted([p for p in inp.iterdir() if p.suffix.lower() in
                    (".mp3", ".wav", ".flac", ".m4a", ".ogg")]) if inp.is_dir() else [inp]
    for f in files:
        process_one(f, out_root, a.model, a.whisper, a.lang, a.device,
                    a.skip_separation, a.skip_transcribe, a.skip_pitch)


if __name__ == "__main__":
    main()
