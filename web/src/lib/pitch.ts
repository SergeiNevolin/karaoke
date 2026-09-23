import { PitchDetector } from 'pitchy'
import type { PitchTrack, ScoreResult } from './types'

export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440)

/** разница в полутонах с точностью до октавы (0..6) */
export function pitchClassError(a: number, b: number): number {
  return Math.abs((((a - b + 6) % 12) + 12) % 12 - 6)
}

export interface RefLookup {
  /** MIDI эталона в момент t (линейный поиск бинарным), null если пауза */
  at(t: number): number | null
}

export function makeRefLookup(pitch: PitchTrack | null): RefLookup {
  if (!pitch) return { at: () => null }
  const { t, midi } = pitch
  return {
    at(time: number): number | null {
      let lo = 0
      let hi = t.length - 1
      if (time <= t[0]) return midi[0]
      if (time >= t[hi]) return midi[hi]
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1
        if (t[mid] <= time) lo = mid
        else hi = mid
      }
      // ближайший из двух
      const idx = time - t[lo] <= t[hi] - time ? lo : hi
      return midi[idx]
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
    if (!Number.isFinite(freq) || clarity < 0.75 || freq < 50 || freq > 880) return null
    return { freq, clarity }
  }
}

/** финальный подсчёт оценки из накопленных кадров */
export function buildScore(frames: { user: number; ref: number }[]): ScoreResult {
  let hits = 0
  const errs: number[] = []
  for (const f of frames) {
    const d = pitchClassError(f.user, f.ref)
    errs.push(d)
    if (d <= 1) hits++
  }
  errs.sort((a, b) => a - b)
  const median = errs.length ? errs[Math.floor(errs.length / 2)] : 99
  return {
    score: frames.length ? Math.round((hits / frames.length) * 100) : 0,
    hits,
    total: frames.length,
    medianError: Math.round(median * 100) / 100,
  }
}

export function gradeText(score: number): string {
  if (score >= 85) return 'Звезда караоке'
  if (score >= 65) return 'Отличное исполнение'
  if (score >= 45) return 'Хорошо, почти хит'
  if (score >= 25) return 'Неплохо для разогрева'
  return 'Главное — удовольствие'
}
