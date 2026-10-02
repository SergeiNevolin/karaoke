// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { useKaraoke } from '../store'

const META = {
  id: 't',
  title: 'Тестовая песня',
  audio: 'songs/t/minus.mp3',
  original: 'songs/t/original.mp3',
  vocals: 'songs/t/vocals.mp3',
  language: 'ru',
  lines: 1,
  duration: 40,
}

function mockFetch() {
  vi.stubGlobal('fetch', (async (url: string) => {
    const u = String(url)
    const json = (data: unknown) => ({ ok: true, json: async () => data })
    if (u.includes('/api/songs')) return json({ songs: [META] })
    if (u.includes('lyrics.json')) {
      return json({
        language: 'ru',
        segments: [
          { start: 1, end: 3, text: 'раз два', words: [{ w: 'раз', s: 1, e: 2 }, { w: 'два', s: 2, e: 3 }] },
        ],
      })
    }
    if (u.includes('pitch.json')) return json({ t: [], midi: [] })
    if (u.includes('waveform.json')) return json({ peaks: [0.1, 0.2], duration: 40 })
    throw new Error(`unexpected fetch ${u}`)
  }) as unknown as typeof fetch)
}

beforeEach(() => {
  mockFetch()
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
  vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  useKaraoke.setState({ screen: 'catalog', song: null, songs: [], favorites: [], recent: [] })
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('App: каталог → песня → назад', () => {
  it('возврат показывает каталог, а не чёрный экран', async () => {
    render(<App />)
    // каталог загрузился
    const sing = await screen.findByText('Петь')
    fireEvent.click(sing)
    // плеер открылся
    await screen.findByText('Просто подпевать')
    // назад в каталог
    fireEvent.click(screen.getByTitle('Вернуться в каталог'))
    // каталог снова виден (дожидаемся exit-анимации)
    await screen.findByText('Все песни', undefined, { timeout: 3000 })
    expect(screen.getByText('Тестовая песня')).toBeInTheDocument()
    expect(document.body.textContent ?? '').toContain('Тестовая песня')
  })
})
