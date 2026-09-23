# Караоке-система на RTX 5070 (Python)

Из песни отделяется вокал (Demucs), распознаётся текст с таймингами слов
(faster-whisper), строится эталон высоты тона — и запускается плеер
«как железные караоке»: минус + бегущая строка + микрофон + оценка.

## Архитектура

```
music/track.mp3
   │  Demucs htdemucs/htdemucs_ft (CUDA, 5070 ~15-40с/трек)
   ▼
output/<model>/<track>/{vocals.wav, no_vocals.wav}   # no_vocals = минус
   │  faster-whisper large-v3 (CUDA fp16, word_timestamps)
   ▼
   vocals_lyrics.json + vocals.lrc + vocals.txt
   │  librosa.pyin (CPU, один раз)
   ▼
   vocals_pitch.json  ── эталон для скоринга
   karaoke.json       ── единый бандл для плеера
```

Плеер (`src/player.py`, pygame):
- каталог песен, обратный отсчёт, полноэкранный текст,
  подсветка слов, прогресс-бар, пауза/громкость,
  запись микрофона (sounddevice) + оценка 0–100 (pitch-class ±1 полутон).

## Быстрый старт

```powershell
# 1. зависимости (torch cu128 уже стоит — не трогайте)
pip install -r requirements.txt

# 2. собрать одну песню (быстрый режим htdemucs, русский)
python src/make_karaoke.py "music/Серега Пират - Прости я не знаю.mp3" --model htdemucs --whisper large-v3 --lang ru

# 2b. максимальное качество (медленнее, чище минус)
python src/make_karaoke.py "music/Серега Пират - Прости я не знаю.mp3" --model htdemucs_ft --whisper large-v3 --lang ru

# 3. петь!
python src/player.py output/
```

## Веб-интерфейс + загрузка песен

```powershell
python -m uvicorn server.app:app --port 8000   # бэкенд (терминал 1)
cd web; npm install; npm run dev               # фронт (терминал 2)
```

Кнопка «Загрузить» в каталоге принимает аудио, а бэкенд в фоне
прогоняет тот же GPU-пайплайн (Demucs → Whisper → pitch → экспорт)
со статусом по стадиям. Детали — в `web/README.md`.

## Отдельные шаги

```powershell
python src/separate.py music/ --out output --model htdemucs --two-stems vocals
python src/transcribe.py output/htdemucs/"Трек"/vocals.wav --lang ru --model large-v3
python src/pitch.py output/htdemucs/"Трек"/vocals.wav
python src/player.py output/htdemucs/"Трек"/karaoke.json
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
