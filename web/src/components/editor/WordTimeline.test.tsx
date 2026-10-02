// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Word } from '../../lib/types'
import WordTimeline, { type TimelineBlock } from './WordTimeline'

const W = 600
const H = 168
// окно при pad=1: t0=9, t1=23
const X = (t: number): number => ((t - 9) / 14) * W

const blocks = (): TimelineBlock[] => [
  {
    key: 1,
    active: false,
    start: 10,
    end: 12,
    words: [{ w: 'a', s: 10, e: 11 } as Word],
  },
  {
    key: 2,
    active: true,
    start: 14,
    end: 16,
    words: [
      { w: 'b', s: 14, e: 15 },
      { w: 'c', s: 15, e: 16 },
    ] as Word[],
  },
  {
    key: 3,
    active: false,
    start: 20,
    end: 22,
    words: [{ w: 'd', s: 20, e: 21 } as Word],
  },
]

const wave = { peaks: new Array(100).fill(0.5), duration: 30 }

function setup(customBlocks?: TimelineBlock[]) {
  const calls = {
    onSelectWord: vi.fn<(key: number, wi: number) => void>(),
    onChangeWords: vi.fn<(key: number, lineStart: number, lineEnd: number, words: Word[]) => void>(),
    onSeek: vi.fn<(t: number) => void>(),
    onPreview: vi.fn<(key: number, wi: number) => void>(),
    onScrub: vi.fn<(scrubbing: boolean) => void>(),
  }
  const { container } = render(
    <WordTimeline
      wave={wave}
      blocks={customBlocks ?? blocks()}
      time={0}
      selected={null}
      tapPos={null}
      pad={1}
      snapT={null}
      onSelectWord={calls.onSelectWord}
      onChangeWords={calls.onChangeWords}
      onSeek={calls.onSeek}
      onPreview={calls.onPreview}
      onScrub={calls.onScrub}
    />,
  )
  const canvas = container.querySelector('canvas')
  if (!canvas) throw new Error('нет canvas')
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: W,
    height: H,
    right: W,
    bottom: H,
    toJSON: () => ({}),
  })
  return { canvas, calls }
}

function press(el: Element, type: string, x: number, y: number, extra?: { ctrlKey?: boolean; shiftKey?: boolean }): void {
  fireEvent(
    el,
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...extra }),
  )
}

beforeEach(() => {
  window.HTMLElement.prototype.setPointerCapture = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WordTimeline: клики', () => {
  it('клик по слову — только выбор, без перемотки и игры', () => {
    const { canvas, calls } = setup()
    // слово 'c' [15,16] активной дорожки (lane 1): центр x=X(15.5), y=54
    press(canvas, 'pointerdown', X(15.5), 54)
    press(canvas, 'pointerup', X(15.5), 54)
    expect(calls.onSelectWord).toHaveBeenCalledWith(2, 1)
    expect(calls.onSeek).not.toHaveBeenCalled()
  })

  it('клик ниже слов (по волне) — играть с позиции, без выбора', () => {
    const { canvas, calls } = setup()
    // x над словом, но y в зоне волны
    press(canvas, 'pointerdown', X(15.5), 130)
    press(canvas, 'pointerup', X(15.5), 130)
    expect(calls.onSelectWord).not.toHaveBeenCalled()
    expect(calls.onSeek).toHaveBeenCalledTimes(1)
    expect(calls.onSeek.mock.calls[0][0]).toBeCloseTo(15.5, 5)
  })

  it('даблклик — превью слова', () => {
    const { canvas, calls } = setup()
    fireEvent(
      canvas,
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: X(15.5), clientY: 54, button: 0 }),
    )
    expect(calls.onPreview).toHaveBeenCalledWith(2, 1)
  })
})

describe('WordTimeline: Ctrl-мультивыбор', () => {
  // активная строка с зазором: x [14,14.5], y [15.5,16]
  const gapped = (): TimelineBlock[] => [
    {
      key: 2,
      active: true,
      start: 14,
      end: 16,
      words: [
        { w: 'x', s: 14, e: 14.5 },
        { w: 'y', s: 15.5, e: 16 },
      ] as Word[],
    },
  ]

  it('Ctrl+клик переключает выбор без игры и перемотки', () => {
    const { canvas, calls } = setup(gapped())
    // gapped: t0 = 14-1 = 13, t1 = 16+1 = 17; X(t) = ((t-13)/4)*600
    const Xg = (t: number): number => ((t - 13) / 4) * 600
    press(canvas, 'pointerdown', Xg(14.25), 18, { ctrlKey: true })
    press(canvas, 'pointerup', Xg(14.25), 18, { ctrlKey: true })
    press(canvas, 'pointerdown', Xg(15.75), 18, { ctrlKey: true })
    press(canvas, 'pointerup', Xg(15.75), 18, { ctrlKey: true })
    expect(calls.onSelectWord).not.toHaveBeenCalled()
    expect(calls.onSeek).not.toHaveBeenCalled()
  })

  it('группа едет вместе общим сдвигом', () => {
    const { canvas, calls } = setup(gapped())
    const Xg = (t: number): number => ((t - 13) / 4) * 600
    press(canvas, 'pointerdown', Xg(14.25), 18, { ctrlKey: true })
    press(canvas, 'pointerup', Xg(14.25), 18, { ctrlKey: true })
    press(canvas, 'pointerdown', Xg(15.75), 18, { ctrlKey: true })
    press(canvas, 'pointerup', Xg(15.75), 18, { ctrlKey: true })
    // тянем y вправо на 30px = +0.2с
    press(canvas, 'pointerdown', Xg(15.75), 18)
    press(canvas, 'pointermove', Xg(15.75) + 30, 18)
    press(canvas, 'pointerup', Xg(15.75) + 30, 18)
    expect(calls.onChangeWords).toHaveBeenCalled()
    expect(calls.onSelectWord).not.toHaveBeenCalled()
    expect(calls.onSeek).not.toHaveBeenCalled()
    const last = calls.onChangeWords.mock.calls[calls.onChangeWords.mock.calls.length - 1]
    expect(last[0]).toBe(2)
    expect(last[3][0].s).toBeCloseTo(14.2, 2)
    expect(last[3][0].e).toBeCloseTo(14.7, 2)
    expect(last[3][1].e).toBeCloseTo(16.2, 2)
  })
})

describe('WordTimeline: таскание', () => {
  it('край слова тянется в мс', () => {
    const { canvas, calls } = setup()
    // левый край 'b' [14,15]: x=X(14), активная дорожка y=54; тянем на +22px
    press(canvas, 'pointerdown', X(14), 54)
    press(canvas, 'pointermove', X(14) + 22, 54)
    press(canvas, 'pointerup', X(14) + 22, 54)
    expect(calls.onChangeWords).toHaveBeenCalled()
    const last = calls.onChangeWords.mock.calls[calls.onChangeWords.mock.calls.length - 1]
    expect(last[0]).toBe(2)
    // t = 9 + ((214.29+22)/600)*14 = 14.513
    expect(last[3][0].s).toBeCloseTo(14.513, 3)
    expect(last[3][0].e).toBe(15)
  })

  it('тело слова едет целиком, без выбора и игры', () => {
    const { canvas, calls } = setup()
    // центр 'c' [15,16], вдали от краёв (21px при пороге 10px)
    press(canvas, 'pointerdown', X(15.5), 54)
    press(canvas, 'pointermove', X(15.5) + 30, 54)
    press(canvas, 'pointerup', X(15.5) + 30, 54)
    expect(calls.onChangeWords).toHaveBeenCalled()
    const last = calls.onChangeWords.mock.calls[calls.onChangeWords.mock.calls.length - 1]
    expect(last[0]).toBe(2)
    // delta = (30/600)*14 = 0.7: s=15.7, e=16.7
    expect(last[3][1].s).toBeCloseTo(15.7, 2)
    expect(last[3][1].e).toBeCloseTo(16.7, 2)
    expect(calls.onSelectWord).not.toHaveBeenCalled()
    expect(calls.onSeek).not.toHaveBeenCalled()
  })
})

describe('WordTimeline: сдвиг строки', () => {
  it('пустое место дорожки тянет всю строку', () => {
    const { canvas, calls } = setup()
    // пустое место активной дорожки (lane 1, y=54) левее слов: t=13.5
    const x0 = X(13.5)
    press(canvas, 'pointerdown', x0, 54)
    press(canvas, 'pointermove', x0 + 42, 54)
    press(canvas, 'pointerup', x0 + 42, 54)
    expect(calls.onChangeWords).toHaveBeenCalled()
    expect(calls.onSelectWord).not.toHaveBeenCalled()
    expect(calls.onSeek).not.toHaveBeenCalled()
    const last = calls.onChangeWords.mock.calls[calls.onChangeWords.mock.calls.length - 1]
    expect(last[0]).toBe(2)
    // delta = (42/600)*14 = 0.98: строка [14,16] -> [14.98,16.98]
    expect(last[1]).toBeCloseTo(14.98, 2)
    expect(last[2]).toBeCloseTo(16.98, 2)
    expect(last[3][0].s).toBeCloseTo(14.98, 2)
    expect(last[3][0].e).toBeCloseTo(15.98, 2)
    expect(last[3][1].s).toBeCloseTo(15.98, 2)
    expect(last[3][1].e).toBeCloseTo(16.98, 2)
  })

  it('Shift+слово тоже двигает строку, а не слово', () => {
    const { canvas, calls } = setup()
    press(canvas, 'pointerdown', X(15.5), 54, { shiftKey: true })
    press(canvas, 'pointermove', X(15.5) + 42, 54, { shiftKey: true })
    press(canvas, 'pointerup', X(15.5) + 42, 54)
    expect(calls.onChangeWords).toHaveBeenCalled()
    const last = calls.onChangeWords.mock.calls[calls.onChangeWords.mock.calls.length - 1]
    expect(last[0]).toBe(2)
    // вся строка едет: первое слово тоже сдвинулось
    expect(last[3][0].s).toBeCloseTo(14.98, 2)
    expect(last[3][1].s).toBeCloseTo(15.98, 2)
    expect(calls.onSelectWord).not.toHaveBeenCalled()
    expect(calls.onSeek).not.toHaveBeenCalled()
  })

  it('строка упирается в соседей и окно', () => {
    const { canvas, calls } = setup()
    // тянем активную [14,16] далеко влево: упрётся в конец прошлой (12)
    const x0 = X(13.5)
    press(canvas, 'pointerdown', x0, 54)
    press(canvas, 'pointermove', x0 - 200, 54)
    press(canvas, 'pointerup', x0 - 200, 54)
    expect(calls.onChangeWords).toHaveBeenCalled()
    const last = calls.onChangeWords.mock.calls[calls.onChangeWords.mock.calls.length - 1]
    // minD = max(9-14, 12-14) = -2: старт встал на 12
    expect(last[1]).toBeCloseTo(12, 2)
    expect(last[3][0].s).toBeCloseTo(12, 2)
  })
})
