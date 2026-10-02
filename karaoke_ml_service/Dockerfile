# GPU-микросервис караоке (Demucs + Whisper + CREPE).
# Сборка (из корня репо):  docker build -f karaoke_ml_service/Dockerfile -t karaoke-ml .
# Запуск:  docker run --gpus all -p 8001:8001 karaoke-ml
# Бэкенд:  GPU_URL=http://<gpu-host>:8001 uvicorn karaoke_api.app:app --port 8000
FROM nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3.11 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements-api.txt requirements-gpu.txt ./
RUN pip install --no-cache-dir -r requirements-gpu.txt
COPY karaoke_api/ karaoke_api/
COPY karaoke_ml_service/ karaoke_ml_service/

EXPOSE 8001
CMD ["uvicorn", "karaoke_ml_service.app:app", "--host", "0.0.0.0", "--port", "8001"]
