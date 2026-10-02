"""Пайплайн задачи: сабмит в GPU, поллинг с дедлайном, безопасная распаковка бандла, store, публикация."""
from __future__ import annotations

import io
import json
import logging
import os
import shutil
import time
import zipfile
from pathlib import Path

from .config import JOB_TIMEOUT_SEC, KARAOKE_ML_SERVICE_URL, MAX_BUNDLE_MB, POLL_INTERVAL_SEC, ROOT, STORE
from .gpu_client import GpuClient, GpuError
from .registry import Job, JobRegistry
from .store.publish import publish_one
from .store.songs import sha1_of, song_dir, unique_sid, validate_lyrics, wav_seconds, write_json
from .utils import now_iso, slug

log = logging.getLogger(__name__)

#: файлы, которые обязан привезти бандл GPU-сервиса (ничего сверх — не распаковываем)
BUNDLE_FILES = ("vocals.wav", "minus.wav", "lyrics.json", "pitch.json")


class PipelineError(RuntimeError):
    """Ожидаемая ошибка пайплайна: уходит в job.error, без trace в API."""


def run_job(job: Job, registry: JobRegistry, *, store: Path = STORE,
            gpu_factory=GpuClient, publisher=publish_one, fetcher=None,
            poll_interval: float | None = None, timeout_sec: float | None = None) -> None:
    """Выполнить задачу целиком; сам фиксирует done/error в реестре."""
    poll_interval = POLL_INTERVAL_SEC if poll_interval is None else poll_interval
    timeout_sec = JOB_TIMEOUT_SEC if timeout_sec is None else timeout_sec
    tmp = store / f".tmp-{job.id}"
    try:
        sid = _run(job, registry, store=store, gpu_factory=gpu_factory, fetcher=fetcher,
                   publisher=publisher, poll_interval=poll_interval, timeout_sec=timeout_sec)
    except Exception as e:
        _rmtree(tmp)
        log.exception("задача %s упала", job.id)
        registry.update(job.id, state="error", stage="error", error=str(e) or repr(e))
        return
    registry.update(job.id, state="done", stage="done", progress=100, song_id=sid)


def _run(job: Job, registry: JobRegistry, *, store: Path, gpu_factory, fetcher,
         publisher, poll_interval: float, timeout_sec: float) -> str:
    gpu = gpu_factory(KARAOKE_ML_SERVICE_URL)  # пустой URL — сразу понятная ошибка
    log.info("задача %s: GPU-пайплайн %s", job.id, KARAOKE_ML_SERVICE_URL or "(локально)")

    # пользовательский текст резолвим здесь (лёгкий HTTP), накладывает GPU-бокс
    custom_text = job.lyrics_text.strip()
    if not custom_text and job.lyrics_url.strip():
        custom_text = "\n".join(_fetch_lines(job.lyrics_url.strip(), fetcher))

    remote_id = gpu.submit_job(job.audio, job.lang, custom_text)
    _poll(gpu, remote_id, job, registry, interval=poll_interval, timeout_sec=timeout_sec)
    return _install(job, gpu.job_result(remote_id), store=store, gpu=gpu,
                    publisher=publisher)


def _poll(gpu, remote_id: str, job: Job, registry: JobRegistry,
          *, interval: float, timeout_sec: float) -> None:
    deadline = time.monotonic() + timeout_sec
    while True:
        st = gpu.job_status(remote_id)
        state = st.get("state")
        if state == "done":
            return
        if state == "error":
            raise PipelineError(st.get("error") or "GPU пайплайн упал")
        registry.update(job.id, stage=st.get("stage", "running"),
                        progress=int(st.get("progress") or 0))
        if time.monotonic() >= deadline:
            raise PipelineError(f"GPU-пайплайн не завершился за {timeout_sec:.0f} сек")
        time.sleep(interval)


def _install(job: Job, raw: bytes, *, store: Path, gpu, publisher) -> str:
    """Собрать песню во временном каталоге и атомарно влить в store, затем опубликовать."""
    tmp = store / f".tmp-{job.id}"
    _rmtree(tmp)
    tmp.mkdir(parents=True)
    try:
        _extract_bundle(raw, tmp)
        language, segments, skips = validate_lyrics(
            json.loads((tmp / "lyrics.json").read_text(encoding="utf-8")))
        payload = {"language": language, "segments": segments}
        if skips:
            payload["skips"] = skips
        write_json(tmp / "lyrics.json", payload)

        sid = unique_sid(store, slug(job.title))
        dest = song_dir(store, sid)
        if dest.exists():
            # sid свободен по meta.json, но каталог уже есть — это сирота без метаданных
            _rmtree(dest)
        now = now_iso()
        write_json(tmp / "meta.json",
                   _meta_for(job, sid, language, len(segments), now, gpu, tmp / "minus.wav"))
        os.replace(tmp, dest)  # атомарно: в store песня появляется целиком
    except BaseException:
        _rmtree(tmp)
        raise
    _publish(sid, publisher)
    return sid


def _publish(sid: str, publisher) -> None:
    """Паблиш с одним повтором: песня уже в store, молча терять публикацию нельзя."""
    try:
        publisher(sid)
    except Exception as e:
        log.warning("паблиш %s упал, повторяю: %s", sid, e)
        try:
            publisher(sid)
        except Exception as e2:
            raise PipelineError(f"Сохранено, но публикация упала: {e2}") from e2


def _meta_for(job: Job, sid: str, language: str, lines: int, now: str, gpu,
              minus: Path) -> dict:
    try:
        rel = str(job.audio.relative_to(ROOT))
    except ValueError:
        rel = str(job.audio)
    try:
        models = gpu.service_info()
    except GpuError as e:
        log.debug("нет /v1/info: %s", e)
        models = {}
    return {
        "id": sid,
        "title": job.title,
        "language": language,
        "duration": round(wav_seconds(minus), 1),
        "lines": lines,
        "source": {"file": rel, "sha1": sha1_of(job.audio) if job.audio.is_file() else None},
        "pipeline": {"via": "gpu-service", **models},
        "created": now,
        "updated": now,
    }


def _fetch_lines(url: str, fetcher) -> list[str]:
    if fetcher is None:
        from .lyrics import fetch_genius_lines
        fetcher = fetch_genius_lines
    try:
        return fetcher(url)
    except Exception as e:
        raise PipelineError(f"Не удалось забрать текст по ссылке: {e}") from e


def _extract_bundle(raw: bytes, dest: Path) -> None:
    limit = MAX_BUNDLE_MB * 1024 * 1024
    if len(raw) > limit:
        raise PipelineError(f"Бандл больше {MAX_BUNDLE_MB} МБ")
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names = z.namelist()
        extra = sorted(set(names) - set(BUNDLE_FILES))
        if extra:
            raise PipelineError(f"Бандл с посторонними файлами: {', '.join(extra)}")
        missing = [n for n in BUNDLE_FILES if n not in names]
        if missing:
            raise PipelineError(f"Бандл без {', '.join(missing)}")
        total = sum(i.file_size for i in z.infolist())
        if total > limit:
            raise PipelineError(f"Распакованный бандл больше {MAX_BUNDLE_MB} МБ")
        z.extractall(dest)


def _rmtree(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
