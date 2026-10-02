import { describe, expect, it } from 'vitest'
import { normalizeWords, syncWords, tokenSpans, tokenStart, wordTokens } from './wordModel'
import type { Segment } from './types'

const seg = (text: string, words: [string, number, number][]): Segment => ({
  start: words[0]?.[1] ?? 0,
  end: words[words.length - 1]?.[2] ?? 0,
  text,
  words: words.map(([w, s, e]) => ({ w, s, e })),
})

describe('wordTokens / tokenSpans / tokenStart', () => {
  it('склеенное слово покрывает два токена', () => {
    expect(wordTokens({ w: 'good bye', s: 0, e: 1 })).toEqual(['good', 'bye'])
    expect(tokenSpans([{ w: 'a', s: 0, e: 1 }, { w: 'b c', s: 1, e: 2 }])).toEqual([1, 2])
    expect(tokenStart([1, 2, 1], 2)).toBe(3)
  })
})

describe('syncWords', () => {
  it('то же число слов — тайминги целы, текст обновлён', () => {
    const s = seg('старый текст', [
      ['старый', 1, 2],
      ['текст', 2, 3],
    ])
    const out = syncWords({ ...s, text: 'новый текст' })
    expect(out.words.map((w) => w.w)).toEqual(['новый', 'текст'])
    expect(out.words[0].s).toBe(1)
    expect(out.words[1].e).toBe(3)
  })

  it('склейка переживает сохранение: тайминги не трогаем', () => {
    const s = seg('a b c', [
      ['a', 1, 2],
      ['b c', 2, 4],
    ])
    const out = syncWords(s)
    expect(out.words.map((w) => w.w)).toEqual(['a', 'b c'])
    expect(out.words[1].s).toBe(2)
    expect(out.words[1].e).toBe(4)
  })

  it('мс-тайминги переживают синхронизацию нетронутыми', () => {
    const s = seg('а б', [
      ['а', 1.234, 2.345],
      ['б', 2.345, 3.456],
    ])
    const out = syncWords(s)
    expect(out.words[0].s).toBe(1.234)
    expect(out.words[0].e).toBe(2.345)
    expect(out.words[1].s).toBe(2.345)
    expect(out.words[1].e).toBe(3.456)
  })

  it('число слов изменилось — раскладываем заново', () => {
    const s = seg('a b', [
      ['a', 1, 2],
      ['b', 2, 3],
    ])
    const out = syncWords({ ...s, text: 'a b c', start: 0, end: 6 })
    expect(out.words).toHaveLength(3)
    expect(out.words[0].s).toBe(0)
    expect(out.words[2].e).toBe(6)
  })
})

describe('normalizeWords', () => {
  it('кламп в строку и монотонность в мс', () => {
    const out = normalizeWords(
      [
        { w: 'a', s: 9, e: 10.1234 },
        { w: 'b', s: 10.05, e: 10.04 },
        { w: 'c', s: 11.9999, e: 99 },
      ],
      10,
      12,
    )
    expect(out.map((w) => [w.s, w.e])).toEqual([
      [10, 10.123],
      [10.123, 10.153],
      [12, 12],
    ])
  })

  it('чистые не трогаем', () => {
    const ws = [
      { w: 'a', s: 10.123, e: 11 },
      { w: 'b', s: 11.5, e: 12 },
    ]
    expect(normalizeWords(ws, 10, 12)).toEqual(ws)
  })
})
