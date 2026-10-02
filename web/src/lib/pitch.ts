import { PitchDetector } from 'pitchy'
import type { PitchTrack } from './types'

export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440)

/** имя ноты: 69 -> 'A4' */
export function midiName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const m = Math.round(midi)
  return `${names[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`
}

/** отклонение спетого от эталона в центах (-50..+50, без учёта октавы) */
export function centsOff(liveMidi: number, targetMidi: number): number {
  const d = liveMidi - targetMidi
  return Math.round(100 * (d - 12 * Math.round(d / 12)))
}

/** окно обзора вокруг курсора: [time-pre, time+post] в границах трека */
export function windowForTime(
  time: number,
  duration: number,
  pre = 5,
  post = 15,
): { t0: number; t1: number } {
  const dur = Number.isFinite(duration) && duration > 0 ? duration : 1
  const t1 = Math.min(dur, Math.max(pre + post, time + post))
  return { t0: Math.max(0, t1 - pre - post), t1 }
}

/** вертикальный диапазон нот в окне (с полями), null если петь нечего */
export function visibleRange(
  pitch: PitchTrack | null,
  t0: number,
  t1: number,
): { lo: number; hi: number } | null {
  if (!pitch) return null
  const vs: number[] = []
  for (let i = 0; i < pitch.t.length; i++) {
    const m = pitch.midi[i]
    if (m === null || m === undefined) continue
    if (pitch.t[i] < t0 || pitch.t[i] > t1) continue
    vs.push(m)
  }
  if (vs.length === 0) return null
  // окно ±15 полутонов от медианы: шкала стабильна и читаема,
  // выбросы по краям не растягивают её на 4 октавы
  vs.sort((a, b) => a - b)
  const med = vs[Math.floor(vs.length / 2)]
  return { lo: med - 15, hi: med + 15 }
}

/** разница в полутонах с точностью до октавы (0..6) */
export function pitchClassError(a: number, b: number): number {
  return Math.abs((((a - b + 6) % 12) + 12) % 12 - 6)
}

export interface RefLookup {
  /** MIDI эталона в момент t (линейный поиск бинарным), null если пауза */
  at(t: number): number | null
  /** уверенность эталона 0..1 (1 — нет данных, считаем уверенным) */
  conf(t: number): number
}

export function makeRefLookup(pitch: PitchTrack | null): RefLookup {
  if (!pitch) return { at: () => null, conf: () => 1 }
  const { t, midi, conf } = pitch
  const nearest = (time: number): number => {
    let lo = 0
    let hi = t.length - 1
    if (time <= t[0]) return 0
    if (time >= t[hi]) return hi
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (t[mid] <= time) lo = mid
      else hi = mid
    }
    // ближайший из двух
    return time - t[lo] <= t[hi] - time ? lo : hi
  }
  return {
    at(time: number): number | null {
      return midi[nearest(time)]
    },
    conf(time: number): number {
      if (!conf) return 1
      const v = conf[nearest(time)]
      return v === null || v === undefined || !Number.isFinite(v) ? 1 : v
    },
  }
}

/** живой детектор тона микрофона на pitchy (McLeod Pitch Method) */
export class LivePitch {
  private detector = PitchDetector.forFloat32Array(2048)
  private buf: Float32Array

  constructor(size = 2048) {
    this.buf = new Float32Array(size)
  }

  /** freq в Гц или null; clarity 0..1 */
  detect(input: Float32Array, sampleRate: number): { freq: number; clarity: number } | null {
    const n = Math.min(input.length, this.buf.length)
    this.buf.fill(0)
    this.buf.set(input.subarray(0, n))
    const [freq, clarity] = this.detector.findPitch(this.buf, sampleRate)
    if (!Number.isFinite(freq) || clarity < 0.7 || freq < 50 || freq > 1200) return null
    return { freq, clarity }
  }
}

/** окно сглаживания высоты: медиана последних n (давит джиттер и вибрато) */
export function smoothMedian(buf: number[], v: number, n = 3): number {
  buf.push(v)
  while (buf.length > n) buf.shift()
  const s = [...buf].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/**
 * Задержка микрофонного тракта: окно анализатора (центр) + вход.
 * Эталон при сэмплировании берём раньше на неё, иначе нота сравнивается
 * не с тем местом.
 */
export function micLag(sampleRate: number): number {
  return 1024 / sampleRate + 0.015
}

/**
 * Один шаг живого скоринга (чистая механика цикла Player — та же, что в бою):
 * сглаживание, эталон с компенсацией задержки, кадр или null
 * (пауза/молчание — кадра нет, молчание не штрафуем).
 */
export function sampleFrame(
  buf: number[],
  t: number,
  freq: number | null,
  lookup: RefLookup,
  lagSec: number,
  clarity = 1,
): ScoreFrame | null {
  if (freq === null || !Number.isFinite(freq)) {
    buf.length = 0
    return null
  }
  // clarity только записываем (в err взвешенно): дропает тихонь
  // LivePitch (clarity < 0.7), второй гейт здесь не нужен
  const midi = smoothMedian(buf, hzToMidi(freq))
  const ref = lookup.at(t - lagSec)
  if (ref === null || ref === undefined) {
    buf.length = 0
    return null
  }
  return { t, user: midi, ref, uw: clarity, rw: lookup.conf(t - lagSec) }
}

/** границы индексов pitch-сэмплов внутри [t0, t1] (бинпоиск, t сортирован) */
export function sliceWindow(t: readonly number[], t0: number, t1: number): [number, number] {
  let lo = 0
  let hi = t.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (t[mid] < t0) lo = mid + 1
    else hi = mid
  }
  const start = lo
  lo = start
  hi = t.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (t[mid] <= t1) lo = mid + 1
    else hi = mid
  }
  return [start, lo]
}

/**
 * Гейт эталона по сегментам: питч живёт только там, где поётся.
 * pyin озвучивает и инструментальный bleed (соло, интро, аутро) —
 * эти фантомные ноты режем. Маржи 0.5с покрывают атаки/неточность
 * границ слов. Без сегментов — возвращаем как есть.
 */
export function gatePitchToSegments(
  pitch: PitchTrack | null,
  segments: { start: number; end: number }[],
  pre = 0.5,
  post = 0.5,
): PitchTrack | null {
  if (!pitch || segments.length === 0) return pitch
  const { t, midi } = pitch
  const gated = midi.map((m, k) => {
    if (m === null || m === undefined) return m
    const tt = t[k]
    for (const s of segments) {
      if (tt >= s.start - pre && tt <= s.end + post) return m
    }
    return null
  })
  return { t: [...t], midi: gated }
}

/**
 * Строгое квантование эталона ДЛЯ СКОРИНГА: только уверенные места.
 * Медиана + округление + сворачивание октавного джиттера
 * + удаление крошки короче 90мс в паузу + склейка коротких срывов.
 * Мусор трекера в ноты не пускаем: по мусору фальшь случайно попадает.
 */
export function quantizePitchTrack(pitch: PitchTrack | null): PitchTrack | null {
  const base = baseQuantize(pitch)
  if (!base) return null
  const { t } = base
  const out: (number | null)[] = [...base.midi]
  const n = t.length
  // крошка короче 90мс — в паузу
  let i = 0
  while (i < n) {
    if (out[i] === null || out[i] === undefined) {
      i++
      continue
    }
    let j = i
    while (j < n && out[j] === out[i]) j++
    if (t[j - 1] - t[i] < 0.09) {
      for (let k = i; k < j; k++) out[k] = null
    }
    i = j
  }
  fixOctaveRuns(t, out)
  return { t: [...t], midi: out }
}

/**
 * Гладкий трек ДЛЯ ПОКАЗА: непрерывный контур мелодии без дыр.
 * Медиана + округление + сворачивание октавного джиттера + заливка
 * крошки соседней нотой + чистка jitter-островов. Длинные паузы не трогаем.
 */
export function displayPitchTrack(pitch: PitchTrack | null): PitchTrack | null {
  if (!pitch) return null
  const { t, midi } = pitch
  const n = t.length
  // сшивка микропауз трекера (<120мс) — дропаут, а не дыхание
  const held: (number | null)[] = [...midi]
  let g = 0
  while (g < n) {
    if (held[g] !== null && held[g] !== undefined) {
      g++
      continue
    }
    let h = g
    while (h < n && (held[h] === null || held[h] === undefined)) h++
    const left = g > 0 ? held[g - 1] : null
    const right = h < n ? held[h] : null
    if (
      left !== null &&
      left !== undefined &&
      right !== null &&
      right !== undefined &&
      t[h - 1] - t[g] < 0.12
    ) {
      for (let k = g; k < h; k++) held[k] = left
    }
    g = h
  }
  const base = baseQuantize({ t, midi: held })
  if (!base) return null
  const out: (number | null)[] = [...base.midi]
  // крошка короче 90мс — трекерный мусор, а не нота.
  // Внутри озвучки затираем соседней нотой (за кого больше улик —
  // длинный сосед побеждает, ничья — за левым), по краям куска —
  // в паузу (дребезг атаки/затухания). Читаем со снимка, пишем в out,
  // иначе зануление каскадом съедает весь кусок правее.
  const snap: (number | null)[] = [...out]
  const snapVoiced = (v: number | null | undefined): v is number => v !== null && v !== undefined
  let i = 0
  while (i < n) {
    if (!snapVoiced(snap[i])) {
      i++
      continue
    }
    let j = i
    while (j < n && snap[j] === snap[i]) j++
    if (t[j - 1] - t[i] < 0.09) {
      const left = i > 0 ? snap[i - 1] : null
      const right = j < n ? snap[j] : null
      if (snapVoiced(left) && snapVoiced(right)) {
        // длины соседних ранов — кто убедительнее
        let a = i - 1
        while (a >= 0 && snap[a] === left) a--
        let b = j + 1
        while (b < n && snap[b] === right) b++
        const pick = i - 1 - a >= b - j ? left : right
        for (let k = i; k < j; k++) out[k] = pick
      } else {
        for (let k = i; k < j; k++) out[k] = null
      }
    }
    i = j
  }
  fixJitterIslands(t, out)
  foldToRegister(t, out)
  return { t: [...t], midi: out }
}

/**
 * Схлопывание октавных расколов к регистру куска: якорь — мода (самый
 * частый уровень: при бимодальном расколе середина-медиана висит между
 * голосом и хопом, а мода выбирает большинство; ничья — за верхний:
 * субгармонический лок трекера вниз — частая ошибка, вверх — редкая).
 * Всё что дальше ±6 полутонов от якоря — трекерный хоп, подтягиваем
 * по октавам. Настоящие скачки между кусками (куплет/припев через дыхание)
 * не трогаем: у каждого куска свой якорь. Внутри куска честная октава ±6
 * от якоря живёт (полный диапазон 12), схлопывается только раскол.
 */
export function foldToRegister(t: number[], out: (number | null)[]): void {
  const n = t.length
  let i = 0
  while (i < n) {
    if (out[i] === null || out[i] === undefined) {
      i++
      continue
    }
    let j = i
    while (j < n && out[j] !== null && out[j] !== undefined) j++
    const freq = new Map<number, number>()
    for (let k = i; k < j; k++) {
      const v = out[k] as number
      freq.set(v, (freq.get(v) ?? 0) + 1)
    }
    let anchor = out[i] as number
    let bestC = -1
    freq.forEach((c, v) => {
      if (c > bestC || (c === bestC && v > anchor)) {
        bestC = c
        anchor = v
      }
    })
    for (let k = i; k < j; k++) {
      let v = out[k] as number
      while (v < anchor - 6) v += 12
      while (v > anchor + 6) v -= 12
      out[k] = v
    }
    i = j
  }
}

/** гармонические интервалы хопов трекера: октава, квинта, кварта, терции */
const HOP_INTERVALS = new Set([3, 4, 5, 7, 12])

/**
 * Чистка jitter-островов вида A-B-A (возврат туда же — признак хопа,
 * а не мелодии: настоящие ходы идут дальше или держатся).
 * - Короткие (<0.2с): всегда в строй — как раньше.
 * - До 1с: только в джиттер-зоне (в ±0.5с вокруг ≥5 разных уровней —
 *   трекер мечется). В стабильном месте орнаменты (морденты, трели)
 *   не трогаем.
 */
export function fixJitterIslands(t: number[], out: (number | null)[]): void {
  const n = t.length
  const runs: { s: number; e: number; v: number }[] = []
  let i = 0
  while (i < n) {
    if (out[i] === null || out[i] === undefined) {
      i++
      continue
    }
    let j = i
    while (j < n && out[j] === out[i]) j++
    runs.push({ s: i, e: j, v: out[i] as number })
    i = j
  }
  for (let r = 1; r + 1 < runs.length; r++) {
    const prev = runs[r - 1].v
    const cur = runs[r].v
    const next = runs[r + 1].v
    if (prev !== next || cur === prev) continue
    const d = Math.abs(cur - prev)
    if (!HOP_INTERVALS.has(Math.round(d))) continue
    const dur = t[runs[r].e - 1] - t[runs[r].s]
    if (dur >= 1.0) continue
    if (dur >= 0.2 && !jitterZone(t, out, t[runs[r].s] - 0.5, t[runs[r].e - 1] + 0.5)) continue
    for (let k = runs[r].s; k < runs[r].e; k++) out[k] = prev
    runs[r].v = prev
  }
}

/** джиттер-зона: в окне много разных уровней — трекер мечется, не мелодия */
function jitterZone(
  t: number[],
  out: (number | null)[],
  t0: number,
  t1: number,
): boolean {
  const levels = new Set<number>()
  for (let k = 0; k < t.length && levels.size < 5; k++) {
    if (t[k] < t0 || t[k] > t1) continue
    const v = out[k]
    if (v !== null && v !== undefined) levels.add(v)
  }
  return levels.size >= 5
}

/** начало строгого трека: медиана внутри озвученных кусков + округление + сворачивание октавного джиттера */
function baseQuantize(pitch: PitchTrack | null): PitchTrack | null {
  if (!pitch) return null
  const { t, midi } = pitch
  const n = t.length
  const out: (number | null)[] = new Array(n).fill(null)
  // медиана внутри озвученных кусков + округление
  let i = 0
  while (i < n) {
    if (midi[i] === null || midi[i] === undefined) {
      i++
      continue
    }
    let j = i
    while (j < n && midi[j] !== null && midi[j] !== undefined) j++
    for (let k = i; k < j; k++) {
      const win: number[] = []
      for (let q = Math.max(i, k - 2); q <= Math.min(j - 1, k + 2); q++) {
        const v = midi[q]
        if (v !== null && v !== undefined) win.push(v)
      }
      win.sort((a, b) => a - b)
      out[k] = Math.round(win[Math.floor(win.length / 2)])
    }
    i = j
  }
  // октавный джиттер — в доминирующую октаву окна ±4.
  // Ничья — за левым соседом (продолжаем текущую ноту, а не дёргаем).
  // Настоящие ходы не трогаем: сворачиваем только ровно на октаву.
  for (let k = 0; k < n; k++) {
    const v = out[k]
    if (v === null || v === undefined) continue
    const freq = new Map<number, number>()
    for (let q = Math.max(0, k - 4); q <= Math.min(n - 1, k + 4); q++) {
      const w = out[q]
      if (w === null || w === undefined) continue
      freq.set(w, (freq.get(w) ?? 0) + 1)
    }
    let best = v
    let bestC = -1
    freq.forEach((c) => {
      if (c > bestC) bestC = c
    })
    const tied = [...freq.keys()].filter((val) => freq.get(val) === bestC)
    if (tied.length === 1) {
      best = tied[0]
    } else {
      const left = k > 0 ? out[k - 1] : null
      best = left !== null && left !== undefined && tied.includes(left) ? left : v
    }
    if (best !== v && Math.abs(v - best) % 12 === 0) {
      out[k] = best
    }
  }
  return { t: [...t], midi: out }
}

/** короткий октавный срыв между одинаковыми соседями — вернуть в строй.
 * Длинные пассажи (>0.2с) не трогаем: это музыка, а не трекерный мусор. */
function fixOctaveRuns(t: number[], out: (number | null)[]): void {
  const n = t.length
  const runs: { s: number; e: number; med: number }[] = []
  let i = 0
  while (i < n) {
    if (out[i] === null || out[i] === undefined) {
      i++
      continue
    }
    let j = i
    while (j < n && out[j] === out[i]) j++
    runs.push({ s: i, e: j, med: out[i] as number })
    i = j
  }
  for (let r = 1; r + 1 < runs.length; r++) {
    if (t[runs[r].e - 1] - t[runs[r].s] >= 0.2) continue
    const prev = runs[r - 1].med
    const cur = runs[r].med
    const next = runs[r + 1].med
    for (const d of [12, -12]) {
      if (Math.abs(cur + d - prev) < 0.6 && Math.abs(cur + d - next) < 0.6) {
        for (let k = runs[r].s; k < runs[r].e; k++) out[k] = (out[k] as number) + d
        runs[r].med = cur + d
        break
      }
    }
  }
}

/** хит идеально/хорошо: щедрые окна, как в караоке для людей, а не для роботов */
export const PERFECT_ERR = 0.75
export const GOOD_ERR = 1.5

export interface ScoreFrame {
  t: number
  /** null — молчал (в скоринг не идёт: молчание не штрафуем) */
  user: number | null
  ref: number
  /** уверенность микрофона 0..1 (clarity), по умолчанию 1 */
  uw?: number
  /** уверенность эталона 0..1 (periodicity), по умолчанию 1 */
  rw?: number
}

export function gradeText(score: number): string {
  if (score >= 80) return 'Звезда караоке'
  if (score >= 60) return 'Отличное исполнение'
  if (score >= 40) return 'Хорошо, почти хит'
  if (score >= 20) return 'Неплохо для разогрева'
  return 'Главное — удовольствие'
}
