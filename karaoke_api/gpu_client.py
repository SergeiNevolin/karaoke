"""Клиент GPU-микросервиса: сабмит пайплайна, поллинг статуса, забор результата."""
from __future__ import annotations

import logging
import time
from pathlib import Path

import httpx

log = logging.getLogger(__name__)


class GpuError(RuntimeError):
    pass


class GpuClient:
    """GET ретраится на сетевых ошибках/5xx/429; POST — нет (сабмит не идемпотентен)."""

    def __init__(self, base_url: str, timeout: float = 1800.0,
                 retries: int = 3, backoff: float = 0.5):
        if not base_url or not base_url.strip():
            raise GpuError("GPU_URL не задан")
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self.retries = max(1, retries)
        self.backoff = backoff

    def _request(self, method: str, path: str, *, retry: bool, **kwargs) -> httpx.Response:
        call = httpx.get if method == "GET" else httpx.post
        err: GpuError | None = None
        for attempt in range(self.retries if retry else 1):
            if attempt:
                time.sleep(self.backoff * 2 ** (attempt - 1))
            try:
                r = call(f"{self.base}{path}", timeout=self.timeout, **kwargs)
            except httpx.TransportError as e:
                err = GpuError(f"GPU недоступен: {e}")
                log.warning("%s %s: сетевая ошибка (попытка %d/%d): %s",
                            method, path, attempt + 1, self.retries if retry else 1, e)
                continue
            if r.status_code == 200:
                return r
            err = GpuError(f"GPU {path}: HTTP {r.status_code}: {_error_msg(r)}")
            transient = r.status_code == 429 or r.status_code >= 500
            if not retry or not transient:
                raise err
            log.warning("%s %s: HTTP %s (попытка %d/%d)",
                        method, path, r.status_code, attempt + 1, self.retries)
        raise err if err is not None else GpuError(f"GPU {path}: запрос не выполнен")

    def submit_job(self, audio: Path, lang: str, text: str = "") -> str:
        """Сабмит полного пайплайна. Возвращает id задачи на GPU-боксе."""
        with open(audio, "rb") as f:
            r = self._request("POST", "/v1/jobs", retry=False,
                              files={"file": (audio.name, f)},
                              data={"lang": lang or "auto", "lyrics_text": text or ""})
        job_id = r.json().get("job_id")
        if not job_id:
            raise GpuError("GPU не вернул job_id")
        return job_id

    def job_status(self, job_id: str) -> dict:
        """{state, stage, progress, error?}."""
        return self._request("GET", f"/v1/jobs/{job_id}", retry=True).json()

    def job_result(self, job_id: str) -> bytes:
        """Готовый бандл (zip). 404 внутри — еще не готов."""
        return self._request("GET", f"/v1/jobs/{job_id}/result", retry=True).content

    def service_info(self) -> dict:
        """Модели GPU-сервиса: чем реально посчитано."""
        data = self._request("GET", "/v1/info", retry=True).json()
        return data if isinstance(data, dict) else {}

    def pitch(self, vocals: Path) -> dict:
        """Пошаговый pitch (для rebuild_pitch). -> {t, midi, conf?}."""
        with open(vocals, "rb") as f:
            r = self._request("POST", "/v1/pitch", retry=False,
                              files={"file": (vocals.name, f)})
        data = r.json()
        if not isinstance(data.get("t"), list) or not isinstance(data.get("midi"), list):
            raise GpuError("GPU pitch: нет t/midi в ответе")
        return data


def _error_msg(r: httpx.Response) -> str:
    try:
        msg = r.json().get("error")
        if msg:
            return str(msg)
    except Exception:  # noqa: BLE001
        pass
    return r.text[:200]
