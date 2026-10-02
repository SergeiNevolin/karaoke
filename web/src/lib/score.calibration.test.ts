/**
 * Калибровка скоринга на реальных вокалах: изолированный вокал песни
 * (pitch.json по vocals.wav) — это идеальное исполнение. Прогоняем его
 * через боевой конвейер (sampleFrame -> scoreNotes -> buildSongScore).
 *
 * Песни: мелодичная, дуэт-рэп, длинный поп, разговорная (15% voiced).
 * Замерено: чистые 100/100/100/100, фальшь +2т — 27/10/22/8.
 */
import { describe, expect, it } from 'vitest'
import { makeRefLookup, micLag, quantizePitchTrack, sampleFrame, type ScoreFrame } from './pitch'
import { buildSongScore, extractNotes, scoreNotes } from './score'
import f1 from './__fixtures__/icegergert-evrodensru.json'
import f2 from './__fixtures__/morgenshtern-el-problema-feat-timati-demo.json'
import f3 from './__fixtures__/serega-pirat-vaybmen.json'
import f4 from './__fixtures__/igor-vikhorkov-ty-shljukha-ne-moja.json'

const LAG = micLag(48000)

interface Det {
  t: number
  f: number | null
}

interface Fix {
  songId: string
  detections: Det[]
  ref: { t: number[]; midi: (number | null)[] }
}

function run(fix: Fix, tf: (f: number | null, t: number) => number | null) {
  const ref = quantizePitchTrack({ t: fix.ref.t, midi: fix.ref.midi })
  const lookup = makeRefLookup(ref)
  const buf: number[] = []
  const frames: ScoreFrame[] = []
  for (const d of fix.detections) {
    const fr = sampleFrame(buf, d.t, tf(d.f, d.t), lookup, LAG)
    if (fr) frames.push(fr)
  }
  const notes = extractNotes(ref)
  const scores = scoreNotes(notes, frames)
  return { result: buildSongScore(scores), notes: notes.length, frames: frames.length }
}

const id = (f: number | null): number | null => f
const sharp2 = (f: number | null): number | null => (f === null ? null : f * 2 ** (2 / 12))
const silent = (): number | null => null
const wobble = (f: number | null, t: number): number | null =>
  f === null ? null : f * 2 ** ((25 * Math.sin(2 * Math.PI * 5.5 * t)) / 1200)

const cases: { name: string; fix: Fix }[] = [
  { name: 'мелодичная', fix: f1 as Fix },
  { name: 'дуэт-рэп', fix: f2 as Fix },
  { name: 'длинный поп', fix: f3 as Fix },
  { name: 'разговорная', fix: f4 as Fix },
]

describe('калибровка: идеальный вокал', () => {
  for (const c of cases) {
    it(`${c.name}: чисто высоко, фальшь низко, тишина ноль`, () => {
      const clean = run(c.fix, id)
      expect(clean.notes).toBeGreaterThan(10)
      expect(clean.frames).toBeGreaterThan(50)
      expect(clean.result.score).toBeGreaterThanOrEqual(80)
      expect(run(c.fix, sharp2).result.score).toBeLessThan(35)
      expect(run(c.fix, silent).result.score).toBe(0)
    })
  }

  it('вибрато ±25 центов не роняет (все песни)', () => {
    for (const c of cases) {
      expect(run(c.fix, wobble).result.score).toBeGreaterThanOrEqual(65)
    }
  })
})
