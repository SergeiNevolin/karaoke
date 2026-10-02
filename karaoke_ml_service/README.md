# karaoke_ml_service — GPU-микросервис (Demucs + Whisper + CREPE)

Отдельный процесс на машине с видеокартой. Основной бэкенд (`karaoke_api/`)
ходит сюда по HTTP, когда задан `GPU_URL`.

## Карта модулей

- `app.py` — FastAPI: роуты, приём файла (чанками, лимит), жизненный цикл
  (lifespan вычищает осиротевшие каталоги задач), сборка zip-бандла.
- `pipeline.py` — `KaraokePipeline.run()`: оркестратор шагов Demucs →
  Whisper → CREPE; кэш модели whisper; `on_stage(stage, progress)` —
  колбэк прогресса (ключи синхронны с `karaoke_api.config.STAGE_LABELS`).
- `jobs.py` — `Job`/`JobRegistry`: состояние в памяти, результат на диске,
  TTL-очистка завершённых задач (`RESULT_TTL_SEC`).
- `config.py` — пути, лимиты, имена моделей, `STAGE_PROGRESS`, `LOG_LEVEL`.
- `errors.py` — `ApiError` + хендлеры: тело `{"error": ...}` и честный
  HTTP-статус (включая 500 с `logging.exception`).
- `core/` — обёртки-классы над тяжёлым кодом:
  `VocalSeparator`, `Transcriber`, `PitchExtractor`, `PitchScorer`
  (файлы `separate.py`, `transcribe.py`, `pitch.py`, `lyrics.py`);
  консольных entry-point'ов нет — шаги запускает только
  `KaraokePipeline`. Внутренности `core/` (DP-логика наложения текста,
  метрики скоринга) — вне объёма рефакторинга.
- `tests/` — контракты endpoints, жизненный цикл задач, классы-обёртки;
  `fakes.py` — фейковые шаги, тесты идут без torch/моделей.
- `Dockerfile` — сборка из корня репо (см. комментарий внутри).

Клиент (`GpuClient`) живёт в основном бэкенде: `karaoke_api/gpu_client.py`
(им пользуется `karaoke_api/worker.py`), его тесты — в `tests/test_gpu_client.py`.

## API

| Endpoint | Назначение |
|---|---|
| `POST /v1/jobs` (файл, `lang`, `lyrics_text`) | весь пайплайн; принимает аудио и видео (ffmpeg-демьюкс тут же); → `{job_id}` |
| `GET /v1/jobs/{id}` | статус: `{state, stage, progress, error?}` |
| `GET /v1/jobs/{id}/result` | готовый zip `{vocals.wav, minus.wav, lyrics.json, pitch.json}` |
| `GET /v1/info` | `{demucs, whisper, pitch}` — чем реально считаем |
| `POST /v1/pitch` | пошаговый pitch (для `rebuild_pitch`): `{t, midi, conf}`, без семафора |

### Статусы

| Ситуация | Ответ |
|---|---|
| неверное расширение файла / `lang` / пустой файл / слишком длинный `lyrics_text` | **400** `{"error"}` |
| файл больше `MAX_UPLOAD_MB` | **413** |
| GPU занят другим пайплайном (семафор) | **429** |
| задача не найдена / результат не готов | **404** |
| `/v1/pitch`: передано не аудио (в т.ч. видео) | **400** |
| ошибка валидации запроса (422 FastAPI) | **400** |
| необработанное исключение | **500** `{"error"}` + `logging.exception` |

Пошаговые `/v1/separate` и `/v1/transcribe` удалены; бэкенд использует
только job API + `/v1/pitch`. Консольных запусков в сервисе нет —
отладка шагов идёт через импорт классов или прямые HTTP-вызовы.

## Эксплуатация

- **Один uvicorn-воркер** (`uvicorn karaoke_ml_service.app:app ...`):
  реестр задач и GPU-семафор — in-memory, несколько воркеров перестали бы
  видеть чужие задачи и держали бы по одному «своему» GPU-слоту.
- Рестарт = потеря задач: при старте `lifespan` вычищает каталог `JOBS_DIR`,
  результаты живут по `RESULT_TTL_SEC` и удаляются по TTL.
- Логи: `logging`, уровень `LOG_LEVEL` из env; job id — в префиксах.

Запуск:

```powershell
uvicorn karaoke_ml_service.app:app --host 0.0.0.0 --port 8001
```

Сборка/запуск в докере (из корня репо):

```powershell
docker build -f karaoke_ml_service/Dockerfile -t karaoke-ml .
docker run --gpus all -p 8001:8001 karaoke-ml
```

Тесты: `python -m pytest karaoke_ml_service/tests/ -q` (или `python -m pytest -q`
из корня — соберёт обе папки).
