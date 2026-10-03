# syntax=docker/dockerfile:1
# Контекст сборки — корень репо (см. docker-compose.yml / CI).

# ---- фронт: сборка React (без префикса для standalone, /karaoke/ — для bebradio) ----
FROM node:24-alpine AS web
ARG BASE_PATH=/
ARG API_BASE=
ARG AUTH_STORAGE_KEY=token
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npx tsc --noEmit \
 && VITE_API_BASE="${API_BASE}" VITE_AUTH_STORAGE_KEY="${AUTH_STORAGE_KEY}" \
    npx vite build --base="${BASE_PATH}"

# ---- бэкенд: лёгкий API (никаких torch/demucs/whisper/ffmpeg) ----
FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
# ffmpeg здесь НЕ нужен: mp3 кодирует GPU-сервис и привозит их в бандле
WORKDIR /app
COPY requirements-api.txt ./
RUN pip install -r requirements-api.txt
COPY karaoke_api/ ./karaoke_api/
COPY --from=web /src/web/dist ./web/dist
RUN useradd --system --uid 10001 --create-home karaoke \
 && mkdir -p /app/data /app/music \
 && chown -R karaoke:karaoke /app/data /app/music
USER karaoke
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4)"
CMD ["uvicorn", "karaoke_api.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
