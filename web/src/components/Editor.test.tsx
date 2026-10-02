// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const load = vi.fn(async () => {})
const destroy = vi.fn()
let engEvents: { onTime?: (t: number) => void; onReady?: () => void } = {}

vi.mock('../lib/audioEngine', () => ({
  EditorAudioEngine: function (this: unknown, ev: { onTime?: (t: number) => void; onReady?: () => void }) {
    engEvents = ev
    return {
      load,
      destroy,
      getTime: () => 0,
      setRate: vi.fn(),
      setVolume: vi.fn(),
      playFrom: vi.fn(() => true),
      seek: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      setLoop: vi.fn(),
    }
  },
}))
vi.mock('../lib/wav', async (orig) => ({
  ...((await orig()) as object),
  mp3UrlToWavBlobUrl: vi.fn(async () => 'blob:wav'),
}))

import Editor from './Editor'

const song = {
  id: 't',
  title: 'Тест',
  audio: 'songs/t/minus.mp3',
  original: 'songs/t/original.mp3',
  lines: 1,
  duration: 100,
  segments: [
    { start: 10, end: 20, text: 'раз два', words: [{ w: 'раз', s: 10, e: 15 }, { w: 'два', s: 15, e: 20 }] },
  ],
  pitch: null,
  waveform: { peaks: [0.1, 0.5, 0.9], duration: 100 },
}

const props = () => ({ song, onClose: vi.fn(), onSave: vi.fn(), onReset: vi.fn(), onSeek: vi.fn(), resetSignal: 0 })

beforeEach(() => {
  vi.clearAllMocks()
  cleanup()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    setTransform: vi.fn(), scale: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(),
    beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(),
  } as never)
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 300 })
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get: () => 120 })
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, width: 300, height: 120, right: 300, bottom: 120, x: 0, y: 0, toJSON: () => ({}) }),
  })
})

describe('Editor', () => {
  it('открывается: шапка, строка, waveform; движок грузит WAV', async () => {
    const p = props()
    render(<Editor key={1} {...p} />)
    expect(screen.getByText('Редактор тайминга')).not.toBe(null)
    expect(screen.getByText('раз два')).not.toBe(null)
    await waitFor(() => expect(load).toHaveBeenCalledWith('blob:wav', null))
  })

  it('закрытие и destroy движка', async () => {
    const p = props()
    const { unmount } = render(<Editor key={1} {...p} />)
    fireEvent.click(screen.getAllByLabelText('Закрыть')[0])
    expect(p.onClose).toHaveBeenCalledTimes(1)
    unmount()
    expect(destroy).toHaveBeenCalled()
  })
})

describe('Editor skips', () => {
  const songSkips = {
    id: 'ts',
    title: 'Тест',
    audio: 'songs/ts/minus.mp3',
    original: 'songs/ts/original.mp3',
    lines: 1,
    duration: 100,
    segments: [
      { start: 10, end: 20, text: 'раз два', words: [{ w: 'раз', s: 10, e: 15 }, { w: 'два', s: 15, e: 20 }] },
    ],
    pitch: null,
    waveform: { peaks: [0.1, 0.5, 0.9], duration: 100 },
  }

  const drag = (cv: Element, x0: number, x1: number) => {
    fireEvent.pointerDown(cv, { clientX: x0, pointerId: 1 })
    fireEvent.pointerMove(cv, { clientX: x1, pointerId: 1 })
    fireEvent.pointerUp(cv, { clientX: x1, pointerId: 1 })
  }

  it('таскание по волне в режиме выделения создаёт пропуск', () => {
    const p = { ...props(), song: songSkips }
    render(<Editor key={2} {...p} />)
    act(() => {
      engEvents.onReady?.()
    })
    fireEvent.click(screen.getByText(/выделить на дорожке/))
    // редактор в портале: canvas ищем в document
    const cv = document.querySelector('canvas')!
    drag(cv, 30, 90) // 300px = 100с: 10с -> 30с
    expect(screen.getByLabelText('Удалить пропуск 0:10.000–0:30.000')).not.toBe(null)
  })

  it('короткое таскание игнорируется', () => {
    const p = { ...props(), song: songSkips }
    render(<Editor key={3} {...p} />)
    fireEvent.click(screen.getByText(/выделить на дорожке/))
    const cv = document.querySelector('canvas')!
    drag(cv, 30, 30.5) // 0.5px = 0.17с < 0.2с
    expect(screen.queryByLabelText(/Удалить пропуск/)).toBe(null)
  })

  it('удаление и сохранение в localStorage', async () => {
    const withSkip = { ...songSkips, skips: [{ s: 1, e: 2 }] }
    const p = { ...props(), song: withSkip }
    render(<Editor key={4} {...p} />)
    const del = screen.getByLabelText('Удалить пропуск 0:01.000–0:02.000')
    fireEvent.click(del)
    expect(screen.queryByLabelText(/Удалить пропуск/)).toBe(null)
    fireEvent.click(screen.getByText(/^Сохранить/))
    // без сервера — fallback в localStorage
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('karaoke:skips:ts')!)).toEqual({ skips: [] })
    })
    expect(p.onSave).toHaveBeenCalled()
  })
})
