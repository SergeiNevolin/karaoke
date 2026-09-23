"""
Караоке-бэкенд: приём песен через интерфейс + GPU-пайплайн в фоне.

Endpoints:
  POST /api/upload            файл + параметры -> {jobId}
  GET  /api/jobs/{id}         статус задачи (stage, progress, songId...)
  GET  /api/songs             каталог (manifest)
  /songs/...                  статика песен (для prod-режима)
  /                           собранный фронт web/dist (для prod-режима)

Запуск:
  uvicorn server.app:app --port 8000
"""
from __future__ import annotations

import json
import queue
import re
import subprocess
import sys
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
MUSIC = ROOT / "music"
OUTPUT = ROOT / "output"
SRC = ROOT / "src"
PUBLIC_SONGS = ROOT / "web" / "public" / "songs"
DIST = ROOT / "web" / "dist"

ALLOWED_EXT = {".mp3", ".wav", ".flac", ".m4a", ".ogg",
               ".mp4", ".mov", ".mkv", ".webm"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm"}
ALLOWED_MODELS = {"htdemucs", "htdemucs_ft"}
ALLOWED_WHISPER = {"large-v3", "medium", "small"}
ALLOWED_LANG = {"ru", "en", ""}

STAGE_LABELS = {
    "queued": "В очереди",
    "separation": "Отделяю вокал (GPU)",
    "lyrics": "Распознаю текст (GPU)",
    "pitch": "Строю эталон тона",
    "lyrics_custom": "Накладываю твой текст",
    "export": "Готовлю файлы для плеера",
    "done": "Готово",
    "error": "Ошибка",
}

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
    return re.sub(r"-+", "-", s).strip("-") or "song"


app = FastAPI(title="Karaoke API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

jobs: dict[str, dict] = {}
job_queue: queue.Queue[str] = queue.Queue()


def set_job(job_id: str, **kw) -> None:
    jobs[job_id].update(kw)


def run_cmd(cmd: list[str], cwd: Path = ROOT) -> None:
    print(">>>", " ".join(cmd), flush=True)
    r = subprocess.run(cmd, cwd=str(cwd))
    if r.returncode != 0:
        raise RuntimeError(f"Упала команда: {' '.join(cmd[:4])}...")


def build_bundle(track_dir: Path, title: str) -> Path:
    """karaoke.json для плеера (как в src/make_karaoke.py)."""
    vocals = track_dir / "vocals.wav"
    minus = track_dir / "no_vocals.wav"
    lyrics_p = track_dir / "vocals_lyrics.json"
    pitch_p = track_dir / "vocals_pitch.json"
    data = {
        "track": title,
        "vocals": str(vocals) if vocals.exists() else None,
        "minus": str(minus) if minus.exists() else None,
        "lyrics": json.loads(lyrics_p.read_text(encoding="utf-8")) if lyrics_p.exists() else None,
        "pitch": str(pitch_p) if pitch_p.exists() else None,
    }
    out = track_dir / "karaoke.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


def process_job(job_id: str) -> None:
    job = jobs[job_id]
    audio = Path(job["audio"])
    model, whisper, lang = job["model"], job["whisper"], job["lang"]
    title = job["title"]
    try:
        # видео -> извлекаем аудиодорожку (Demucs ест только аудио)
        if audio.suffix.lower() in VIDEO_EXT:
            import shutil
            if not shutil.which("ffmpeg"):
                raise RuntimeError("ffmpeg не найден, видео не обработать")
            set_job(job_id, stage="separation", progress=1)
            wav = audio.with_suffix(".wav")
            run_cmd(["ffmpeg", "-y", "-v", "error", "-i", str(audio),
                     "-vn", "-ar", "44100", "-ac", "2", str(wav)])
            audio = wav
            jobs[job_id]["audio"] = str(audio)

        track_dir = OUTPUT / model / audio.stem

        set_job(job_id, stage="separation", progress=2)
        run_cmd([sys.executable, str(SRC / "separate.py"), str(audio),
                 "--out", str(OUTPUT), "--model", model,
                 "--two-stems", "vocals", "--device", "cuda"])
        set_job(job_id, progress=60)

        vocals = track_dir / "vocals.wav"
        if not vocals.exists():
            raise RuntimeError("Demucs не вернул vocals.wav")

        set_job(job_id, stage="lyrics", progress=62)
        run_cmd([sys.executable, str(SRC / "transcribe.py"), str(vocals),
                 "--model", whisper, "--lang", lang or "auto", "--device", "cuda"])
        set_job(job_id, progress=85)

        if job.get("lyrics_text") or job.get("lyrics_url"):
            from server.lyrics import apply_custom_lyrics
            set_job(job_id, stage="lyrics_custom", progress=86)
            stats = apply_custom_lyrics(
                track_dir,
                text=job.get("lyrics_text") or "",
                url=job.get("lyrics_url") or "")
            print(f"[lyrics] custom: {stats}", flush=True)
            set_job(job_id, progress=88)

        set_job(job_id, stage="pitch", progress=87)
        run_cmd([sys.executable, str(SRC / "pitch.py"), str(vocals)])
        set_job(job_id, progress=92)

        set_job(job_id, stage="export", progress=94)
        build_bundle(track_dir, title)
        run_cmd([sys.executable, str(ROOT / "web" / "scripts" / "export_songs.py"),
                 "--only", audio.stem])

        manifest = json.loads((PUBLIC_SONGS / "manifest.json").read_text(encoding="utf-8"))
        song_id = next((s["id"] for s in manifest.get("songs", []) if s["title"] == title), None)
        set_job(job_id, stage="done", progress=100, state="done", songId=song_id)
    except Exception as e:  # noqa: BLE001
        set_job(job_id, stage="error", state="error", error=str(e))


def worker() -> None:
    while True:
        job_id = job_queue.get()
        if jobs.get(job_id, {}).get("state") == "queued":
            jobs[job_id]["state"] = "running"
            process_job(job_id)
        job_queue.task_done()


threading.Thread(target=worker, daemon=True).start()


@app.post("/api/upload")
async def upload(
    file: UploadFile = File(...),
    model: str = Form("htdemucs"),
    whisper: str = Form("large-v3"),
    lang: str = Form("ru"),
    lyrics_text: str = Form(""),
    lyrics_url: str = Form(""),
) -> dict:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        return {"error": f"Нужно аудио {sorted(ALLOWED_EXT)}, а не {ext or '???'}"}
    if model not in ALLOWED_MODELS:
        model = "htdemucs"
    if whisper not in ALLOWED_WHISPER:
        whisper = "large-v3"
    if lang not in ALLOWED_LANG:
        lang = "ru"

    title = Path(file.filename or "song").stem.strip() or "Без названия"
    stem = slug(title)
    MUSIC.mkdir(parents=True, exist_ok=True)
    dest = MUSIC / f"{stem}{ext}"
    n = 2
    while dest.exists():
        dest = MUSIC / f"{stem}-{n}{ext}"
        n += 1
    if dest.stem != stem:
        title = f"{title} ({n - 1})"

    with open(dest, "wb") as f:
        f.write(await file.read())

    job_id = uuid.uuid4().hex[:12]
    jobs[job_id] = {"id": job_id, "state": "queued", "stage": "queued",
                    "progress": 0, "title": title, "audio": str(dest),
                    "model": model, "whisper": whisper, "lang": lang,
                    "lyrics_text": lyrics_text[:20000], "lyrics_url": lyrics_url[:500]}
    job_queue.put(job_id)
    return {"jobId": job_id}


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str) -> dict:
    job = jobs.get(job_id)
    if not job:
        return {"error": "Задача не найдена"}
    out = {k: v for k, v in job.items() if k != "audio"}
    out["stageLabel"] = STAGE_LABELS.get(job["stage"], job["stage"])
    return out


@app.get("/api/songs")
async def songs() -> dict:
    mp = PUBLIC_SONGS / "manifest.json"
    if not mp.exists():
        return {"songs": []}
    return json.loads(mp.read_text(encoding="utf-8"))


@app.get("/api/lyrics/fetch")
async def lyrics_fetch(url: str) -> dict:
    """Подтянуть текст с Genius по URL (обход CORS — качает сервер)."""
    try:
        from server.lyrics import fetch_genius_lines
        return {"lines": fetch_genius_lines(url)}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


if PUBLIC_SONGS.exists():
    app.mount("/songs", StaticFiles(directory=str(PUBLIC_SONGS)), name="songs")
if DIST.exists():
    app.mount("/", StaticFiles(directory=str(DIST), html=True), name="front")
