"""
Vocal / accompaniment separation on RTX 5070 via Demucs.
Uses htdemucs_ft by default (best quality). CUDA forced if available.

Usage:
    python src/separate.py music/"track.mp3" --out output --model htdemucs_ft --two-stems vocals
    python src/separate.py music/ --out output   # batch folder
"""
import argparse
import subprocess
import sys
from pathlib import Path


def build_cmd(inp: Path, out: Path, model: str, two_stems: str | None,
              device: str, shifts: int, overlap: float, mp3: bool) -> list[str]:
    cmd = [
        sys.executable, "-m", "demucs.separate",
        "-n", model,
        "-d", device,
        "--out", str(out),
    ]
    if two_stems:
        cmd += ["--two-stems", two_stems]
    if shifts and shifts > 1:
        # shifts=2..4 повышает качество, но медленнее. На 5070 можно 2.
        cmd += ["--shifts", str(shifts)]
    if overlap != 0.25:
        cmd += ["--overlap", str(overlap)]
    if mp3:
        cmd += ["--mp3"]
    cmd += [str(inp)]
    return cmd


def main():
    ap = argparse.ArgumentParser(description="Demucs vocal separation for karaoke (CUDA)")
    ap.add_argument("input", help="audio file or folder")
    ap.add_argument("--out", default="output", help="output root folder")
    ap.add_argument("--model", default="htdemucs_ft",
                    choices=["htdemucs_ft", "htdemucs", "htdemucs_6s", "hdemucs_mmi"],
                    help="htdemucs_ft = лучшее качество, htdemucs = быстрее")
    ap.add_argument("--two-stems", default="vocals",
                    help="'vocals' -> только vocals+no_vocals (быстро, мало VRAM). '' -> все 4 стема")
    ap.add_argument("--device", default="cuda", help="cuda | cpu")
    ap.add_argument("--shifts", type=int, default=1)
    ap.add_argument("--overlap", type=float, default=0.25)
    ap.add_argument("--mp3", action="store_true", help="сохранять mp3 вместо wav")
    args = ap.parse_args()

    # Автопроверка CUDA
    if args.device == "cuda":
        try:
            import torch
            if not torch.cuda.is_available():
                print("[WARN] torch.cuda недоступен, переключаюсь на CPU (будет очень медленно)")
                args.device = "cpu"
            else:
                name = torch.cuda.get_device_name(0)
                print(f"[OK] GPU: {name}")
        except ImportError:
            print("[WARN] torch не найден, demucs сам выберет устройство")
    if args.two_stems == "":
        args.two_stems = None

    inp = Path(args.input)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    files: list[Path]
    if inp.is_dir():
        files = sorted([p for p in inp.iterdir()
                        if p.suffix.lower() in (".mp3", ".wav", ".flac", ".m4a", ".ogg")])
    else:
        files = [inp]
    if not files:
        print("Нет аудиофайлов"); sys.exit(1)

    for f in files:
        print(f"\n=== {f.name} -> model={args.model} device={args.device} ===")
        cmd = build_cmd(f, out, args.model, args.two_stems,
                        args.device, args.shifts, args.overlap, args.mp3)
        print(" ".join(cmd))
        r = subprocess.run(cmd)
        if r.returncode != 0:
            print(f"[ERROR] demucs failed for {f}")
            continue
        # Demucs кладёт в <out>/<model>/<track>/{vocals,no_vocals}.wav
        # Для караоке удобнее плоская структура — делаем симлинк/копию-подсказку
        print(f"[OK] готово. Ищи в {out / args.model / f.stem}/")


if __name__ == "__main__":
    main()
