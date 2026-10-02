import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiAvailable, fetchGeniusLines, fetchManifest, getJob, uploadSong } from './api'

const json = (data: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => data,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchManifest', () => {
  it('берёт каталог из API', async () => {
    const songs = [{ id: 'a' }]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === '/api/songs' ? { songs } : {})))
    expect(await fetchManifest()).toEqual(songs)
  })

  it('пустой каталог API — валиден, в статику не лезем', async () => {
    const fetch = vi.fn(async () => json({ songs: [] }))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchManifest()).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('бэкенд упал — fallback на статику', async () => {
    const songs = [{ id: 'b' }]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/songs') throw new Error('down')
        return json({ songs })
      }),
    )
    expect(await fetchManifest()).toEqual(songs)
  })

  it('битый ответ API — fallback на статику', async () => {
    const songs = [{ id: 'c' }]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url === '/api/songs' ? json({ nope: 1 }) : json({ songs }))),
    )
    expect(await fetchManifest()).toEqual(songs)
  })

  it('ничего нет — пусто', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, false, 500)))
    expect(await fetchManifest()).toEqual([])
  })
})

describe('apiAvailable', () => {
  it('ok / fail / throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    expect(await apiAvailable()).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => json({}, false, 500)))
    expect(await apiAvailable()).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('down')
    }))
    expect(await apiAvailable()).toBe(false)
  })
})

describe('uploadSong', () => {
  const file = new File(['x'], 's.mp3', { type: 'audio/mp3' })
  const opts = { lang: 'ru' }

  it('возвращает jobId', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ jobId: 'j1' })))
    expect(await uploadSong(file, opts)).toBe('j1')
  })

  it('ошибки: текст из тела, иначе HTTP / error / без jobId', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Файл больше 1024 МБ' }, false, 413)))
    await expect(uploadSong(file, opts)).rejects.toThrow('Файл больше 1024 МБ')
    vi.stubGlobal('fetch', vi.fn(async () => json({}, false, 500)))
    await expect(uploadSong(file, opts)).rejects.toThrow('HTTP 500')
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'bad' })))
    await expect(uploadSong(file, opts)).rejects.toThrow('bad')
    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    await expect(uploadSong(file, opts)).rejects.toThrow('Нет jobId')
    // тело не JSON — падаем на статус
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('no json')
      },
    })))
    await expect(uploadSong(file, opts)).rejects.toThrow('HTTP 502')
  })

  it('обрыв связи — понятный текст, а не сырой TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    await expect(uploadSong(file, opts)).rejects.toThrow('Нет связи с сервером')
  })
})

describe('getJob', () => {
  it('статус', async () => {
    const st = { id: 'j', state: 'done', stage: 'x', stageLabel: 'y', progress: 100 }
    vi.stubGlobal('fetch', vi.fn(async () => json(st)))
    expect(await getJob('j')).toEqual(st)
  })

  it('404 — задача исчезла (null), не исключение', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Задача не найдена' }, false, 404)))
    expect(await getJob('j')).toBeNull()
  })

  it('ошибка сервера — текст из тела', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'GPU упал' }, false, 500)))
    await expect(getJob('j')).rejects.toThrow('GPU упал')
  })

  it('обрыв связи и таймаут — понятные тексты', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    await expect(getJob('j')).rejects.toThrow('Нет связи с сервером')
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('timed out', 'TimeoutError')
    }))
    await expect(getJob('j')).rejects.toThrow('Сервер не отвечает')
  })
})

describe('fetchGeniusLines', () => {
  it('строки, пусто и ошибки', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ lines: ['a', 'b'] })))
    expect(await fetchGeniusLines('http://x')).toEqual(['a', 'b'])
    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    expect(await fetchGeniusLines('http://x')).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'nope' })))
    await expect(fetchGeniusLines('http://x')).rejects.toThrow('nope')
    vi.stubGlobal('fetch', vi.fn(async () => json({}, false, 500)))
    await expect(fetchGeniusLines('http://x')).rejects.toThrow('HTTP 500')
    // 400 — текст сервера до статуса
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'Принимаются только ссылки genius.com' }, false, 400)),
    )
    await expect(fetchGeniusLines('http://x')).rejects.toThrow('Принимаются только ссылки genius.com')
  })
})
