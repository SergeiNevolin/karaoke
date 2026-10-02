import { describe, expect, it } from 'vitest'
import {
  centsOff,
  displayPitchTrack,
  fixJitterIslands,
  foldToRegister,
  gatePitchToSegments,
  gradeText,
  hzToMidi,
  LivePitch,
  makeRefLookup,
  micLag,
  midiName,
  pitchClassError,
  quantizePitchTrack,
  sampleFrame,
  sliceWindow,
  smoothMedian,
  visibleRange,
  windowForTime,
} from './pitch'
function sine(freq: number, sr = 48000, n = 2048): Float32Array {
  const b = new Float32Array(n)
  for (let i = 0; i < n; i++) b[i] = Math.sin((2 * Math.PI * freq * i) / sr)
  return b
}

describe('hzToMidi', () => {
  it('ля первой октавы — 69', () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 5)
    expect(hzToMidi(880)).toBeCloseTo(81, 5)
  })
})

describe('pitchClassError', () => {
  it('то же — 0, октава не важна', () => {
    expect(pitchClassError(69, 69)).toBe(0)
    expect(pitchClassError(69, 81)).toBe(0)
    expect(pitchClassError(81, 69)).toBe(0)
  })

  it('тритон — 6, сосед — 1', () => {
    expect(pitchClassError(60, 66)).toBe(6)
    expect(pitchClassError(60, 61)).toBe(1)
    expect(pitchClassError(60, 59)).toBe(1)
  })
})

describe('makeRefLookup', () => {
  const pitch = { t: [1, 2, 3], midi: [60, 62, 64] }

  it('точно и ближайший', () => {
    const r = makeRefLookup(pitch)
    expect(r.at(2)).toBe(62)
    expect(r.at(2.4)).toBe(62)
    expect(r.at(2.6)).toBe(64)
  })

  it('края clampятся', () => {
    const r = makeRefLookup(pitch)
    expect(r.at(0)).toBe(60)
    expect(r.at(100)).toBe(64)
  })

  it('паузы (null) и пустой трек', () => {
    expect(makeRefLookup({ t: [1], midi: [null] }).at(1)).toBe(null)
    expect(makeRefLookup(null).at(5)).toBe(null)
  })

  it('уверенность: из трека, без данных — 1', () => {
    const r = makeRefLookup({ t: [1, 2, 3], midi: [60, 62, 64], conf: [0.4, 0.9, null] })
    expect(r.conf(2)).toBe(0.9)
    expect(r.conf(2.6)).toBe(1) // null -> 1
    expect(makeRefLookup(pitch).conf(2)).toBe(1)
    expect(makeRefLookup(null).conf(5)).toBe(1)
  })
})

describe('LivePitch', () => {
  it('синус 440Гц детектится', () => {
    const d = new LivePitch()
    const hit = d.detect(sine(440), 48000)
    expect(hit).not.toBe(null)
    expect(hit!.freq).toBeCloseTo(440, -1) // ±5Гц
  })

  it('тишина и вне диапазона — null', () => {
    const d = new LivePitch()
    expect(d.detect(new Float32Array(2048), 48000)).toBe(null)
    expect(d.detect(sine(30), 48000)).toBe(null)
    expect(d.detect(sine(2000), 48000)).toBe(null)
  })

  it('сопрано 1046Гц (до C6) — детектится', () => {
    const d = new LivePitch()
    expect(d.detect(sine(1046.5), 48000)?.freq).toBeCloseTo(1046.5, -1)
  })
})

describe('smoothMedian', () => {
  it('медиана тройки давит выброс', () => {
    const buf: number[] = []
    expect(smoothMedian(buf, 60)).toBe(60)
    expect(smoothMedian(buf, 60)).toBe(60)
    expect(smoothMedian(buf, 72)).toBe(60) // выброс вибрато сглажен
    expect(buf).toHaveLength(3)
  })
})

describe('micLag', () => {
  it('окно анализатора + вход', () => {
    expect(micLag(48000)).toBeCloseTo(1024 / 48000 + 0.015, 6)
    expect(micLag(44100)).toBeGreaterThan(micLag(48000))
  })
})

describe('sampleFrame', () => {
  const lookup = makeRefLookup({ t: [10, 11, 12], midi: [60, 60, 62] })

  it('хит даёт сглаженный кадр с lag-эталоном', () => {
    const buf: number[] = []
    const fr = sampleFrame(buf, 11, 440, lookup, 0.035)
    expect(fr).not.toBe(null)
    expect(fr!.user).toBeCloseTo(69, 0)
    // эталон взят раньше: 11 - 0.035 -> окрестность 11 -> 60
    expect(fr!.ref).toBe(60)
    expect(fr!.t).toBe(11)
  })

  it('тишина и пауза — null и сброс буфера', () => {
    const buf = [69, 69]
    expect(sampleFrame(buf, 11, null, lookup, 0.035)).toBe(null)
    expect(buf).toHaveLength(0)
    const pauseLookup = makeRefLookup({ t: [10, 11, 12], midi: [60, null, 62] })
    const buf2 = [69]
    expect(sampleFrame(buf2, 11, 440, pauseLookup, 0.035)).toBe(null)
    expect(buf2).toHaveLength(0)
  })

  it('кадр несёт веса уверенности', () => {
    const buf: number[] = []
    const wl = makeRefLookup({ t: [10, 11, 12], midi: [60, 60, 62], conf: [0.5, 0.5, 0.5] })
    const fr = sampleFrame(buf, 11, 440, wl, 0.035, 0.85)
    expect(fr!.uw).toBe(0.85)
    expect(fr!.rw).toBe(0.5)
    const def = sampleFrame([], 11, 440, lookup, 0.035)
    expect(def!.uw).toBe(1)
    expect(def!.rw).toBe(1)
  })
})

describe('gradeText', () => {
  it('пороги', () => {
    expect(gradeText(100)).toBe('Звезда караоке')
    expect(gradeText(80)).toBe('Звезда караоке')
    expect(gradeText(79)).toBe('Отличное исполнение')
    expect(gradeText(60)).toBe('Отличное исполнение')
    expect(gradeText(40)).toBe('Хорошо, почти хит')
    expect(gradeText(20)).toBe('Неплохо для разогрева')
    expect(gradeText(0)).toBe('Главное — удовольствие')
  })
})

describe('midiName', () => {
  it('имена с октавой', () => {
    expect(midiName(69)).toBe('A4')
    expect(midiName(60)).toBe('C4')
    expect(midiName(61)).toBe('C#4')
    expect(midiName(72)).toBe('C5')
  })
})

describe('centsOff', () => {
  it('знаковый детюн без октавы', () => {
    expect(centsOff(69, 69)).toBe(0)
    expect(centsOff(69.2, 69)).toBe(20)
    expect(centsOff(68.8, 69)).toBe(-20)
    expect(centsOff(81.2, 69)).toBe(20) // октава не важна
  })
})

describe('windowForTime', () => {
  it('окно едет за курсором', () => {
    expect(windowForTime(100, 200)).toEqual({ t0: 95, t1: 115 })
  })

  it('края clampятся', () => {
    expect(windowForTime(0, 200)).toEqual({ t0: 0, t1: 20 })
    expect(windowForTime(199, 200)).toEqual({ t0: 180, t1: 200 })
  })
})

describe('sliceWindow', () => {  it('границы бинпоиском', () => {
    expect(sliceWindow([1, 2, 3, 4, 5], 2, 4)).toEqual([1, 4])
    expect(sliceWindow([1, 2, 3], 10, 20)).toEqual([3, 3])
    expect(sliceWindow([], 0, 1)).toEqual([0, 0])
  })
})

describe('visibleRange', () => {
  const pitch = { t: [96, 97, 98, 120], midi: [60, 64, 67, 90] }

  it('окно ±15 от медианы видимого', () => {
    // медиана [60,64,67] = 64
    expect(visibleRange(pitch, 95, 115)).toEqual({ lo: 49, hi: 79 })
  })

  it('выбросы шкалу не растягивают', () => {
    const noisy = {
      t: [0, 1, 2, 3, 4, 5, 6],
      midi: [31, 60, 61, 62, 63, 64, 90],
    }
    // медиана 62: мусор 31 и 90 за бортом, но в клампе
    expect(visibleRange(noisy, 0, 10)).toEqual({ lo: 47, hi: 77 })
  })

  it('паузы пропускаются, пусто — null', () => {
    expect(visibleRange({ t: [1], midi: [null] }, 0, 10)).toBe(null)
    expect(visibleRange(null, 0, 10)).toBe(null)
  })
})

describe('quantizePitchTrack', () => {
  // шаг сэмплов 0.05с
  const track = (midi: (number | null)[]): { t: number[]; midi: (number | null)[] } => ({
    t: midi.map((_, i) => Math.round(i * 0.05 * 1000) / 1000),
    midi,
  })

  it('дрожание превращается в ровные ступени', () => {
    const q = quantizePitchTrack(track([60.4, 59.7, 60.2, 59.9, 60.1, 60, 60.3]))
    expect(q?.midi).toEqual([60, 60, 60, 60, 60, 60, 60])
  })

  it('выброс в начале озвучки короче 90мс — в паузу', () => {
    const q = quantizePitchTrack(track([67, 67, 60, 60, 60, 60, 60, 60]))
    expect(q?.midi?.slice(0, 2)).toEqual([null, null])
    expect(q?.midi?.slice(2)).toEqual([60, 60, 60, 60, 60, 60])
  })

  it('октавный срыв между одинаковыми соседями чинится', () => {
    const q = quantizePitchTrack(track([60, 60, 60, 72, 72, 72, 60, 60, 60]))
    expect(q?.midi).toEqual([60, 60, 60, 60, 60, 60, 60, 60, 60])
  })

  it('паузы не трогаем, пусто — null', () => {
    const q = quantizePitchTrack(track([60, 60, 60, null, null, null, null, 62, 62, 62]))
    expect(q?.midi?.slice(0, 3)).toEqual([60, 60, 60])
    expect(q?.midi?.slice(3, 7)).toEqual([null, null, null, null])
    expect(quantizePitchTrack(null)).toBe(null)
  })

  it('микродропаут строгий трек не сшивает', () => {
    const q = quantizePitchTrack(track([60, 60, 60, null, null, 62, 62, 62]))
    expect(q?.midi).toEqual([60, 60, 60, null, null, 62, 62, 62])
  })

  it('крошка внутри озвучки затирается соседом, по краям — в паузу', () => {
    // медиана тянет 2-сэмпловый переход к длинной стороне
    const q = quantizePitchTrack(track([60, 60, 60, 64, 64, 62, 62, 62]))
    expect(q?.midi).toEqual([60, 60, 60, 62, 62, 62, 62, 62])
    const tail = quantizePitchTrack(track([60, 60, 60, 60, 60, 60, 67, 67]))
    expect(tail?.midi?.slice(6)).toEqual([null, null])
  })

  it('короткий ран строгий трек выкидывает в паузу', () => {
    // шаг 23мс как в pitch.json: ран 64 длиной 3 сэмпла (46мс) короче 90мс
    const midi = [...Array(6).fill(60), ...Array(3).fill(64), ...Array(6).fill(62)]
    const p = { t: midi.map((_, i) => Math.round((i / 43) * 1000) / 1000), midi }
    const q = quantizePitchTrack(p)
    expect(q?.midi).toEqual([...Array(6).fill(60), ...Array(3).fill(null), ...Array(6).fill(62)])
  })

  it('октавный джиттер сворачивается в доминирующую октаву', () => {
    const q = quantizePitchTrack(track([60, 60, 72, 72, 60, 60, 60, 60]))
    expect(q?.midi).toEqual([60, 60, 60, 60, 60, 60, 60, 60])
  })

  it('длинный октавный пассаж не трогаем', () => {
    const m = [...Array(8).fill(60), ...Array(10).fill(72), ...Array(8).fill(60)]
    const q = quantizePitchTrack(track(m))
    expect(q?.midi?.[0]).toBe(60)
    expect(q?.midi?.[12]).toBe(72)
    expect(q?.midi?.[25]).toBe(60)
  })

  it('времена не едут', () => {
    const p = track([60.2, 60.8])
    expect(quantizePitchTrack(p)?.t).toEqual(p.t)
  })
})

describe('displayPitchTrack', () => {
  // шаг сэмплов 0.05с
  const track = (midi: (number | null)[]): { t: number[]; midi: (number | null)[] } => ({
    t: midi.map((_, i) => Math.round(i * 0.05 * 1000) / 1000),
    midi,
  })

  it('микродропаут короче 120мс сшивается левой нотой', () => {
    const q = displayPitchTrack(track([60, 60, 60, null, null, 62, 62, 62]))
    expect(q?.midi).toEqual([60, 60, 60, 60, 60, 62, 62, 62])
  })

  it('настоящая пауза остаётся паузой', () => {
    const q = displayPitchTrack(track([60, 60, 60, null, null, null, null, 62, 62, 62]))
    expect(q?.midi?.slice(3, 7)).toEqual([null, null, null, null])
  })

  it('короткий ран внутри озвучки заливается длинным соседом', () => {
    // шаг 23мс как в pitch.json: ран 64 длиной 3 сэмпла (46мс) короче 90мс
    const midi = [...Array(6).fill(60), ...Array(3).fill(64), ...Array(6).fill(62)]
    const p = { t: midi.map((_, i) => Math.round((i / 43) * 1000) / 1000), midi }
    const q = displayPitchTrack(p)
    expect(q?.midi).toEqual([...Array(9).fill(60), ...Array(6).fill(62)])
  })

  it('пусто — null', () => {
    expect(displayPitchTrack(null)).toBe(null)
  })
})

describe('fixJitterIslands', () => {
  // шаг 23мс как в pitch.json
  const mk = (midi: (number | null)[]) => ({
    t: midi.map((_, i) => Math.round((i / 43) * 1000) / 1000),
    midi: [...midi],
  })
  const dense = [60, 61, 59, 62]

  it('октавный остров в джиттер-зоне сворачивается', () => {
    const m = [...dense, ...dense, ...dense, ...Array(10).fill(60), ...Array(15).fill(48), ...Array(10).fill(60), ...dense, ...dense, ...dense]
    const p = mk(m)
    fixJitterIslands(p.t, p.midi)
    // остров 15 сэмплов (~0.33с): все 48 -> 60
    expect(p.midi.slice(22, 37)).toEqual(Array(15).fill(60))
  })

  it('тот же остров в стабильном месте живёт', () => {
    const m = [...Array(30).fill(60), ...Array(15).fill(48), ...Array(30).fill(60)]
    const p = mk(m)
    fixJitterIslands(p.t, p.midi)
    expect(p.midi.slice(30, 45)).toEqual(Array(15).fill(48))
  })

  it('квинтовый остров в джиттер-зоне сворачивается', () => {
    const m = [...dense, ...dense, ...dense, ...Array(10).fill(60), ...Array(12).fill(53), ...Array(10).fill(60), ...dense, ...dense, ...dense]
    const p = mk(m)
    fixJitterIslands(p.t, p.midi)
    expect(p.midi.slice(22, 34)).toEqual(Array(12).fill(60))
  })

  it('остров от секунды не трогаем даже в джиттере', () => {
    const m = [...dense, ...dense, ...dense, ...Array(10).fill(60), ...Array(50).fill(48), ...Array(10).fill(60), ...dense, ...dense, ...dense]
    const p = mk(m)
    fixJitterIslands(p.t, p.midi)
    expect(p.midi.slice(22, 72)).toEqual(Array(50).fill(48))
  })

  it('короткий остров чинится и в стабильном месте', () => {
    const m = [...Array(30).fill(60), ...Array(5).fill(48), ...Array(30).fill(60)]
    const p = mk(m)
    fixJitterIslands(p.t, p.midi)
    expect(p.midi.slice(30, 35)).toEqual(Array(5).fill(60))
  })
})

describe('foldToRegister', () => {
  const mk = (midi: (number | null)[]) => ({
    t: midi.map((_, i) => i),
    midi: [...midi],
  })

  it('октавный раскол тянется к большинству, ничья — вверх', () => {
    // 48 ×8 против 60 ×10: мода 60, 48 -> 60
    const m = [...Array(8).fill(48), ...Array(10).fill(60)]
    const p = mk(m)
    foldToRegister(p.t, p.midi)
    expect(p.midi).toEqual(Array(18).fill(60))
  })

  it('честная октава ±6 от якоря живёт', () => {
    const m = [...Array(10).fill(54), ...Array(4).fill(60), ...Array(10).fill(54)]
    const p = mk(m)
    foldToRegister(p.t, p.midi)
    expect(p.midi.slice(10, 14)).toEqual([60, 60, 60, 60])
  })

  it('у каждого куска свой якорь, паузы — разрывы', () => {
    const m = [...Array(10).fill(48), null, null, ...Array(10).fill(48)]
    const p = mk(m)
    foldToRegister(p.t, p.midi)
    expect(p.midi.slice(0, 10)).toEqual(Array(10).fill(48))
    expect(p.midi.slice(10, 12)).toEqual([null, null])
  })
})

describe('gatePitchToSegments', () => {
  const track = (midi: (number | null)[]): { t: number[]; midi: (number | null)[] } => ({
    t: midi.map((_, i) => i),
    midi,
  })
  const segs = [{ start: 2, end: 4 }]

  it('внутри сегмента и в маржах живёт, снаружи — null', () => {
    // t=1.6 в pre-марже (2-0.5=1.5), t=5 — за post-маржей (4+0.5)
    const q = gatePitchToSegments(
      { t: [1, 1.6, 2, 3, 4, 4.4, 5], midi: [60, 60, 60, 60, 60, 60, 60] },
      segs,
    )
    expect(q?.midi).toEqual([null, 60, 60, 60, 60, 60, null])
  })

  it('границы включительно, паузы не воскрешает', () => {
    const q = gatePitchToSegments(track([60, null, 62]), [{ start: 0, end: 2 }])
    expect(q?.midi).toEqual([60, null, 62])
  })

  it('без сегментов — как есть, пусто — null', () => {
    const p = track([60, 61])
    expect(gatePitchToSegments(p, [])?.midi).toEqual([60, 61])
    expect(gatePitchToSegments(null, segs)).toBe(null)
  })

  it('времена не едут', () => {
    const p = track([60])
    expect(gatePitchToSegments(p, segs)?.t).toEqual(p.t)
  })
})
