import { describe, expect, it } from 'vitest'
import { applyTextToSegments, evenWords, formatTime, formatTimeMs, locate, locateWindow, nearestSegment, sortRowsByStart } from './songs'
import type { Segment } from './types'

const segs = (list: [number, number, string][]): Segment[] =>
  list.map(([start, end, text]) => ({
    start,
    end,
    text,
    words: evenWords(text, start, end),
  }))

describe('locate (подсветка при проигрывании)', () => {
  const s = segs([
    [9.07, 14.31, 'LOL пожалуйста прости'],
    [28.03, 30.1, 'Сорри goodbye'],
    [37.5, 41.01, 'Прости я не знаю'],
  ])

  it('находит сегмент внутри с допуском на старт', () => {
    expect(locate(s, 9.0).seg).toBe(0) // 9.07 - 0.15
    expect(locate(s, 12).seg).toBe(0)
  })

  it('держит хвост сегмента (+0.4с)', () => {
    expect(locate(s, 14.6).seg).toBe(0)
  })

  it('границы допусков — с точностью до мс', () => {
    // старт 9.07-0.15=8.92; конец 14.31+0.4=14.71
    expect(locate(s, 8.919).seg).toBe(-1)
    expect(locate(s, 8.921).seg).toBe(0)
    expect(locate(s, 14.709).seg).toBe(0)
    expect(locate(s, 14.711).seg).toBe(0) // хвост кончился, следующий далеко — стоим на прошедшей
  })

  it('возвращает предыдущий в паузе', () => {
    const r = locate(s, 35)
    expect(r.seg).toBe(1)
  })

  it('до первой строки возвращает -1', () => {
    expect(locate(s, 1).seg).toBe(-1)
  })

  it('считает спетые слова', () => {
    const r = locate(s, 10)
    expect(r.sungWords).toBeGreaterThanOrEqual(1)
    expect(r.sungWords).toBeLessThanOrEqual(3)
  })
})

describe('nearestSegment (выбор кликом)', () => {
  const s = segs([
    [9.07, 14.31, 'куплет'],
    [30.1, 35.0, 'предприпев'],
    [37.5, 41.01, 'припев'],
  ])

  it('внутри строки — она', () => {
    expect(nearestSegment(s, 12)).toBe(0)
  })

  it('в паузе — ближайшая, а не предыдущая', () => {
    expect(nearestSegment(s, 36.5)).toBe(2) // 1.0 до припева против 1.5 до предприпева
    expect(nearestSegment(s, 0.5)).toBe(0) // до первой строки
  })

  it('после конца — последняя', () => {
    expect(nearestSegment(s, 200)).toBe(2)
  })

  it('пустой список — -1', () => {
    expect(nearestSegment([], 5)).toBe(-1)
  })

  it('битые строки пропускаем', () => {
    const bad = [
      { start: 10, end: 5, text: 'мусор', words: [] },
      { start: 20, end: 22, text: 'норма', words: [] },
    ]
    expect(nearestSegment(bad, 7)).toBe(1)
    expect(nearestSegment([{ start: 10, end: 5, text: 'x', words: [] }], 7)).toBe(-1)
  })
})

describe('evenWords', () => {
  it('раскладывает равномерно и покрывает весь интервал', () => {
    const ws = evenWords('раз два три', 10, 13)
    expect(ws).toHaveLength(3)
    expect(ws[0].s).toBe(10)
    expect(ws[2].e).toBe(13)
    expect(ws[0].e).toBe(ws[1].s)
  })

  it('пустой текст — пусто', () => {
    expect(evenWords('   ', 0, 1)).toEqual([])
  })

  it('сломанный интервал не инвертирует слова', () => {
    const ws = evenWords('а б', 10, 5)
    expect(ws[0].e).toBeGreaterThan(ws[0].s)
    expect(ws[1].s).toBeGreaterThanOrEqual(ws[0].e)
  })

  it('мс-значения: округление до тысячных и стыки без щелей', () => {
    const ws = evenWords('а б в', 10.1234, 12.3456)
    expect(ws).toHaveLength(3)
    for (const w of ws) {
      expect(w.s).toBe(Math.round(w.s * 1000) / 1000)
      expect(w.e).toBe(Math.round(w.e * 1000) / 1000)
    }
    expect(ws[0].s).toBe(10.123)
    expect(ws[2].e).toBe(12.346)
    expect(ws[0].e).toBe(ws[1].s)
    expect(ws[1].e).toBe(ws[2].s)
  })
})

describe('formatTime (часы для длинных треков)', () => {
  it('h:mm:ss и m:ss', () => {
    expect(formatTime(3661)).toBe('1:01:01')
    expect(formatTime(61)).toBe('1:01')
    expect(formatTime(5)).toBe('0:05')
  })
})

describe('formatTimeMs (индикатор редактора)', () => {
  it('минуты, секунды и миллисекунды', () => {
    expect(formatTimeMs(83.456)).toBe('1:23.456')
    expect(formatTimeMs(5.001)).toBe('0:05.001')
    expect(formatTimeMs(0)).toBe('0:00.000')
  })

  it('не роняется на мусоре', () => {
    expect(formatTimeMs(NaN)).toBe('0:00.000')
    expect(formatTimeMs(-3)).toBe('0:00.000')
  })
})

describe('locateWindow (окно караоке с упреждением)', () => {
  const s = segs([
    [10, 12, 'раз'],
    [14, 16, 'два'],
    [20, 22, 'три'],
  ])

  it('до песни — первая', () => {
    expect(locateWindow(s, 0)).toBe(0)
  })

  it('следующая встаёт за 0.35с до старта, а не когда уже поют', () => {
    expect(locateWindow(s, 13.6)).toBe(0)
    expect(locateWindow(s, 13.7)).toBe(1)
  })

  it('в середине строки держит её', () => {
    expect(locateWindow(s, 15)).toBe(1)
  })

  it('в паузе не прыгает раньше времени', () => {
    expect(locateWindow(s, 18)).toBe(1)
  })

  it('тесные строки: держит текущую до конца, переключает ровно на старте', () => {
    const tight = segs([
      [10, 12, 'раз'],
      [12.2, 14, 'два'],
    ])
    expect(locateWindow(tight, 12.1)).toBe(0)
    expect(locateWindow(tight, 12.16)).toBe(1)
  })

  it('перекрытие: крупная та, что поётся (поздняя), а не зависшая', () => {
    const over = segs([
      [10, 14, 'раз'],
      [12, 16, 'два'],
    ])
    expect(locateWindow(over, 11)).toBe(0)
    expect(locateWindow(over, 13)).toBe(1)
    expect(locateWindow(over, 14.1)).toBe(1)
  })

  it('дубли с одного старта: сначала короткая, потом длинная подхватывает', () => {
    const dups = segs([
      [13.29, 15.29, 'короткая'],
      [13.29, 17.53, 'длинная'],
    ])
    expect(locateWindow(dups, 13.3)).toBe(0)
    expect(locateWindow(dups, 15.5)).toBe(1)
  })

  it('плотная сетка: ни одна строка не пропускается полностью', () => {
    const grid = segs([
      [10, 12, 'a'],
      [12, 14, 'b'],
      [14, 16, 'c'],
    ])
    const seen = new Set<number>()
    for (let t = 9; t <= 17; t += 0.05) seen.add(locateWindow(grid, t))
    expect(seen.has(0)).toBe(true)
    expect(seen.has(1)).toBe(true)
    expect(seen.has(2)).toBe(true)
  })
})

describe('applyTextToSegments (нечёткое наложение)', () => {
  const base = (): Segment[] => [
    { start: 10, end: 12, text: 'раз два', part: undefined, words: [{ w: 'раз', s: 10, e: 11 }, { w: 'два', s: 11, e: 12 }] },
    { start: 14, end: 16, text: 'три четыре', part: undefined, words: [{ w: 'три', s: 14, e: 15 }, { w: 'четыре', s: 15, e: 16 }] },
    { start: 20, end: 22, text: 'пять шесть', part: undefined, words: [{ w: 'пять', s: 20, e: 21 }, { w: 'шесть', s: 21, e: 22 }] },
  ]

  it('тот же текст — тайминги целы', () => {
    const r = applyTextToSegments(base(), 'раз два\nтри четыре\nпять шесть')
    expect(r.matched).toBe(3)
    expect(r.segments[0].words).toEqual(base()[0].words)
    expect(r.inserted).toBe(0)
    expect(r.appended).toBe(0)
  })

  it('опечатка не убивает тайминги: перенос 1-к-1', () => {
    const r = applyTextToSegments(base(), 'раз два\nтри читыре\nпять шесть')
    expect(r.matched).toBe(3)
    // 'три' наследовал [14,15], 'читыре' — [15,16]
    expect(r.segments[1].words).toEqual([
      { w: 'три', s: 14, e: 15 },
      { w: 'читыре', s: 15, e: 16 },
    ])
  })

  it('сдвинутые строки встают на свои сегменты, а не позиционно', () => {
    // лишняя строка в начале: позиционный алгоритм приклеил бы всё со сдвигом
    const r = applyTextToSegments(base(), 'интро-заглушка\nраз два\nтри четыре\nпять шесть')
    // заглушка ушла в паузу перед первым сегментом, 'раз два' — на своём месте
    expect(r.segments[0].text).toBe('интро-заглушка')
    expect(r.segments[1].text).toBe('раз два')
    expect(r.segments[1].start).toBe(10)
    expect(r.inserted).toBe(1)
    expect(r.matched).toBe(3)
  })

  it('пропуск в середине — в паузу, хвост без пары — цел', () => {
    const r = applyTextToSegments(base(), 'раз два\nвставка\nтри четыре')
    expect(r.matched).toBe(2)
    expect(r.inserted).toBe(1)
    const mid = r.segments.find((s) => s.text === 'вставка')
    expect(mid).toBeTruthy()
    // вставка между 12 и 14
    expect(mid!.start).toBeGreaterThanOrEqual(12)
    expect(mid!.end).toBeLessThanOrEqual(14)
    // третий сегмент не тронут
    expect(r.segments[r.segments.length - 1].text).toBe('пять шесть')
  })

  it('лишние строки — в конец, скобки и пустые — мимо', () => {
    const r = applyTextToSegments(base(), '[Куплет]\nраз два\n\nтри четыре\nпять шесть\nна бис\nещё раз')
    expect(r.appended).toBe(2)
    expect(r.segments[r.segments.length - 1].text).toBe('ещё раз')
  })

  it('пустой текст — ничего не делает', () => {
    const r = applyTextToSegments(base(), '  \n[Припев]\n  ')
    expect(r.matched).toBe(0)
    expect(r.segments).toHaveLength(3)
  })

  it('relaxed-проход добирает пограничные пары', () => {
    const segs: Segment[] = [
      { start: 10, end: 12, text: 'а б в г д', words: [{ w: 'а', s: 10, e: 12 }] },
      { start: 14, end: 16, text: 'раз два', words: [{ w: 'раз', s: 14, e: 16 }] },
    ]
    const r = applyTextToSegments(segs, 'а б е ж з\nраз два')
    expect(r.matched).toBe(2)
    expect(r.relaxed).toBe(1)
    expect(r.segments[0].text).toBe('а б е ж з')
  })

  it('тень-дубль давится, остаётся одна версия', () => {
    const mk = (text: string, s: number, e: number): Segment => ({
      start: s,
      end: e,
      text,
      words: [{ w: text, s, e }],
    })
    const r = applyTextToSegments(
      [mk('пошла жара', 10, 12), mk('пошла жара!', 10.5, 14)],
      'пошла жара!',
    )
    expect(r.matched).toBe(1)
    expect(r.deduped).toBe(1)
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0].text).toBe('пошла жара!')
  })
  it('слова в мс, без щелей от округлений', () => {
    const r = applyTextToSegments(base(), 'раз два\nтри четыре пять\nпять шесть')
    for (const s of r.segments) {
      for (const w of s.words) {
        expect(w.s).toBe(Math.round(w.s * 1000) / 1000)
        expect(w.e).toBe(Math.round(w.e * 1000) / 1000)
      }
    }
  })
})

describe('locateWindow (границы допусков и порядок)', () => {
  it('поющееся слово держит строку против раннего захвата', () => {
    const s: Segment[] = [
      { start: 10, end: 12, text: 'а б', words: [{ w: 'а', s: 10, e: 11 }, { w: 'б', s: 11, e: 12 }] },
      { start: 11.5, end: 14, text: 'в г', words: [{ w: 'в', s: 12, e: 13 }, { w: 'г', s: 13, e: 14 }] },
    ]
    // 11.7: у второй уже время, но поётся ещё первая — держим первую
    expect(locateWindow(s, 11.7)).toBe(0)
    // 12.1: первая допета — забирает вторая
    expect(locateWindow(s, 12.1)).toBe(1)
  })

  it('несортированные данные никого не теряют', () => {
    const messy = segs([
      [20, 22, 'три'],
      [10, 12, 'раз'],
      [14, 16, 'два'],
    ])
    expect(locateWindow(messy, 11)).toBe(1)
    expect(locateWindow(messy, 15)).toBe(2)
    expect(locateWindow(messy, 21)).toBe(0)
  })

  it('битая строка (конец раньше начала) окно не держит', () => {
    const bad: Segment[] = [
      { start: 10, end: 999, text: 'хвост', words: [] },
      { start: 12, end: 11, text: 'мусор', words: [] },
      { start: 12, end: 14, text: 'норма', words: [] },
    ]
    // t=13: у первой хвост до 999, вторая битая — крупная всё равно нормальная
    expect(locateWindow(bad, 13)).toBe(2)
  })

  it('пустой список — -1', () => {
    expect(locateWindow([], 5)).toBe(-1)
  })
})

describe('sortRowsByStart (строки меняются местами за словами)', () => {
  it('упорядоченные возвращает тем же массивом', () => {
    const rows = [{ start: 1 }, { start: 2 }, { start: 3 }]
    expect(sortRowsByStart(rows)).toBe(rows)
  })

  it('утянутую раньше соседней ставит на место, стабильно', () => {
    const rows = [
      { start: 10, text: 'a' },
      { start: 14, text: 'b' },
      { start: 8, text: 'c' },
    ]
    const out = sortRowsByStart(rows)
    expect(out.map((r) => r.text)).toEqual(['c', 'a', 'b'])
    // исходник не мутирует
    expect(rows[0].text).toBe('a')
  })

  it('равные старты не тасует', () => {
    const rows = [
      { start: 5, text: 'a' },
      { start: 5, text: 'b' },
    ]
    expect(sortRowsByStart(rows).map((r) => r.text)).toEqual(['a', 'b'])
  })
})
