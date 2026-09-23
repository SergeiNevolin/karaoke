"""
Speech-to-lyrics with word timestamps on RTX 5070 via faster-whisper (CTranslate2 + CUDA).
Вход: vocals.wav (после Demucs) — так точнее, чем по миксу.
Выход: song.json (segments+words), song.lrc (караоке-формат), song.txt

Usage:
    python src/transcribe.py output/htdemucs_ft/"track"/vocals.wav --lang ru --model large-v3
"""
import argparse
import json
from pathlib import Path


def fmt_lrc_time(sec: float) -> str:
    m = int(sec // 60)
    s = sec - m * 60
    return f"[{m:02d}:{s:05.2f}]"


def main():
    ap = argparse.ArgumentParser(description="Whisper lyrics + word timestamps (CUDA)")
    ap.add_argument("audio", help="vocals.wav или оригинальный трек")
    ap.add_argument("--model", default="large-v3",
                    help="large-v3 = лучшее качество RU/EN. Для скорости: medium, small")
    ap.add_argument("--lang", default="ru", help="ru | en | auto ('' = автоопределение)")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--compute", default="float16",
                    help="float16 — оптимально для RTX 5070. На CPU: int8")
    ap.add_argument("--out", default=None, help="куда положить .json/.lrc (по умолч. рядом с аудио)")
    ap.add_argument("--vad", action="store_true", default=True,
                    help="VAD-фильтр убирает галлюцинации на инструментале")
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    audio = Path(args.audio)
    lang = args.lang if args.lang not in ("", "auto") else None
    device = args.device
    compute = args.compute

    if device == "cuda":
        try:
            import torch
            if not torch.cuda.is_available():
                print("[WARN] CUDA нет, перехожу на cpu/int8")
                device, compute = "cpu", "int8"
        except ImportError:
            pass

    print(f"[INFO] model={args.model} device={device} compute={compute} lang={lang or 'auto'}")
    model = WhisperModel(args.model, device=device, compute_type=compute)

    segments_iter, info = model.transcribe(
        str(audio),
        language=lang,
        word_timestamps=True,
        vad_filter=args.vad,
        vad_parameters=dict(min_silence_duration_ms=500),
        beam_size=5,
        condition_on_previous_text=False,  # меньше "залипаний" на песнях
    )
    print(f"[INFO] detected language: {info.language} p={info.language_probability:.2f}")

    segments = []
    for seg in segments_iter:
        words = []
        if seg.words:
            for w in seg.words:
                words.append({"w": w.word.strip(), "s": round(w.start, 2), "e": round(w.end, 2),
                              "p": round(float(w.probability), 3)})
        segments.append({"start": round(seg.start, 2), "end": round(seg.end, 2),
                         "text": seg.text.strip(), "words": words})
        print(f"[{seg.start:7.2f}->{seg.end:7.2f}] {seg.text.strip()}")

    out_base = Path(args.out) if args.out else audio.parent / audio.stem
    # если out — папка, положим внутрь song.*
    if args.out and Path(args.out).is_dir():
        out_base = Path(args.out) / audio.parent.name

    jpath = out_base.with_suffix(".json") if isinstance(out_base, Path) and out_base.suffix else Path(str(out_base) + ".json")
    # проще: рядом с vocals
    jpath = audio.parent / (audio.stem + "_lyrics.json")
    lrcpath = audio.parent / (audio.stem + ".lrc")
    txtpath = audio.parent / (audio.stem + ".txt")

    jpath.write_text(json.dumps({"audio": str(audio), "language": info.language,
                                 "segments": segments}, ensure_ascii=False, indent=2), encoding="utf-8")

    with open(lrcpath, "w", encoding="utf-8") as f:
        for seg in segments:
            f.write(f"{fmt_lrc_time(seg['start'])}{seg['text']}\n")
    txtpath.write_text("\n".join(s["text"] for s in segments), encoding="utf-8")

    print(f"[OK] {jpath}\n[OK] {lrcpath}\n[OK] {txtpath}")
    print(f"Сегментов: {len(segments)}, слов: {sum(len(s['words']) for s in segments)}")


if __name__ == "__main__":
    main()
