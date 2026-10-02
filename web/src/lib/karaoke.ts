/**
 * Мозг экрана караоке — чистые функции без React/DOM.
 *
 * Кадр строится напрямую от часов звука:
 * - окно: какая строка крупная (locateWindow: держим поющуюся, иначе упреждение);
 * - спетость: сколько слов первой строки окна уже прозвучало;
 * - шарик: виден только в диапазоне строки, до старта паркуется на первом слове.
 */
import type { Segment } from './types'
import { locateWindow } from './songs'

export interface KaraokeLine {
  s: Segment
  i: number
  cur: boolean
}

export interface KaraokeFrame {
  winStart: number
  lines: KaraokeLine[]
  /** сколько слов первой строки окна спето (0 — ещё не начали) */
  sung: number
  /** шарик уместен по времени (центры слов проверяет вызыватель) */
  ballOn: boolean
}

/** слово считается спетым ровно по его началу — без упреждений, мс в мс */
export const SUNG_EPS = 0
/** шарик появляется незадолго до строки и гаснет чуть после */
export const BALL_LEAD = 0.6
export const BALL_TAIL = 0.3

export function karaokeFrame(segments: Segment[], t: number): KaraokeFrame {
  const winStart = Math.max(0, locateWindow(segments, t))
  const lines = segments
    .slice(winStart, winStart + 3)
    .map((s, k) => ({ s, i: winStart + k, cur: k === 0 }))
  const win = segments[winStart]
  const sung = win ? win.words.filter((w) => t >= w.s - SUNG_EPS).length : 0
  const ballOn = !!win && win.words.length > 0 && t >= win.start - BALL_LEAD && t <= win.end + BALL_TAIL
  return { winStart, lines, sung, ballOn }
}

/** кегль текущей строки: длинные ужимаем, чтобы влезли целиком, а не резались контейнером */
export function lineTextSize(nWords: number): string {
  if (nWords > 20) return 'text-xl font-semibold leading-snug sm:text-2xl'
  if (nWords > 12) return 'text-2xl font-semibold leading-snug sm:text-3xl'
  return 'text-4xl font-semibold leading-snug sm:text-5xl'
}

/** доля перелёта шарика 0..1: от текущего слова к следующему */
export function ballProgress(s: Segment, sung: number, t: number): number {
  const n = s.words.length
  if (n === 0) return 1
  const k = Math.max(0, Math.min(sung, n))
  const ci = Math.max(0, k - 1)
  const t0 = k === 0 ? s.start - BALL_LEAD : s.words[Math.min(ci, n - 1)].s
  const t1 = k < n ? s.words[k].s : s.words[n - 1].e
  if (!(t1 > t0)) return 1
  return Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))
}

/** координаты шарика по центрам слов: x — интерполяция, y — дуга */
export function ballXY(centers: number[], sung: number, p: number): { x: number; y: number } {
  const n = centers.length
  if (n === 0) return { x: 0, y: 0 }
  const k = Math.max(0, Math.min(sung, n))
  const ci = Math.max(0, k - 1)
  const ni = k < n ? k : n - 1
  const pc = Math.min(1, Math.max(0, p))
  const x = centers[ci] + (centers[ni] - centers[ci]) * pc
  return { x, y: -Math.abs(Math.sin(pc * Math.PI)) * 20 }
}
