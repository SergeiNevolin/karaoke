// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Waveform from './Waveform'

const wave = { peaks: [0.2, 0.8, 0.5, 1], duration: 100 }
const segments = [
  { start: 10, end: 20, text: 'a', words: [] },
  { start: 30, end: 40, text: 'b', words: [] },
]

function stubCanvas() {
  const ctx = {
    setTransform: vi.fn(),
    scale: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 300 })
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get: () => 60 })
  return ctx
}

function stubRect() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 300, height: 60, right: 300, bottom: 60, x: 0, y: 0, toJSON: () => ({}),
  })
  ;(HTMLElement.prototype as unknown as Record<string, unknown>).setPointerCapture ??= vi.fn()
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('Waveform', () => {
  it('рисует регионы, пики и курсор', () => {
    const ctx = stubCanvas()
    const { container } = render(
      <Waveform wave={wave} segments={segments} activeSeg={1} time={35} onSeek={() => {}} />,
    )
    expect(container.querySelector('canvas')).not.toBe(null)
    // 2 региона + 4 пика + сыгранная часть + курсор = 8 fillRect
    expect(ctx.fillRect).toHaveBeenCalledTimes(8)
    expect(ctx.clearRect).toHaveBeenCalledTimes(1)
  })

  it('тап стартует с позиции (onTap), без onTap — seek', () => {
    stubCanvas()
    stubRect()
    const onTap = vi.fn()
    const onSeek = vi.fn()
    const { container, rerender } = render(
      <Waveform wave={wave} segments={segments} activeSeg={0} time={0} onSeek={onSeek} onTap={onTap} />,
    )
    const cv = container.querySelector('canvas')!
    fireEvent.pointerDown(cv, { clientX: 150, pointerId: 1 })
    expect(onTap).toHaveBeenCalledWith(50)
    rerender(<Waveform wave={wave} segments={segments} activeSeg={0} time={0} onSeek={onSeek} />)
    fireEvent.pointerDown(cv, { clientX: 60, pointerId: 1 })
    expect(onSeek).toHaveBeenCalledWith(20)
  })

  it('дрожание до 4px — не скраб, дальше — seek; up гасит скраб', () => {
    stubCanvas()
    stubRect()
    const onSeek = vi.fn()
    const onScrub = vi.fn()
    const { container } = render(
      <Waveform wave={wave} segments={segments} activeSeg={0} time={0} onSeek={onSeek} onScrub={onScrub} />,
    )
    const cv = container.querySelector('canvas')!
    fireEvent.pointerDown(cv, { clientX: 100, pointerId: 1 })
    expect(onScrub).toHaveBeenCalledWith(true)
    const seeksAfterDown = onSeek.mock.calls.length
    fireEvent.pointerMove(cv, { clientX: 103 })
    expect(onSeek.mock.calls.length).toBe(seeksAfterDown)
    fireEvent.pointerMove(cv, { clientX: 110 })
    expect(onSeek).toHaveBeenLastCalledWith(110 / 3)
    fireEvent.pointerUp(cv)
    expect(onScrub).toHaveBeenLastCalledWith(false)
  })

  it('пропуски рисуются янтарной подложкой', () => {
    const ctx = stubCanvas()
    render(
      <Waveform
        wave={wave}
        segments={segments}
        activeSeg={0}
        time={0}
        skips={[{ s: 10, e: 20 }]}
        onSeek={() => {}}
      />,
    )
    // 2 региона + 1 пропуск + 4 пика + сыгранная часть + курсор = 9
    expect(ctx.fillRect).toHaveBeenCalledTimes(9)
  })

  it('режим выделения: таскание зовёт onSelectRange, seek не дёргается', () => {
    stubCanvas()
    stubRect()
    const onSelectRange = vi.fn()
    const onSeek = vi.fn()
    const { container } = render(
      <Waveform
        wave={wave}
        segments={segments}
        activeSeg={0}
        time={0}
        selectMode
        onSelectRange={onSelectRange}
        onSeek={onSeek}
        onTap={vi.fn()}
      />,
    )
    const cv = container.querySelector('canvas')!
    fireEvent.pointerDown(cv, { clientX: 30, pointerId: 1 })
    fireEvent.pointerMove(cv, { clientX: 90, pointerId: 1 })
    fireEvent.pointerUp(cv, { clientX: 90, pointerId: 1 })
    // 300px = 100с: 10с -> 30с
    expect(onSelectRange).toHaveBeenCalledWith(10, 30)
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('режим выделения: короткое таскание и отмена — молча', () => {
    stubCanvas()
    stubRect()
    const onSelectRange = vi.fn()
    const { container } = render(
      <Waveform wave={wave} segments={segments} activeSeg={0} time={0} selectMode onSelectRange={onSelectRange} onSeek={() => {}} />,
    )
    const cv = container.querySelector('canvas')!
    fireEvent.pointerDown(cv, { clientX: 30, pointerId: 1 })
    fireEvent.pointerMove(cv, { clientX: 30.5, pointerId: 1 })
    fireEvent.pointerUp(cv, { clientX: 30.5, pointerId: 1 })
    expect(onSelectRange).not.toHaveBeenCalled()
    fireEvent.pointerDown(cv, { clientX: 30, pointerId: 1 })
    fireEvent.pointerCancel(cv)
    expect(onSelectRange).not.toHaveBeenCalled()
  })

  it('disabled игнорирует клики', () => {
    stubCanvas()
    stubRect()
    const onSeek = vi.fn()
    const { container } = render(
      <Waveform wave={wave} segments={segments} activeSeg={0} time={0} onSeek={onSeek} disabled />,
    )
    fireEvent.pointerDown(container.querySelector('canvas')!, { clientX: 150, pointerId: 1 })
    expect(onSeek).not.toHaveBeenCalled()
  })
})
