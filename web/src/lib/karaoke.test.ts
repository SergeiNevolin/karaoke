import { describe, expect, it } from 'vitest'
import { ballProgress, ballXY, karaokeFrame, lineTextSize } from './karaoke'
import { evenWords } from './songs'
import type { Segment } from './types'

const segs = (list: [number, number, string][]): Segment[] =>
  list.map(([start, end, text]) => ({
    start,
    end,
    text,
    words: evenWords(text, start, end),
  }))

describe('karaokeFrame: окно', () => {
  const s = segs([
    [10, 12, 'раз два'],
    [14, 16, 'три четыре'],
    [20, 22, 'пять шесть'],
    [24, 26, 'семь восемь'],
  ])

  it('до старта — первые три, спето 0, шарика нет', () => {
    const f = karaokeFrame(s, 0)
    expect(f.winStart).toBe(0)
    expect(f.lines.map((l) => l.i)).toEqual([0, 1, 2])
    expect(f.lines[0].cur).toBe(true)
    expect(f.sung).toBe(0)
    expect(f.ballOn).toBe(false)
  })

  it('в середине строки — она крупная, слова считаются', () => {
    // 'три четыре' на [14,16]: слова [14,15],[15,16]
    const f = karaokeFrame(s, 15.2)
    expect(f.winStart).toBe(1)
    expect(f.sung).toBe(2)
    expect(f.ballOn).toBe(true)
  })

  it('следующая встаёт заранее белой, шарик паркуется за 0.6с', () => {
    const early = karaokeFrame(s, 13.2) // за 0.8с до 'три' — ещё старая
    expect(early.winStart).toBe(0)
    const parked = karaokeFrame(s, 13.8) // за 0.2с — новая белая, шарик на первом слове
    expect(parked.winStart).toBe(1)
    expect(parked.sung).toBe(0)
    expect(parked.ballOn).toBe(true)
  })

  it('тесные строки: переключает ровно на старте, подсветка со 2-го кадра', () => {
    const tight = segs([
      [10, 12, 'раз два'],
      [12.2, 14, 'три четыре'],
    ])
    const before = karaokeFrame(tight, 12.1)
    expect(before.winStart).toBe(0)
    const at = karaokeFrame(tight, 12.25)
    expect(at.winStart).toBe(1)
    // 'три четыре' на [12.2,14]: слова [12.2,13.1],[13.1,14]
    expect(at.sung).toBe(1)
  })

  it('кейс пользователя: стык [7.71,9.71]->[9.71,13.29] — switch ровно в 9.71', () => {
    const s: Segment[] = [
      {
        start: 7.71,
        end: 9.71,
        text: 'Йо, вчера был гламур',
        words: [
          { w: 'Йо,', s: 7.71, e: 8.21 },
          { w: 'вчера', s: 8.21, e: 8.71 },
          { w: 'был', s: 8.71, e: 9.21 },
          { w: 'гламур', s: 9.21, e: 9.71 },
        ],
      },
      {
        start: 9.71,
        end: 13.29,
        text: 'Утром проспал на маникюр',
        words: [
          { w: 'Утром', s: 9.71, e: 10.61 },
          { w: 'проспал', s: 10.61, e: 11.5 },
          { w: 'на', s: 11.5, e: 12.39 },
          { w: 'маникюр', s: 12.39, e: 13.29 },
        ],
      },
    ]
    // строка держится до самой границы, все 4 слова успевают подсветиться
    const before = karaokeFrame(s, 9.7)
    expect(before.winStart).toBe(0)
    expect(before.sung).toBe(4)
    // в 9.71 — ровно следующая, первое слово сразу подсвечено
    const at = karaokeFrame(s, 9.71)
    expect(at.winStart).toBe(1)
    expect(at.sung).toBe(1)
    // чуть раньше границы — ещё старая
    expect(karaokeFrame(s, 9.66).winStart).toBe(0)
    expect(karaokeFrame(s, 9.719).winStart).toBe(1)
  })

  it('после конца песни окно стоит на последней', () => {
    const f = karaokeFrame(s, 100)
    expect(f.winStart).toBe(3)
    expect(f.lines.map((l) => l.i)).toEqual([3])
  })

  it('пусто — окно 0 без строк', () => {
    const f = karaokeFrame([], 5)
    expect(f.winStart).toBe(0)
    expect(f.lines).toEqual([])
    expect(f.sung).toBe(0)
    expect(f.ballOn).toBe(false)
  })
})

describe('karaokeFrame: спетость', () => {
  // слова 'a b c d' на [10,14]: [10,11],[11,12],[12,13],[13,14]
  const s = segs([[10, 14, 'a b c d']])

  it('ровно по границе слова — мс в мс, без упреждений', () => {
    expect(karaokeFrame(s, 9.999).sung).toBe(0)
    expect(karaokeFrame(s, 10).sung).toBe(1)
    expect(karaokeFrame(s, 11).sung).toBe(2)
  })

  it('после конца — все слова', () => {
    expect(karaokeFrame(s, 14.5).sung).toBe(4)
  })
})

describe('karaokeFrame: миллисекунды', () => {  // слова ровно в мс: a [10.123,11.456], b [11.456,12.789]
  const msSeg: Segment = {
    start: 10.123,
    end: 12.789,
    text: 'a b',
    words: [
      { w: 'a', s: 10.123, e: 11.456 },
      { w: 'b', s: 11.456, e: 12.789 },
    ],
  }
  const ws: Segment[] = [msSeg]

  it('переключение спетости ровно на границе мс', () => {
    expect(karaokeFrame(ws, 11.455).sung).toBe(1)
    expect(karaokeFrame(ws, 11.456).sung).toBe(2)
  })

  it('окно встаёт ровно за 350мс до старта', () => {
    const two = segs([
      [1, 2, 'раз'],
      [10.123, 12, 'два'],
    ])
    expect(karaokeFrame(two, 9.772).winStart).toBe(0)
    expect(karaokeFrame(two, 9.773).winStart).toBe(1)
  })

  it('шарик в доле мс-интервала', () => {
    // sung=1: от a.s=10.123 до b.s=11.456, середина 10.7895
    expect(ballProgress(ws[0], 1, 10.7895)).toBeCloseTo(0.5, 5)
    expect(ballProgress(ws[0], 1, 10.123)).toBe(0)
    expect(ballProgress(ws[0], 1, 11.456)).toBe(1)
  })
  const s = segs([[10, 14, 'a b c d']])[0]

  it('до зоны шарика — 0, дальше летит', () => {
    expect(ballProgress(s, 0, 9.0)).toBe(0)
    expect(ballProgress(s, 0, 9.4)).toBe(0)
    expect(ballProgress(s, 0, 9.7)).toBeCloseTo(0.5, 5)
  })

  it('середина слова — доля', () => {
    // sung=2: от s.words[1].s=11 до s.words[2].s=12
    expect(ballProgress(s, 2, 11.5)).toBeCloseTo(0.5, 5)
  })

  it('после строки — 1', () => {
    expect(ballProgress(s, 4, 20)).toBe(1)
  })

  it('без слов — 1', () => {
    expect(ballProgress({ ...s, words: [] }, 0, 11)).toBe(1)
  })
})

describe('lineTextSize', () => {
  it('короткие крупно, длинные ужимаются целиком', () => {
    expect(lineTextSize(0)).toContain('text-4xl')
    expect(lineTextSize(4)).toContain('text-4xl')
    expect(lineTextSize(12)).toContain('text-4xl')
    expect(lineTextSize(13)).toContain('text-2xl')
    expect(lineTextSize(20)).toContain('text-2xl')
    expect(lineTextSize(21)).toContain('text-xl')
    expect(lineTextSize(37)).toContain('text-xl')
  })
})

describe('ballXY', () => {  it('пустые центры — ноль', () => {
    expect(ballXY([], 0, 0.5)).toEqual({ x: 0, y: 0 })
  })

  it('концы и дуга', () => {
    const c = [10, 20, 30]
    expect(ballXY(c, 0, 0).x).toBe(10)
    expect(ballXY(c, 1, 1).x).toBe(20)
    const mid = ballXY(c, 1, 0.5)
    expect(mid.x).toBe(15)
    expect(mid.y).toBeCloseTo(-20, 5)
    expect(ballXY(c, 1, 0).y).toBeCloseTo(0, 5)
  })

  it('мусор на входе — числа на выходе, без NaN и крашей', () => {
    const s = segs([[10, 12, 'раз два']])[0]
    const p = ballProgress(s, 99, 11)
    expect(Number.isFinite(p)).toBe(true)
    expect(p).toBeGreaterThanOrEqual(0)
    expect(p).toBeLessThanOrEqual(1)
    const xy = ballXY([10, 20], -3, 5)
    expect(Number.isFinite(xy.x)).toBe(true)
    expect(Number.isFinite(xy.y)).toBe(true)
  })
})
