/**
 * Нотный скоринг пения (как в настоящем караоке + наука MIREX/mir_eval).
 *
 * Конвейер:
 * 1. Эталон: квантованные ноты (extractNotes) — склейка одинаковых,
 *    короткие паузы внутри фразы не рвут ноту.
 * 2. Пользователь: кадры высоты с микрофона (t, midi), уже сглаженные
 *    и с компенсацией задержки (см. Player).
 * 3. Сопоставление: кадры в окне ноты [start-onsetTol, end+offsetTol];
 *    нота взята, если достаточная доля длительности спета в тон.
 * 4. Оценка: взвешенное по длительностям среднее (длинные ноты важнее),
 *    вес ноты — уверенность эталона (сомнительный трекинг влияет меньше).
 *    Ошибка — взвешенная уверенностью микрофона. 0..100. Молчание и лишние
 *    звуки вне нот не штрафуем (щедрое караоке).
 *
 * Пороги из практики MIREX note tracking (onset ±50мс — для транскрипции;
 * для живого пения onset щедрее) и по классам высоты ±четверть тона.
 */
import type { PitchTrack, ScoreResult, TimingResult, WordScore } from './types'
import { GOOD_ERR, PERFECT_ERR, pitchClassError, type ScoreFrame } from './pitch'

/** каденция сэмплирования высоты в Player (мс -> сек) */
export const SCORE_CADENCE = 0.12
/** насколько раньше ноты можно вступить */
export const ONSET_TOL = 0.3
/** насколько можно протянуть после ноты */
export const OFFSET_TOL = 0.15
/** вступление в допуске: точно / почти (сек) */
export const TIMING_TIGHT = 0.15
export const TIMING_LOOSE = 0.3
/** короткие паузы внутри ноты не рвут её */
export const NOTE_GAP = 0.12
/** покрытие для взятия / половины */
export const TAKE_COVERAGE = 0.6
export const HALF_COVERAGE = 0.3

export interface NoteEvent {
  start: number
  end: number
  midi: number
  /** уверенность эталона 0..1 (средняя periodicity; по умолчанию 1) */
  conf?: number
}

export interface NoteScore {
  note: NoteEvent
  /** средняя ошибка по покрытым кадрам, null — ноту не пели */
  err: number | null
  /** доля длительности, спетая в тон (0..1) */
  coverage: number
  /** баллы ноты: 1 / 0.5 / 0 */
  points: number
  perfect: boolean
}

/** ноты из квантованного трека: склейка равных + мосты через короткие паузы */
export function extractNotes(pitch: PitchTrack | null): NoteEvent[] {
  if (!pitch) return []
  const { t, midi, conf } = pitch
  const n = t.length
  const notes: NoteEvent[] = []
  let i = 0
  while (i < n) {
    const m = midi[i]
    if (m === null || m === undefined) {
      i++
      continue
    }
    // тянем одинаковые, перепрыгивая короткие паузы
    let j = i
    let end = i
    while (j < n) {
      if (midi[j] === m) {
        end = j
        j++
        continue
      }
      // пауза? смотрим, что дальше: та же нота близко — мост
      let k = j
      while (k < n && (midi[k] === null || midi[k] === undefined)) k++
      if (k < n && midi[k] === m && t[k] - t[end] <= NOTE_GAP) {
        end = k
        j = k + 1
        continue
      }
      break
    }
    // уверенность ноты — средняя periodicity озвученных кадров (нет данных — 1)
    let noteConf: number | undefined
    if (conf) {
      let sum = 0
      let cnt = 0
      for (let k = i; k <= end; k++) {
        const c = conf[k]
        if (midi[k] !== null && midi[k] !== undefined && c !== null && c !== undefined && Number.isFinite(c)) {
          sum += c
          cnt++
        }
      }
      if (cnt > 0) noteConf = sum / cnt
    }
    notes.push({ start: t[i], end: t[end], midi: m, conf: noteConf })
    i = j
  }
  return notes
}

/** разложить кадры по нотам и выставить баллы */
export function scoreNotes(notes: NoteEvent[], frames: ScoreFrame[]): NoteScore[] {
  return notes.map((note) => {
    const dur = Math.max(0.01, note.end - note.start)
    let good = 0
    let sum = 0
    let wsum = 0
    let cnt = 0
    for (const f of frames) {
      if (f.user === null || !Number.isFinite(f.user)) continue
      if (f.t < note.start - ONSET_TOL || f.t > note.end + OFFSET_TOL) continue
      const d = pitchClassError(f.user, f.ref)
      if (d <= GOOD_ERR) {
        good++
        const w = f.uw ?? 1
        sum += d * w
        wsum += w
        cnt++
      }
    }
    const coverage = Math.min(1, (good * SCORE_CADENCE) / dur)
    if (cnt === 0) {
      return { note, err: null, coverage: 0, points: 0, perfect: false }
    }
    const err = sum / Math.max(1e-9, wsum)
    const points = coverage >= TAKE_COVERAGE ? 1 : coverage >= HALF_COVERAGE ? 0.5 : 0
    return { note, err, coverage, points, perfect: points === 1 && err <= PERFECT_ERR }
  })
}

/** итог: взвешенное по длительностям среднее; вес ноты — уверенность
 * эталона: сомнительные места влияют на итог меньше */
export function buildSongScore(scores: NoteScore[]): ScoreResult {  let hits = 0
  let perfect = 0
  let misses = 0
  let totalDur = 0
  let gotDur = 0
  const errs: number[] = []
  for (const s of scores) {
    const dur = Math.max(0.01, s.note.end - s.note.start)
    const w = s.note.conf ?? 1
    totalDur += dur * w
    gotDur += dur * s.points * w
    if (s.err === null || s.err === undefined) {
      misses++
      continue
    }
    errs.push(s.err)
    if (s.perfect) perfect++
    if (s.points >= 0.5) hits++
    else misses++
  }
  errs.sort((a, b) => a - b)
  const median = errs.length ? errs[Math.floor(errs.length / 2)] : 99
  return {
    score: totalDur ? Math.round((gotDur / totalDur) * 100) : 0,
    hits,
    perfect,
    misses,
    total: scores.length,
    medianError: Math.round(median * 100) / 100,
  }
}

/**
 * Ритм отдельно от высоты: вступление вовремя или нет.
 * Онсет ноты — первый озвученный кадр пользователя в её окне.
 * Судят только спетые ноты (молчание — не опоздание, за него уже
 * наказывает скоринг высоты). Взвешено по длительностям, 0..100.
 */
export function scoreTiming(notes: NoteEvent[], frames: ScoreFrame[]): TimingResult {
  let got = 0
  let tot = 0
  let sung = 0
  const offs: number[] = []
  for (const note of notes) {
    const dur = Math.max(0.01, note.end - note.start)
    let first: number | null = null
    for (const f of frames) {
      if (f.user === null || !Number.isFinite(f.user)) continue
      if (f.t < note.start - ONSET_TOL || f.t > note.end + OFFSET_TOL) continue
      if (first === null || f.t < first) first = f.t
    }
    if (first === null) continue
    sung++
    const a = Math.abs(first - note.start)
    offs.push(a)
    tot += dur
    got += dur * (a <= TIMING_TIGHT ? 1 : a <= TIMING_LOOSE ? 0.5 : 0)
  }
  offs.sort((a, b) => a - b)
  const median = offs.length ? offs[Math.floor(offs.length / 2)] : 0
  return {
    score: tot ? Math.round((got / tot) * 100) : 0,
    medianMs: Math.round(median * 1000),
    sung,
    total: notes.length,
  }
}

/** допуск слова за границы (сек): дыхание и неточность тайминга */
export const WORD_PAD = 0.1
/**
 * Попадание в высоту по словам: эталон слова — медиана квантованного
 * трека внутри слова, хит — хоть один кадр в тон в окне слова.
 * Слово без эталона — вне зачёта (петь не по чему), молчание под
 * словом — мимо. Дополняет нотный скоринг, не заменяет.
 */
export function scoreWords(
  words: { s: number; e: number }[],
  pitch: PitchTrack | null,
  frames: ScoreFrame[],
): WordScore {
  let hit = 0
  let total = 0
  for (const w of words) {
    if (!Number.isFinite(w.s) || !Number.isFinite(w.e) || w.e <= w.s) continue
    // медиана эталона внутри слова
    const vs: number[] = []
    if (pitch) {
      for (let k = 0; k < pitch.t.length; k++) {
        if (pitch.t[k] < w.s || pitch.t[k] > w.e) continue
        const m = pitch.midi[k]
        if (m !== null && m !== undefined) vs.push(m)
      }
    }
    if (vs.length === 0) continue
    vs.sort((a, b) => a - b)
    const ref = vs[Math.floor(vs.length / 2)]
    total++
    for (const f of frames) {
      if (f.user === null || !Number.isFinite(f.user)) continue
      if (f.t < w.s - WORD_PAD || f.t > w.e + WORD_PAD) continue
      if (pitchClassError(f.user, ref) <= GOOD_ERR) {
        hit++
        break
      }
    }
  }
  return { hit, total }
}

/**
 * Вычесть пропуски «не поём» из нот и кадров: внутри пропусков не судим.
 * Ноты режем по границам пропусков (огрызки короче 90мс — не ноты),
 * кадры внутри — дропаем. Пустые пропуски — сквозной проход.
 */
export function applySkips(
  notes: NoteEvent[],
  frames: ScoreFrame[],
  skips: readonly { s: number; e: number }[] | undefined,
): { notes: NoteEvent[]; frames: ScoreFrame[] } {
  if (!skips || skips.length === 0) return { notes, frames }
  const cut = (t: number): boolean => {
    for (const r of skips) {
      if (t >= r.s && t <= r.e) return true
    }
    return false
  }
  const kept: NoteEvent[] = []
  for (const n of notes) {
    const bounds = [n.start, n.end]
    for (const r of skips) {
      if (r.s > n.start && r.s < n.end) bounds.push(r.s)
      if (r.e > n.start && r.e < n.end) bounds.push(r.e)
    }
    bounds.sort((a, b) => a - b)
    for (let k = 0; k + 1 < bounds.length; k++) {
      const a = bounds[k]
      const b = bounds[k + 1]
      if (b <= a) continue
      if (cut((a + b) / 2)) continue
      if (b - a < 0.09) continue
      kept.push({ ...n, start: a, end: b })
    }
  }
  return { notes: kept, frames: frames.filter((f) => !cut(f.t)) }
}
