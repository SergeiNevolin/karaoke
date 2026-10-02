// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SongData } from '../lib/types'
import { useKaraoke } from '../store'
import Player from './Player'

const song = (over: Partial<SongData> = {}): SongData => ({
  id: 't',
  title: 'Тестовая песня',
  audio: 'songs/t/minus.mp3',
  original: 'songs/t/original.mp3',
  vocals: 'songs/t/vocals.mp3',
  language: 'ru',
  lines: 4,
  duration: 40,
  segments: [
    { start: 1, end: 3, text: 'раз два', words: [{ w: 'раз', s: 1, e: 2 }, { w: 'два', s: 2, e: 3 }] },
    { start: 5, end: 7, text: 'три четыре', words: [{ w: 'три', s: 5, e: 6 }, { w: 'четыре', s: 6, e: 7 }] },
    { start: 9, end: 11, text: 'пять шесть', words: [{ w: 'пять', s: 9, e: 10 }, { w: 'шесть', s: 10, e: 11 }] },
    { start: 13, end: 15, text: 'семь восемь', words: [{ w: 'семь', s: 13, e: 14 }, { w: 'восемь', s: 14, e: 15 }] },
  ],
  pitch: null,
  waveform: null,
  ...over,
})

function audioEl(): HTMLAudioElement {
  const el = document.querySelector('audio')
  if (!el) throw new Error('нет <audio>')
  return el
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
  vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  useKaraoke.setState({ screen: 'player', song: song(), songs: [], favorites: [], recent: [] })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Player: окно караоке', () => {
  it('текущая крупно словами + 2 следующие, четвёртой нет', () => {
    render(<Player />)
    // текущая — по словам
    expect(screen.getByText('раз')).toBeInTheDocument()
    expect(screen.getByText('два')).toBeInTheDocument()
    // следующие — целиком
    expect(screen.getByText('три четыре')).toBeInTheDocument()
    expect(screen.getByText('пять шесть')).toBeInTheDocument()
    // четвёртой нет
    expect(screen.queryByText('семь восемь')).not.toBeInTheDocument()
  })

  it('без текста — заглушка', () => {
    useKaraoke.setState({ song: song({ segments: [] }) })
    render(<Player />)
    expect(screen.getByText(/Текст не распознан/)).toBeInTheDocument()
  })
})

describe('Player: минус/плюс', () => {
  it('по умолчанию минус', () => {
    render(<Player />)
    expect(audioEl().getAttribute('src')).toContain('minus.mp3')
  })

  it('дуал-аудио: мастер всегда минус, оригинал второй приглушённой', () => {
    render(<Player />)
    const els = document.querySelectorAll('audio')
    expect(els).toHaveLength(2)
    expect(els[0].getAttribute('src')).toContain('minus.mp3')
    expect(els[1].getAttribute('src')).toContain('original.mp3')
  })

  it('на пропуске «не поём» звук отдаём оригиналу', async () => {
    useKaraoke.setState({ song: song({ skips: [{ s: 10, e: 20 }] }) })
    render(<Player />)
    fireEvent.click(screen.getByText('Просто подпевать'))
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        vi.advanceTimersByTime(750)
      })
    }
    const els = document.querySelectorAll('audio') as unknown as HTMLAudioElement[]
    els[0].currentTime = 15
    await act(async () => {
      vi.advanceTimersByTime(32)
    })
    expect(els[1].muted).toBe(false)
    expect(els[0].muted).toBe(true)
  })

  it('без оригинала переключателя нет', () => {
    useKaraoke.setState({ song: song({ original: null }) })
    render(<Player />)
    expect(screen.queryByText('Плюс')).not.toBeInTheDocument()
  })
})

describe('Player: миллисекунды через ползунок', () => {
  // 'три четыре' на [5,7]: слова [5,6],[6,7]
  it('граница слова в мс красит ровно по ней', () => {
    render(<Player />)
    const slider = screen.getByLabelText('Позиция в песне')
    fireEvent.change(slider, { target: { value: '5.999' } })
    expect(screen.getByText('три').className).toContain('text-primary')
    expect(screen.getByText('четыре').className).toContain('text-text')
    fireEvent.change(slider, { target: { value: '6' } })
    expect(screen.getByText('три').className).toContain('text-primary')
    expect(screen.getByText('четыре').className).toContain('text-primary')
  })

  it('перемотка ставит окно на строку позиции', () => {
    render(<Player />)
    const slider = screen.getByLabelText('Позиция в песне')
    fireEvent.change(slider, { target: { value: '9.5' } })
    // [9,11] 'пять шесть' крупно, первой строки уже нет
    expect(screen.getByText('пять')).toBeInTheDocument()
    expect(screen.queryByText('раз')).not.toBeInTheDocument()
  })

  it('порядок в файле свободный — играет строго по времени', () => {
    const base = song()
    const unsorted = [...base.segments].reverse()
    useKaraoke.setState({ song: song({ segments: unsorted }) })
    render(<Player />)
    // earliest (раз два, start 1) крупно, хотя в файле он последний
    expect(screen.getByText('раз')).toBeInTheDocument()
    expect(screen.getByText('три четыре')).toBeInTheDocument()
    expect(screen.queryByText('семь восемь')).not.toBeInTheDocument()
  })
})

describe('Player: старт', () => {  it('просто подпевать: отсчёт и игра', async () => {
    render(<Player />)
    fireEvent.click(screen.getByText('Просто подпевать'))
    expect(screen.getByText('3')).toBeInTheDocument()
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        vi.advanceTimersByTime(750)
      })
    }
    // игра пошла: есть пауза, отсчёта нет
    expect(screen.getByTitle('Пауза (пробел)')).toBeInTheDocument()
    expect(screen.queryByText('3')).not.toBeInTheDocument()
  })
})
