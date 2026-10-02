# Караоке-система на RTX 5070 (Python)

Из песни отделяется вокал (Demucs), распознаётся текст с таймингами слов
(faster-whisper), строится эталон высоты тона (CREPE) — и запускается плеер
«как железные караоке»: минус + бегущая строка + микрофон + оценка.

## Архитектура

```
music/track.mp3
   │  Demucs htdemucs/htdemucs_ft (CUDA, 5070 ~15-40с/трек)
   ▼
output/<model>/<track>/{vocals.wav, no_vocals.wav}   # временное, GPU-шаги
   │  faster-whisper large-v3 (CUDA fp16, word_timestamps) + CREPE (CUDA)
   ▼
data/songs/<id>/          # КАНОН: meta, lyrics, pitch, waveform,
                          # vocals.wav, minus.wav, cache/*.mp3, history/
   │  export (паблиш)
   ▼
сервер отдаёт /api/* + /songs/*, фронт — web/dist
```

Бэкенд — пакет `karaoke_api/`:
- `karaoke_api/app.py` — `create_app()`: lifespan (старт/стоп воркера), хендлеры
  ошибок (`{"error"}` + честный статус), отдача `web/dist`
- `karaoke_api/api/` — роуты: `jobs.py` (upload стримом с лимитом, lyrics fetch
  через threadpool), `songs.py` (каталог, GET/PUT lyrics)
- `karaoke_api/registry.py` — реестр задач (in-memory, TTL), `karaoke_api/worker.py` —
  очередь и фоновый поток
- `karaoke_api/pipeline.py` — пайплайн задачи: опрос GPU, распаковка бандла
  (whitelist 4 файлов, атомарная запись), публикация
- `karaoke_api/gpu_client.py` — HTTP-клиент GPU-микросервиса (ретраи с backoff)
- `karaoke_api/store/` — хранилище `data/songs` (`songs.py` — атомарные записи,
  `publish.py` — паблиш в `data/public`)
- `karaoke_api/lyrics.py` — текстовые утилиты (Genius, SSRF-проверка; лёгкие,
  без GPU)
- `karaoke_api/cli/` — `export`, `rebuild_pitch`, `fixtures`
- `karaoke_api/config.py`, `errors.py`, `schemas.py`, `utils.py` — конфигурация
  и лимиты, `ApiError`, схемы Pydantic, общие утилиты

GPU-код — только в `karaoke_ml_service/` (`app.py`, `pipeline.py`, `core/`).
Клиент сервиса живёт в основном бэкенде: `karaoke_api/gpu_client.py`.

Тесты: `python -m pytest -q` (обе папки из `pyproject.toml`), линт:
`python -m ruff check karaoke_api karaoke_ml_service`


## Быстрый старт

```powershell
# 1. зависимости: VDS без GPU — лёгкий файл, машина с GPU — полный
pip install -r requirements-api.txt  # API + store + очередь
pip install -r requirements-gpu.txt     # + torch/Demucs/Whisper/CREPE

# 2. песня — через кнопку «Загрузить» в интерфейсе: бэкенд сам прогонит
#    Demucs → Whisper → CREPE, опубликует результат и покажет стадии.
#    Прямой сабмит в GPU-сервис:
#    curl -F file=@music/track.mp3 -F lang=ru http://localhost:8001/v1/jobs
```

## Веб-интерфейс + загрузка песен

```powershell
python -m uvicorn karaoke_api.app:app --port 8000   # бэкенд (терминал 1)
cd web; npm install; npm run dev               # фронт (терминал 2)
```

Кнопка «Загрузить» в каталоге принимает аудио, а бэкенд в фоне
прогоняет тот же GPU-пайплайн (Demucs → Whisper → pitch → экспорт)
со статусом по стадиям. Детали — в `web/README.md`.

## Docker

```powershell
docker compose up --build   # http://localhost:8002
```

- multi-stage образ (`karaoke_api/Dockerfile`): node:24 собирает фронт
  (tsc + vite), python:3.11-slim c ffmpeg отдаёт API/статику; non-root
  uid 10001, `HEALTHCHECK` по `GET /healthz` (эта точка авторизацию не спрашивает);
- данные песен — `./data` (compose-маппинг), каталоги `data/songs` (канон)
  и `data/public/songs` (публичный);
- env: `AUTH_JWT_SECRET`, `KARAOKE_ML_SERVICE_URL`, `LOG_LEVEL`,
  `MAX_UPLOAD_MB`, `MAX_BUNDLE_MB` — полный список с дефолтами в `.env.example`;
  невалидные значения отваливаются на старте (`validate_config`);
- CI (`.github/workflows/ci.yml`): ruff + pytest лёгкого рантайма, веб-сборка
  и тесты, сборка образа и пуш `ghcr.io/<owner>/<repo>:<branch|semver|sha>`
  на push в main/теги (нужен remote репозитория).

## Интеграция с bebradio (префикс /karaoke/)

Караоке встраивается в bebradio как отдельный сервис и открыт в UI на
`/karaoke` (iframe; см. bebradio, раздел «Караоке»): nginx проксирует
`/karaoke/` → `karaoke-api:8000`, авторизация — общий JWT
(`AUTH_JWT_SECRET` = `SECRET_KEY` bebradio, HS256, клеймы `sub`+`exp`).

- сборка под префикс:
  `docker build -f karaoke_api/Dockerfile --build-arg BASE_PATH=/karaoke/ --build-arg API_BASE=/karaoke .`
- веб в dev-режиме bebradio: `cd web; npm run dev:bebradio` (база `/karaoke/`);
  если Go-бэкенд bebradio занял порт 8000 — свой API поднимите на другом:
  `KARAOKE_API_URL=http://127.0.0.1:8010 npm run dev:bebradio`;
- локальный vite-прокси bebradio ходит в `KARAOKE_URL` (дефолт
  `http://localhost:5173` — тот самый `dev:bebradio`).

## GPU-микросервис (опционально)

Тяжёлые шаги (Demucs/Whisper/CREPE) живут в GPU-микросервисе
(`karaoke_ml_service/`) — воркер без него песни не собирает:

```powershell
# на GPU-боксе (или в докере: docker build -f karaoke_ml_service/Dockerfile -t karaoke-ml .)
uvicorn karaoke_ml_service.app:app --host 0.0.0.0 --port 8001

# на бэкенде (обязательно):
$env:KARAOKE_ML_SERVICE_URL = "http://<gpu-host>:8001"
python -m uvicorn karaoke_api.app:app --port 8000
```

Если GPU-микросервис недоступен по `KARAOKE_ML_SERVICE_URL`, загрузка новых
падает с понятной ошибкой; чтение каталога и правки работают без GPU.
Поток: бэкенд сабмитит аудио в `POST /v1/jobs`, поллит статус и забирает
готовый бандл. Детали — в `karaoke_ml_service/README.md`.

## Статусы API (контракт)

Все ошибки — тело `{"error": "..."}` и честный HTTP-статус:

| Ситуация | Ответ |
|---|---|
| любой `/api/*` или `/songs/*` без валидного JWT (env `AUTH_JWT_SECRET` задан) | **401** `{"error": "Требуется вход в bebradio"}` |
| `POST /api/upload`: неверное расширение | **400** |
| `POST /api/upload`: больше `MAX_UPLOAD_MB` (env, дефолт 1024) | **413** |
| `GET /api/jobs/{id}`: задача неизвестна (истек TTL / рестарт) | **404** |
| `GET /api/lyrics/fetch`: плохой URL / нет текста | **400** |
| `GET /api/lyrics/fetch`: сбой upstream (Genius) | **502** |
| `GET /api/songs/{id}/lyrics`: песни нет | **404** |
| `PUT .../lyrics`: невалидный payload (и 422 FastAPI) | **400** |
| `PUT .../lyrics`: песня не найдена | **404** |
| `PUT .../lyrics`: ок, но публикация упала (данные сохранены) | **200** `{ok, lines, warning?}` |
| необработанное исключение | **500** + `logging.exception` |

Контракт GPU-микросервиса (400/404/413/429/500) — в
`karaoke_ml_service/README.md`.

## Эксплуатация

- **Один uvicorn-воркер**: `python -m uvicorn karaoke_api.app:app --port 8000` —
  реестр задач и очередь воркера живут in-memory, несколько воркеров не
  видели бы чужих задач. То же касается `karaoke_ml_service` (плюс GPU-семафор).
- Рестарт = выполняемые задачи теряются; завершённые чистятся по
  `JOB_TTL_SEC`. Прод-многопроцессности нужна внешняя очередь (Redis) —
  осознанно вне объёма.
- Логи: `logging`, уровень `LOG_LEVEL` из env; job id — в префиксах.

## Отдельные шаги

```powershell
python -m karaoke_api.cli.export [--only <id>]   # паблиш data/songs -> серверу
python -m karaoke_api.cli.rebuild_pitch [--only <id>]
```

## Заметки под 5070 (12 ГБ, sm_120)

- Нужен torch ≥2.7 cu128 (у вас 2.11 — ок). Demucs гоняйте с `-d cuda`.
- `--two-stems vocals` даёт только минус+вокал: быстрее и меньше VRAM.
- Whisper `float16` на 5070 — оптимально; `large-v3` лучше всех тянет русский.
- Если Demucs падает с OOM — берите `htdemucs` вместо `htdemucs_ft`.
- Микрофон: если `sounddevice` не видит устройство — `python -m sounddevice`, затем `--mic N`.

## Что дальше (идеи)

- Тональность/темп минуса (rubberband / pedalboard), реверб на микрофон.
- Dual-screen: оператор + экран певца. Очередь песен, топ-100.
- Улучшенный скоринг в реальном времени (aubio pitch + отрисовка нот UltraStar-style).
