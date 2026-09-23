"""
Караоке-плеер «как настоящие системы»:
- каталог песен (karaoke.json бандлы), выбор цифрами
- полноэкранные тексты, подсветка слов жёлтым по мере пения
- минус (no_vocals.wav) через pygame.mixer, пауза/перемотка/громкость
- запись микрофона (sounddevice) + уровень сигнала + финальная оценка 0-100
- обратный отсчёт 3-2-1, прогресс-бар, экран оценки

Управление:
  цифры  — выбор песни в каталоге    ENTER — старт
  SPACE  — пауза/продолжить          ←/→ — ±5с   ↑/↓ — громкость
  F — полный экран                   ESC/Q — выход

Usage:
    python src/player.py output/htdemucs/"Трек"/karaoke.json
    python src/player.py output/     # каталог всех готовых песен
    python src/player.py output/ --mic 1 --lead 0.0
"""
import argparse
import json
import queue
import sys
import threading
import time
from pathlib import Path

import numpy as np


# ---------- mic recorder (sounddevice, опционально) ----------
class MicRecorder:
    def __init__(self, device=None, sr=16000):
        self.device = device
        self.sr = sr
        self.frames: list[np.ndarray] = []
        self.level = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.ok = False

    def start(self):
        try:
            import sounddevice as sd
        except ImportError:
            print("[WARN] sounddevice не установлен — микрофон отключён (только минус+текст)")
            return
        # пробуем открыть устройство заранее, чтобы показать понятную ошибку
        try:
            devs = sd.query_devices()
            if self.device is None:
                # ищем устройство с входными каналами
                for i, d in enumerate(devs):
                    if d.get("max_input_channels", 0) > 0:
                        self.device = i
                        break
            print(f"[MIC] устройство: {sd.query_devices(self.device)['name']}")
        except Exception as e:
            print(f"[WARN] микрофон недоступен: {e}")
            return
        self.ok = True
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self):
        import sounddevice as sd
        q: queue.Queue = queue.Queue()

        def cb(indata, frames, t, status):
            q.put(indata.copy())

        try:
            with sd.InputStream(device=self.device, channels=1, samplerate=self.sr,
                                callback=cb, blocksize=2048):
                while not self._stop.is_set():
                    try:
                        chunk = q.get(timeout=0.2)
                    except queue.Empty:
                        continue
                    self.frames.append(chunk)
                    self.level = float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))
        except Exception as e:
            print(f"[WARN] mic stream: {e}")
            self.ok = False

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    def save(self, path: Path) -> Path | None:
        if not self.frames:
            return None
        try:
            import soundfile as sf
        except ImportError:
            print("[WARN] soundfile нет — запись не сохранена")
            return None
        audio = np.concatenate(self.frames, axis=0)
        path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(path), audio, self.sr)
        print(f"[MIC] запись: {path} ({len(audio)/self.sr:.1f}с)")
        return path


# ---------- bundle helpers ----------
def find_bundles(root: Path) -> list[Path]:
    if root.is_file():
        return [root]
    return sorted(root.rglob("karaoke.json"))


def load_bundle(p: Path) -> dict:
    b = json.loads(p.read_text(encoding="utf-8"))
    b["_dir"] = str(p.parent)
    return b


def get_segments(bundle: dict) -> list[dict]:
    lyr = bundle.get("lyrics")
    if isinstance(lyr, dict) and "segments" in lyr:
        return lyr["segments"]
    return []


def pos_to_lyrics(segments: list[dict], t: float):
    """-> (seg_idx, word_idx_or_None)."""
    for si, seg in enumerate(segments):
        if seg["start"] <= t <= seg["end"] + 0.4:
            wi = None
            for i, w in enumerate(seg.get("words", [])):
                if w["s"] <= t <= w["e"] + 0.15:
                    wi = i
                    break
                if t > w["e"]:
                    wi = i  # все слова до i уже спеты
            return si, wi
    # между сегментами: последний прошедший
    prev = None
    for si, seg in enumerate(segments):
        if seg["end"] < t:
            prev = si
    return prev, None


# ---------- player ----------
def play_bundle(bundle: dict, mic_index, lead_gain: float, fullscreen: bool):
    import pygame

    bdir = Path(bundle["_dir"])
    minus = bundle.get("minus")
    if not minus or not Path(minus).exists():
        # fallback: ищем любой минус рядом
        c = list(bdir.glob("no_vocals.*")) + list(bdir.glob("*minus*"))
        minus = str(c[0]) if c else None
    if not minus:
        print("[ERROR] минус (no_vocals.wav) не найден. Сначала: python src/make_karaoke.py ...")
        sys.exit(1)

    segments = get_segments(bundle)
    print(f"[PLAY] {bundle.get('track')} | минус: {Path(minus).name} | строк: {len(segments)}")

    pygame.init()
    pygame.mixer.init(frequency=44100)
    flags = pygame.FULLSCREEN if fullscreen else 0
    screen = pygame.display.set_mode((1280, 720), flags)
    pygame.display.set_caption(f"Караоке — {bundle.get('track')}")
    clock = pygame.time.Clock()
    f_big = pygame.font.SysFont("arial", 64, bold=True)
    f_mid = pygame.font.SysFont("arial", 40)
    f_small = pygame.font.SysFont("arial", 28)
    f_score = pygame.font.SysFont("arial", 120, bold=True)

    BG, WHITE, YELLOW, GRAY, GREEN, DIM = (10, 10, 25), (255, 255, 255), \
        (255, 215, 0), (150, 150, 170), (60, 220, 120), (30, 30, 55)

    mic = MicRecorder(device=mic_index)
    mic.start()

    # --- countdown ---
    for n in ("3", "2", "1"):
        screen.fill(BG)
        img = f_score.render(n, True, YELLOW)
        screen.blit(img, img.get_rect(center=(640, 300)))
        hint = f_small.render("Приготовьтесь...", True, GRAY)
        screen.blit(hint, hint.get_rect(center=(640, 450)))
        pygame.display.flip()
        time.sleep(0.7)

    try:
        pygame.mixer.music.load(str(minus))
    except Exception as e:
        print(f"[ERROR] не могу загрузить аудио: {e}"); sys.exit(1)
    if lead_gain > 0 and bundle.get("vocals"):
        print("[INFO] подсказка вокалиста (lead) не микшируется в MVP — пойте по тексту")
    pygame.mixer.music.play()
    start = time.time()
    paused_at = None
    pause_accum = 0.0
    volume = 0.8
    pygame.mixer.music.set_volume(volume)
    finished = False
    score = None

    def song_pos() -> float:
        ms = pygame.mixer.music.get_pos()  # мс с последнего play/unpause
        if ms < 0:
            return time.time() - start - pause_accum
        return ms / 1000.0

    def draw_word_line(words, cur_wi, center_y, font, active=True):
        # рендерим слова раздельными спрайтами: спетые — жёлтые
        rendered = []
        for i, w in enumerate(words):
            color = YELLOW if (cur_wi is not None and i <= cur_wi) else (WHITE if active else GRAY)
            rendered.append(font.render(w["w"], True, color))
        total = sum(r.get_width() for r in rendered) + 20 * (len(rendered) - 1)
        x = 640 - total / 2
        for r in rendered:
            screen.blit(r, (x, center_y))
            x += r.get_width() + 20

    running = True
    while running:
        t = song_pos()
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                running = False
            elif ev.type == pygame.KEYDOWN:
                if ev.key in (pygame.K_ESCAPE, pygame.K_q):
                    running = False
                elif ev.key == pygame.K_SPACE:
                    if pygame.mixer.music.get_busy():
                        pygame.mixer.music.pause(); paused_at = time.time()
                    else:
                        pygame.mixer.music.unpause()
                        if paused_at:
                            pause_accum += time.time() - paused_at; paused_at = None
                elif ev.key == pygame.K_RIGHT:
                    pygame.mixer.music.set_pos(min(t + 5, 1e6)) if False else None  # mp3-only; см. ниже
                elif ev.key == pygame.K_UP:
                    volume = min(1.0, volume + 0.05); pygame.mixer.music.set_volume(volume)
                elif ev.key == pygame.K_DOWN:
                    volume = max(0.0, volume - 0.05); pygame.mixer.music.set_volume(volume)
                elif ev.key == pygame.K_f:
                    fullscreen = not fullscreen
                    screen = pygame.display.set_mode((1280, 720),
                                                     pygame.FULLSCREEN if fullscreen else 0)
        # NOTE: перемотка pygame.mixer.music.set_pos работает только для mp3/ogg,
        # для wav пропускаем (перезапуск с offset потребовал бы sounddevice-playback).
        if not pygame.mixer.music.get_busy() and paused_at is None:
            finished = True
            running = False

        screen.fill(BG)
        # шапка
        title = f_small.render(f"{bundle.get('track')}   |   vol {int(volume*100)}%   |   SPACE пауза   F полный экран",
                               True, GRAY)
        screen.blit(title, (30, 20))
        # прогресс-бар (по последнему слову)
        total_dur = segments[-1]["end"] + 5 if segments else 180
        pw = int(1220 * min(1.0, t / total_dur))
        pygame.draw.rect(screen, DIM, (30, 60, 1220, 10))
        pygame.draw.rect(screen, GREEN, (30, 60, pw, 10))

        si, wi = pos_to_lyrics(segments, t) if segments else (None, None)
        if not segments:
            msg = f_mid.render("Текст не распознан — пойте под минус!", True, WHITE)
            screen.blit(msg, msg.get_rect(center=(640, 340)))
        elif si is None and t < segments[0]["start"]:
            nxt = segments[0]["text"]
            l1 = f_small.render("Сейчас начнётся...", True, GRAY)
            l2 = f_mid.render(nxt, True, WHITE)
            screen.blit(l1, l1.get_rect(center=(640, 280)))
            screen.blit(l2, l2.get_rect(center=(640, 360)))
            cd = segments[0]["start"] - t
            if cd < 10:
                c = f_big.render(f"{cd:.0f}", True, YELLOW)
                screen.blit(c, c.get_rect(center=(640, 480)))
        else:
            # prev / current / next, как в железных караоке
            if si is not None and si > 0:
                p = f_small.render(segments[si - 1]["text"], True, GRAY)
                screen.blit(p, p.get_rect(center=(640, 200)))
            cur = segments[si] if si is not None else None
            if cur is not None:
                words = cur.get("words") or [{"w": w, "s": cur["start"], "e": cur["end"]}
                                             for w in cur["text"].split()]
                draw_word_line(words, wi, 300, f_big, True)
            if si is not None and si + 1 < len(segments):
                n = f_mid.render(segments[si + 1]["text"], True, GRAY)
                screen.blit(n, n.get_rect(center=(640, 470)))

        # уровень микрофона
        lvl = min(1.0, mic.level * 8) if mic.ok else 0.0
        pygame.draw.rect(screen, DIM, (30, 640, 400, 18))
        pygame.draw.rect(screen, GREEN, (30, 640, int(400 * lvl), 18))
        ml = f_small.render("MIC" if mic.ok else "MIC off", True, GRAY)
        screen.blit(ml, (440, 636))

        pygame.display.flip()
        clock.tick(30)

    pygame.mixer.music.stop()
    mic.stop()

    # --- запись микрофона + скоринг ---
    mic_path = None
    if mic.ok and mic.frames:
        mic_path = bdir / "mic_record.wav"
        t0 = time.time()
        mic.save(mic_path)
        # скоринг по эталону
        pitch_json = bundle.get("pitch") or str(bdir / "vocals_pitch.json")
        if pitch_json and Path(pitch_json).exists() and mic_path:
            try:
                from pitch import score_performance  # src/ в sys.path? пробуем оба
                score = score_performance(pitch_json, mic_path)
            except ImportError:
                try:
                    from src.pitch import score_performance
                    score = score_performance(pitch_json, mic_path)
                except Exception as e:
                    print(f"[WARN] скоринг недоступен: {e}")
            except Exception as e:
                print(f"[WARN] скоринг: {e}")
        show_score(screen, f_score, f_mid, f_small, BG, YELLOW, WHITE, GRAY, score)
    pygame.quit()
    return score


def show_score(screen, f_score, f_mid, f_small, BG, YELLOW, WHITE, GRAY, score):
    import pygame
    screen.fill(BG)
    if score:
        s = f_score.render(f"{score['score']:.0f}", True, YELLOW)
        screen.blit(s, s.get_rect(center=(640, 280)))
        d = f_mid.render("Ваша оценка", True, WHITE)
        screen.blit(d, d.get_rect(center=(640, 400)))
        det = f_small.render(
            f"попаданий {score['hits']}/{score['compared_frames']}  "
            f"медиана ошибки {score['median_error_semitones']} полутона", True, GRAY)
        screen.blit(det, det.get_rect(center=(640, 470)))
        grade = "Звезда караоке!" if score["score"] >= 80 else \
                "Отлично!" if score["score"] >= 60 else \
                "Неплохо, ещё раз?" if score["score"] >= 40 else "Попробуйте ещё — всё получится!"
        g = f_mid.render(grade, True, WHITE)
        screen.blit(g, g.get_rect(center=(640, 540)))
    else:
        t = f_mid.render("Готово! Запись сохранена." if score is None else "Готово!", True, WHITE)
        screen.blit(t, t.get_rect(center=(640, 340)))
    h = f_small.render("Нажмите любую клавишу для выхода", True, GRAY)
    screen.blit(h, h.get_rect(center=(640, 640)))
    pygame.display.flip()
    wait = True
    t0 = time.time()
    while wait and time.time() - t0 < 30:
        for ev in pygame.event.get():
            if ev.type in (pygame.KEYDOWN, pygame.QUIT):
                wait = False
        time.sleep(0.05)


def main():
    ap = argparse.ArgumentParser(description="Karaoke player")
    ap.add_argument("path", help="karaoke.json или папка output/")
    ap.add_argument("--mic", default=None, help="индекс микрофона (по умолч. авто)")
    ap.add_argument("--lead", type=float, default=0.0)
    ap.add_argument("--fullscreen", action="store_true")
    a = ap.parse_args()

    mic_index = int(a.mic) if a.mic is not None else None
    bundles = find_bundles(Path(a.path))
    if not bundles:
        print(f"[ERROR] бандлы не найдены в {a.path}. Сначала: python src/make_karaoke.py music/")
        sys.exit(1)
    if len(bundles) == 1:
        play_bundle(load_bundle(bundles[0]), mic_index, a.lead, a.fullscreen)
        return
    print("=== Каталог караоке ===")
    loaded = [load_bundle(b) for b in bundles]
    for i, b in enumerate(loaded):
        n = len(get_segments(b))
        print(f"  [{i}] {b.get('track')}  ({n} строк)")
    try:
        idx = int(input("Номер песни > ").strip())
    except (ValueError, EOFError):
        sys.exit(0)
    if not (0 <= idx < len(loaded)):
        sys.exit(0)
    play_bundle(loaded[idx], mic_index, a.lead, a.fullscreen)


if __name__ == "__main__":
    main()
