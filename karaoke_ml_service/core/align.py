"""
Точное выравнивание слов (forced alignment) — второй проход после Whisper.

Проблема: faster-whisper word_timestamps — побочный продукт attention,
систематически спешат на 100-300 мс (особенно с vad_filter, режущим трек
на куски). Лечится разделением задач:
  1) Whisper отвечает только за ТЕКСТ и грубые сегменты;
  2) этот модуль перерасставляет ГРАНИЦЫ слов по акустике.

Два уровня (первый доступный применяется):
  CTC   — wav2vec2 XLSR + Viterbi по emissions (~20 мс/фрейм, точность
          30-50 мс). Требует transformers + скачанную модель;
          без них — молча пропускается (лог warning).
  snap  — каждое начало слова дотягивается к ближайшему onset'у энергии
          в vocals.wav (окно ALIGN_WINDOW_SEC, предпочтение вперёд —
          именно туда, куда Whisper систематически спешит).
          Нулевые зависимости сверх librosa; без librosa — no-op.

Чистые функции (norm_for_align, snap_words_to_onsets, _encode_transcript,
_ctc_word_times) — без моделей, покрыты тестами. Тяжёлые импорты
(transformers/torch/librosa) — только внутри функций, чтобы лёгкие
тесты и импорт модуля никогда не падали.
"""
from __future__ import annotations

import gc
import logging
import re
from pathlib import Path

log = logging.getLogger(__name__)

#: шаг фреймов wav2vec2/XLSR: stride 320 при 16 кГц
FRAME_DUR = 320.0 / 16000.0
#: mono для алайнера
ALIGN_SR = 16000


def r3(v: float) -> float:
    return round(float(v), 3)


def norm_for_align(text: str) -> str:
    """Нормализовать текст под словарь CTC: нижний регистр, ё->е, мусор — в пробелы."""
    s = (text or "").lower().replace("ё", "е")
    s = re.sub(r"[^a-zа-я0-9'’\- ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def snap_words_to_onsets(words: list[dict], onsets: list[float],
                         seg_s: float, seg_e: float,
                         window: float = 0.25) -> tuple[list[dict], dict]:
    """Дотянуть начала слов к ближайшим onset'ам (опоздание лечим, спешку — нет).

    Каждое слово сдвигается целиком (длительность сохраняется), вперёд —
    с весом 1.0, назад — со штрафом x1.5: Whisper спешит, поэтому тянем
    преимущественно вперёд. Без onset'а в окне слово не трогаем.
    Возвращает (новые слова, статистика).
    """
    seg_s, seg_e = r3(seg_s), r3(seg_e)
    out: list[dict] = []
    snapped = 0
    shifts: list[float] = []
    prev_e = seg_s
    for w in words:
        s = r3(max(seg_s, min(float(w.get("s", seg_s)), seg_e)))
        e = r3(max(seg_s, min(float(w.get("e", seg_e)), seg_e)))
        dur = max(0.0, e - s)
        best: float | None = None
        best_score = window
        for o in onsets:
            d = abs(o - s)
            if d > window:
                continue
            score = d * (1.5 if o < s else 1.0)
            if score < best_score:
                best_score = score
                best = o
        ns = r3(best if best is not None else s)
        ns = max(ns, prev_e)
        ne = r3(min(ns + dur, seg_e))
        if ne < ns:
            ne = ns
        if best is not None and ne > seg_s:
            snapped += 1
            shifts.append(ns - s)
        out.append({**w, "s": ns, "e": ne})
        prev_e = ne
    stats = {"snapped": snapped, "total": len(words),
             "mean_shift": round(sum(shifts) / len(shifts), 3) if shifts else 0.0}
    return out, stats


def compute_onsets(vocals: Path, sr: int = 22050) -> list[float]:
    """Onsets энергии по vocals.wav (librosa). Без librosa/аудио — []."""
    try:
        import librosa
    except ImportError:
        log.warning("librosa нет — onset-снап пропущен")
        return []
    try:
        y, _ = librosa.load(str(vocals), sr=sr, mono=True)
        if len(y) < sr // 10:
            return []
        env = librosa.onset.onset_strength(y=y, sr=sr)
        det = librosa.onset.onset_detect(onset_envelope=env, sr=sr, units="time",
                                         backtrack=False, normalize=True,
                                         pre_max=3, post_max=3, pre_avg=10,
                                         post_avg=10, delta=0.2, wait=5)
        return [r3(float(t)) for t in det]
    except Exception:
        log.exception("onsets не посчитались, снап пропущен")
        return []


def _encode_transcript(text: str, vocab: dict[str, int],
                       blank: int = 0) -> tuple[list[int], list[tuple[str, int, int]]]:
    """Текст -> (ids меток CTC, [(слово, s_tok, e_tok)]). Неизвестные буквы дропаются."""
    sep = vocab.get("|")
    labels: list[int] = []
    ranges: list[tuple[str, int, int]] = []
    first = True
    for w in norm_for_align(text).split():
        if not first and sep is not None and sep != blank:
            labels.append(sep)
        first = False
        s = len(labels)
        for ch in w:
            tid = vocab.get(ch)
            if tid is None:
                tid = vocab.get(ch.upper(), vocab.get(ch.lower()))
            if tid is None or tid == blank:
                continue
            labels.append(tid)
        ranges.append((w, s, len(labels)))
    return labels, ranges


def _ctc_word_times(log_probs, labels: list[int],
                    ranges: list[tuple[str, int, int]],
                    blank: int, frame_dur: float, offset: float) -> list[tuple[float, float, float]]:
    """Viterbi-треллис CTC -> [(s, e, conf)] на слово. Чистая, без моделей.

    log_probs: Tensor[T, V] логарифмов. Возвращает время в секундах
    (offset — начало слайса в треке), conf — средняя P метки 0..1.
    Пустой спан токена -> (nan, nan, 0.0), слово оставит whisper-тайминг.
    """
    import torch

    T = log_probs.shape[0]
    U = len(labels)
    n_words = len(ranges)
    empty = [(float("nan"), float("nan"), 0.0)] * n_words
    if T == 0 or U == 0:
        return empty
    lab = torch.tensor(labels, dtype=torch.long)
    emit = log_probs.gather(1, lab.unsqueeze(0).expand(T, U))
    blank_lp = log_probs[:, blank]

    neg = -1e9
    trellis = torch.full((T + 1, U + 1), neg)
    trellis[0, 0] = 0.0
    trellis[1:, 0] = torch.cumsum(blank_lp, dim=0)
    for t in range(1, T + 1):
        prev = trellis[t - 1]
        stay_blank = prev[1:] + blank_lp[t - 1]
        stay_same = prev[1:] + emit[t - 1]
        move = prev[:-1] + emit[t - 1]
        trellis[t, 1:] = torch.maximum(torch.maximum(stay_blank, stay_same), move)

    # бэктрек: -1 = blank-кадр, иначе индекс токена (0-based)
    path = [0] * T
    u = U
    for t in range(T, 0, -1):
        if u <= 0:
            path[t - 1] = -1
            continue
        stay_blank = trellis[t - 1, u] + blank_lp[t - 1]
        stay_same = trellis[t - 1, u] + emit[t - 1, u - 1]
        move = trellis[t - 1, u - 1] + emit[t - 1, u - 1]
        if move > stay_blank and move >= stay_same:
            u -= 1
            path[t - 1] = u
        elif stay_same >= stay_blank:
            path[t - 1] = u - 1
        else:
            path[t - 1] = -1

    probs = emit.exp()
    out: list[tuple[float, float, float]] = []
    for _w, s_tok, e_tok in ranges:
        frames = [t for t in range(T) if s_tok <= path[t] < e_tok]
        if not frames:
            out.append((float("nan"), float("nan"), 0.0))
            continue
        s = offset + frames[0] * frame_dur
        e = offset + (frames[-1] + 1) * frame_dur
        conf = float(probs[frames][:, s_tok:e_tok].max(dim=1).values.mean())
        out.append((r3(s), r3(e), round(conf, 3)))
    return out


def _load_mono_16k(path: Path):
    """Весь трек mono 16k float32. Только для GPU-бокса (нужны librosa/numpy)."""
    import numpy as np

    try:
        import librosa
        y, _ = librosa.load(str(path), sr=ALIGN_SR, mono=True)
        return np.asarray(y, dtype=np.float32)
    except ImportError:
        pass
    import soundfile as sf
    y, sr = sf.read(str(path), always_2d=True)
    y = np.asarray(y, dtype=np.float32).mean(axis=1)
    if sr != ALIGN_SR:
        import scipy.signal as sig
        n = int(round(len(y) * ALIGN_SR / sr))
        y = sig.resample_poly(y, ALIGN_SR, sr)[:n].astype(np.float32)
    return y


class WordAligner:
    """Второй проход таймингов: CTC-алайнер + onset-снап для низкоуверенных слов.

    Ленивый: модель грузится при первом align() (или никогда — тогда
    работает только снап). Чужие падать не должны: любая внутренняя
    ошибка -> возврат whisper-сегментов как есть.
    """

    def __init__(self, model: str = "jonatasgrosman/wav2vec2-large-xlsr-53-russian",
                 device: str = "cuda", use_ctc: bool = True,
                 snap_window: float = 0.25, snap_low_conf_only: bool = True,
                 min_conf: float = 0.3, pad: float = 0.5) -> None:
        self.model_name = model
        self.device = device
        self.use_ctc = use_ctc
        self.snap_window = snap_window
        self.snap_low_conf_only = snap_low_conf_only
        self.min_conf = min_conf
        self.pad = pad
        self._processor = None
        self._model = None
        self._ctc_dead = False

    def _ensure_ctc(self):
        if not self.use_ctc or self._ctc_dead or self._model is not None:
            return self._model is not None
        try:
            import torch
            from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
        except ImportError:
            log.warning("transformers нет — CTC пропущен, работает только onset-снап")
            self._ctc_dead = True
            return False
        try:
            device = self.device
            if device == "cuda" and not torch.cuda.is_available():
                device = "cpu"
            log.info("align-модель %s (%s)", self.model_name, device)
            self._processor = Wav2Vec2Processor.from_pretrained(self.model_name)
            self._model = Wav2Vec2ForCTC.from_pretrained(self.model_name).to(device).eval()
            self._device = device
            return True
        except Exception:
            log.exception("align-модель не загрузилась — только onset-снап")
            self._ctc_dead = True
            return False

    def _ctc_words(self, audio, seg: dict, seg_s: float, seg_e: float) -> list[dict] | None:
        """Пересчитать слова сегмента через CTC. None — откат на whisper."""
        import torch

        words = seg.get("words", []) or []
        if not words or not self._ensure_ctc():
            return None
        vocab = self._processor.tokenizer.get_vocab()
        labels, ranges = _encode_transcript(seg.get("text", ""), vocab)
        if not labels:
            return None
        s0 = max(0.0, seg_s - self.pad)
        s1 = seg_e + self.pad
        a = max(0, int(s0 * ALIGN_SR))
        b = min(len(audio), int(s1 * ALIGN_SR) + 1)
        if b - a < ALIGN_SR // 5:
            return None
        chunk = audio[a:b]
        inputs = self._processor(chunk, sampling_rate=ALIGN_SR,
                                 return_tensors="pt", padding=True)
        with torch.no_grad():
            logits = self._model(inputs.input_values.to(self._device)).logits[0].cpu()
        log_probs = torch.log_softmax(logits, dim=-1)
        times = _ctc_word_times(log_probs, labels, ranges, blank=0,
                                frame_dur=FRAME_DUR, offset=a / ALIGN_SR)
        out: list[dict] = []
        for w, (s, e, conf) in zip(words, times, strict=False):
            import math
            if math.isnan(s) or conf < 0.05:
                out.append(dict(w))  # токен не найден — честно оставляем whisper
            else:
                out.append({**w, "s": s, "e": max(e, s + 0.03), "p": conf})
        return out

    def align(self, vocals: Path, segments: list[dict], lang: str = "") -> list[dict]:
        """Сегменты Whisper -> сегменты с точными границами слов (тот же формат)."""
        del lang  # модель сейчас одна на все языки; параметр — задел под per-lang
        if not segments:
            return segments
        try:
            audio = _load_mono_16k(vocals)
        except Exception:
            log.exception("аудио для align не прочиталось — whisper-тайминги как есть")
            return segments
        try:
            onsets = compute_onsets(vocals)
        except Exception:
            onsets = []
        out: list[dict] = []
        for seg in segments:
            try:
                out.append(self._align_one(audio, seg, onsets))
            except Exception:
                log.exception("align сегмента упал — оставляю whisper")
                out.append(seg)
        return out

    def _align_one(self, audio, seg: dict, onsets: list[float]) -> dict:
        words = seg.get("words", []) or []
        if not words:
            return seg
        seg_s, seg_e = r3(seg.get("start", 0.0)), r3(seg.get("end", 0.0))
        ctc = self._ctc_words(audio, seg, seg_s, seg_e)
        if ctc is None:
            fixed, stats = snap_words_to_onsets(words, onsets, seg_s, seg_e,
                                                window=self.snap_window)
            log.debug("snap-only: %s", stats)
        elif self.snap_low_conf_only and onsets:
            fixed = []
            for w in ctc:
                if float(w.get("p", 1.0)) >= self.min_conf:
                    fixed.append(w)
                    continue
                pulled, _ = snap_words_to_onsets([w], onsets, seg_s, seg_e,
                                                 window=self.snap_window)
                fixed.append(pulled[0])
            # монотонность после точечных подтяжек
            from .transcribe import normalize_words
            fixed = normalize_words(fixed, seg_s, seg_e)
        else:
            from .transcribe import normalize_words
            fixed = normalize_words(ctc, seg_s, seg_e)
        d = dict(seg)
        d["words"] = fixed
        if fixed:
            d["start"] = fixed[0]["s"]
            d["end"] = fixed[-1]["e"]
        return d

    def close(self) -> None:
        """Выгрузить CTC-модель (VRAM под CREPE)."""
        self._processor = None
        self._model = None
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass
