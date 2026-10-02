import { describe, expect, it } from 'vitest'
import { applySkips, buildSongScore, extractNotes, scoreNotes, scoreTiming, scoreWords } from './score'

describe('extractNotes', () => {
  it('склеивает равные ступени', () => {
    const notes = extractNotes({
      t: [0, 0.05, 0.1, 0.15, 0.2],
      midi: [60, 60, 62, 62, 62],
    })
    expect(notes).toEqual([
      { start: 0, end: 0.05, midi: 60 },
      { start: 0.1, end: 0.2, midi: 62 },
    ])
  })

  it('короткая пауза внутри фразы не рвёт ноту', () => {
    const notes = extractNotes({
      t: [0, 0.05, 0.1, 0.15, 0.2],
      midi: [60, 60, null, 60, 60],
    })
    expect(notes).toEqual([{ start: 0, end: 0.2, midi: 60 }])
  })

  it('длинная пауза рвёт, пусто — пусто', () => {
    const notes = extractNotes({
      t: [0, 0.05, 0.5, 0.55],
      midi: [60, 60, null, 62],
    })
    expect(notes).toEqual([
      { start: 0, end: 0.05, midi: 60 },
      { start: 0.55, end: 0.55, midi: 62 },
    ])
    expect(extractNotes(null)).toEqual([])
    expect(extractNotes({ t: [], midi: [] })).toEqual([])
  })

  it('уверенность ноты — средняя conf озвученных кадров', () => {
    const notes = extractNotes({
      t: [0, 0.05, 0.1],
      midi: [60, 60, 60],
      conf: [0.4, 0.8, null],
    })
    expect(notes[0].conf).toBeCloseTo(0.6, 5)
    const plain = extractNotes({ t: [0], midi: [60] })
    expect(plain[0].conf).toBe(undefined)
  })
})

describe('scoreNotes', () => {
  const notes = [
    { start: 10, end: 12, midi: 60 },
    { start: 14, end: 16, midi: 64 },
  ]
  const ref = (t: number, m: number) => ({ t, user: m, ref: 60 })

  it('полное покрытие в тон — perfect', () => {
    const frames = Array.from({ length: 17 }, (_, i) => ref(10 + i * 0.12, 60))
    const [s] = scoreNotes([notes[0]], frames)
    expect(s.coverage).toBe(1)
    expect(s.points).toBe(1)
    expect(s.perfect).toBe(true)
    expect(s.err).toBe(0)
  })

  it('мало покрытия — 0 баллов, без штрафа', () => {
    const frames = [10.1, 10.5].map((t) => ref(t, 60))
    const [s] = scoreNotes([notes[0]], frames)
    // 2 кадра по 0.12с на 2с ноты = 0.12 покрытия — мало
    expect(s.coverage).toBeCloseTo(0.12, 2)
    expect(s.points).toBe(0)
    expect(s.perfect).toBe(false)
  })

  it('молчание под нотой — нулевая без ошибки', () => {
    const frames = [
      { t: 10.1, user: null, ref: 60 },
      { t: 13, user: 60, ref: 60 }, // зазор между нотами — ни к чему
    ]
    const [s] = scoreNotes([notes[0]], frames)
    expect(s.err).toBe(null)
    expect(s.coverage).toBe(0)
    expect(s.points).toBe(0)
  })

  it('ранний вступ в допуске считается', () => {
    const frames = [{ t: 13.8, user: 64, ref: 64 }]
    const [s] = scoreNotes([notes[1]], frames)
    expect(s.coverage).toBeGreaterThan(0)
  })

  it('ошибка взвешена уверенностью микрофона', () => {
    const frames = [
      { t: 10.1, user: 60, ref: 60, uw: 0.5 },
      { t: 10.3, user: 61, ref: 60, uw: 1 },
    ]
    const [s] = scoreNotes([{ start: 10, end: 12, midi: 60 }], frames)
    // (0*0.5 + 1*1) / (0.5+1) = 0.667
    expect(s.err).toBeCloseTo(0.667, 2)
  })
})

describe('buildSongScore', () => {
  it('пусто — нули', () => {
    expect(buildSongScore([])).toEqual({
      score: 0,
      hits: 0,
      perfect: 0,
      misses: 0,
      total: 0,
      medianError: 99,
    })
  })

  it('длинные ноты весят больше', () => {
    const r = buildSongScore([
      { note: { start: 0, end: 10, midi: 60 }, err: 0, coverage: 1, points: 1, perfect: true },
      { note: { start: 10, end: 11, midi: 64 }, err: 5, coverage: 1, points: 0, perfect: false },
    ])
    // (10*1 + 1*0) / 11 = 90.9 -> 91
    expect(r.score).toBe(91)
    expect(r.hits).toBe(1)
    expect(r.misses).toBe(1)
    expect(r.total).toBe(2)
  })

  it('неспетые — мимо, медиана по спетым', () => {
    const r = buildSongScore([
      { note: { start: 0, end: 2, midi: 60 }, err: null, coverage: 0, points: 0, perfect: false },
      { note: { start: 2, end: 4, midi: 64 }, err: 0.4, coverage: 1, points: 1, perfect: true },
    ])
    expect(r.misses).toBe(1)
    expect(r.medianError).toBe(0.4)
    expect(r.score).toBe(50)
  })

  it('неуверенный эталон весит меньше', () => {
    const mk = (conf?: number) => [
      { note: { start: 0, end: 10, midi: 60, conf }, err: 0, coverage: 1, points: 1, perfect: true },
      { note: { start: 10, end: 11, midi: 64 }, err: 5, coverage: 1, points: 0, perfect: false },
    ]
    // без conf: (10*1+1*0)/11 = 91
    expect(buildSongScore(mk(undefined)).score).toBe(91)
    // первая нота с conf 0.2: (10*0.2*1+1*0)/(10*0.2+1) = 2/3 -> 67
    expect(buildSongScore(mk(0.2)).score).toBe(67)
  })
})

describe('scoreTiming', () => {
  const notes = [
    { start: 10, end: 12, midi: 60 },
    { start: 14, end: 16, midi: 64 },
  ]
  const at = (t: number) => ({ t, user: 60, ref: 60 })

  it('вовремя — 100 и медиана 0', () => {
    const r = scoreTiming(notes, [at(10), at(10.5), at(14), at(15)])
    expect(r.score).toBe(100)
    expect(r.medianMs).toBe(0)
    expect(r.sung).toBe(2)
  })

  it('опоздание 0.2 — половина', () => {
    const r = scoreTiming(notes, [at(10.2), at(14.2)])
    expect(r.score).toBe(50)
    expect(r.medianMs).toBe(200)
  })

  it('опоздание на секунду — мимо', () => {
    const r = scoreTiming([notes[0]], [at(11.5)])
    expect(r.score).toBe(0)
  })

  it('раннее вступление считается по модулю', () => {
    const r = scoreTiming([notes[0]], [at(9.9)])
    expect(r.score).toBe(100)
  })

  it('молчание — не опоздание: вне зачёта', () => {
    const r = scoreTiming(notes, [{ t: 10.1, user: null, ref: 60 }])
    expect(r.sung).toBe(0)
    expect(r.score).toBe(0)
    expect(r.total).toBe(2)
  })
})

describe('scoreWords', () => {
  const pitch = { t: [10, 10.1, 10.2, 10.3, 11, 11.1], midi: [60, 60, 60, 60, 64, 64] }
  const words = [
    { s: 10, e: 10.3 }, // эталон 60
    { s: 11, e: 11.1 }, // эталон 64
    { s: 12, e: 12.5 }, // без эталона — вне зачёта
  ]

  it('попал/мимо/вне зачёта', () => {
    const r = scoreWords(words, pitch, [
      { t: 10.1, user: 60, ref: 60 },
      { t: 11.05, user: 60, ref: 64 }, // мимо (60 против 64)
    ])
    expect(r).toEqual({ hit: 1, total: 2 })
  })

  it('молчание под словом — мимо, пусто — нули', () => {
    const r = scoreWords([words[0]], pitch, [{ t: 10.1, user: null, ref: 60 }])
    expect(r).toEqual({ hit: 0, total: 1 })
    expect(scoreWords([], pitch, [])).toEqual({ hit: 0, total: 0 })
    expect(scoreWords(words, null, [])).toEqual({ hit: 0, total: 0 })
  })
})

describe('applySkips', () => {
  const notes = [
    { start: 10, end: 12, midi: 60 },
    { start: 14, end: 16, midi: 64 },
  ]
  const frames = [
    { t: 10.5, user: 60, ref: 60 },
    { t: 15, user: 64, ref: 64 },
  ]

  it('пусто — сквозной проход теми же ссылками', () => {
    expect(applySkips(notes, frames, undefined)).toEqual({ notes, frames })
    expect(applySkips(notes, frames, [])).toEqual({ notes, frames })
  })

  it('нота целиком в пропуске — вылетает, кадры чистятся', () => {
    const r = applySkips(notes, frames, [{ s: 13.5, e: 16.5 }])
    expect(r.notes).toEqual([{ start: 10, end: 12, midi: 60 }])
    expect(r.frames).toEqual([{ t: 10.5, user: 60, ref: 60 }])
  })

  it('пропуск режет ноту, огрызки короче 90мс — не ноты', () => {
    const r = applySkips([{ start: 10, end: 12, midi: 60 }], [], [{ s: 11, e: 11.95 }])
    // куски [10,11] и [11.95,12]: второй — огрызок 0.05с
    expect(r.notes).toEqual([{ start: 10, end: 11, midi: 60 }])
  })

  it('conf ноты переживает резку', () => {
    const r = applySkips([{ start: 10, end: 12, midi: 60, conf: 0.4 }], [], [{ s: 0, e: 1 }])
    expect(r.notes[0].conf).toBe(0.4)
  })
})
