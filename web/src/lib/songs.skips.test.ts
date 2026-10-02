// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearLocalSkips,
  inSkip,
  loadLocalSkips,
  loadSong,
  saveLocalSkips,
  saveSongLyrics,
  validSkips,
  wantOriginal,
} from './songs'

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('validSkips', () => {
  it('мусор выкидываем, сортируем', () => {
    expect(
      validSkips([
        { s: 5, e: 6 },
        { s: 1, e: 2 },
        { s: 3, e: 3 },
        { s: -1, e: 2 },
        { s: 'x', e: 2 },
        null,
        42,
      ]),
    ).toEqual([
      { s: 1, e: 2 },
      { s: 5, e: 6 },
    ])
    expect(validSkips('junk')).toEqual([])
    expect(validSkips(undefined)).toEqual([])
  })
})

describe('localSkips', () => {
  it('round-trip, clear, битый JSON', () => {
    expect(loadLocalSkips('s')).toBe(null)
    saveLocalSkips('s', [{ s: 2, e: 1 }, { s: 1, e: 2 }])
    expect(loadLocalSkips('s')).toEqual([{ s: 1, e: 2 }])
    clearLocalSkips('s')
    expect(loadLocalSkips('s')).toBe(null)
    localStorage.setItem('karaoke:skips:s', '???')
    expect(loadLocalSkips('s')).toBe(null)
  })

  it('пусто — валидный оверрайд (стирает бандл)', () => {
    saveLocalSkips('s', [])
    expect(loadLocalSkips('s')).toEqual([])
  })
})

describe('inSkip', () => {
  it('границы включительно, пусто — false', () => {
    const skips = [{ s: 10, e: 12 }]
    expect(inSkip(skips, 10)).toBe(true)
    expect(inSkip(skips, 12)).toBe(true)
    expect(inSkip(skips, 9.99)).toBe(false)
    expect(inSkip([], 11)).toBe(false)
    expect(inSkip(undefined, 11)).toBe(false)
  })
})

describe('wantOriginal', () => {
  const skips = [{ s: 10, e: 12 }]
  it('плюс — всегда оригинал; минус — только на пропусках; без файла — никогда', () => {
    expect(wantOriginal('full', skips, true, 5)).toBe(true)
    expect(wantOriginal('full', [], false, 5)).toBe(false)
    expect(wantOriginal('minus', skips, true, 11)).toBe(true)
    expect(wantOriginal('minus', skips, true, 5)).toBe(false)
    expect(wantOriginal('minus', skips, false, 11)).toBe(false)
  })
})

describe('saveSongLyrics', () => {
  const segs = [{ start: 0, end: 1, text: 'а', words: [{ w: 'а', s: 0, e: 1 }] }]
  const skips = [{ s: 2, e: 3 }]

  it('сервер ок — чистим локальное', async () => {
    localStorage.setItem('karaoke:lyrics:t', '???')
    localStorage.setItem('karaoke:skips:t', '???')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })))
    expect(await saveSongLyrics('t', 'ru', segs, skips)).toBe('server')
    expect(localStorage.getItem('karaoke:lyrics:t')).toBe(null)
    expect(localStorage.getItem('karaoke:skips:t')).toBe(null)
  })

  it('сервер ругается — пишем локально', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ error: 'bad' }) })))
    expect(await saveSongLyrics('t', 'ru', segs, skips)).toBe('local')
    expect(JSON.parse(localStorage.getItem('karaoke:skips:t')!)).toEqual({ skips })
  })

  it('400 от сервера (новый контракт) — пишем локально', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'segments — непустой список' }),
      })),
    )
    expect(await saveSongLyrics('t', 'ru', segs, skips)).toBe('local')
    expect(JSON.parse(localStorage.getItem('karaoke:skips:t')!)).toEqual({ skips })
  })

  it('сети нет — пишем локально', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('down')
    }))
    expect(await saveSongLyrics('t', 'ru', segs, skips)).toBe('local')
    expect(JSON.parse(localStorage.getItem('karaoke:lyrics:t')!).segments).toHaveLength(1)
  })
})

describe('loadSong skips', () => {
  const meta = { id: 't', title: 't', audio: 'a', lines: 0, duration: 100 }
  const stubFetch = (lyrics: unknown) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('lyrics.json')) return { ok: true, json: async () => lyrics }
        if (String(url).endsWith('pitch.json')) return { ok: true, json: async () => ({ t: [], midi: [] }) }
        return { ok: true, json: async () => ({ peaks: [], duration: 100 }) }
      }),
    )
  }

  it('бандл проходит, local перекрывает (включая пусто)', async () => {
    stubFetch({ segments: [], skips: [{ s: 1, e: 2 }] })
    expect((await loadSong(meta)).skips).toEqual([{ s: 1, e: 2 }])
    saveLocalSkips('t', [{ s: 5, e: 6 }])
    expect((await loadSong(meta)).skips).toEqual([{ s: 5, e: 6 }])
    saveLocalSkips('t', [])
    expect((await loadSong(meta)).skips).toEqual([])
  })

  it('без пропусков — пусто', async () => {
    stubFetch({ segments: [] })
    expect((await loadSong(meta)).skips).toEqual([])
  })
})
