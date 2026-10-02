// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PitchStrip from './PitchStrip'

const calls: Record<string, number> = {}

function stubCanvas() {
  const bump = (k: string) => calls[k] = (calls[k] ?? 0) + 1
  const ctx = {
    setTransform: vi.fn(() => bump('setTransform')),
    clearRect: vi.fn(() => bump('clearRect')),
    fillRect: vi.fn(() => bump('fillRect')),
    fillText: vi.fn(() => bump('fillText')),
    beginPath: vi.fn(() => bump('beginPath')),
    arc: vi.fn(() => bump('arc')),
    fill: vi.fn(() => bump('fill')),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 300 })
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get: () => 176 })
  return ctx
}

beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k]
  vi.restoreAllMocks()
})

const pitch = { t: [1, 2, 3], midi: [60, 62, null] as (number | null)[] }
const dots = (ds: { t: number; midi: number; hit: boolean; perfect: boolean }[]) => ({ current: ds })

describe('PitchStrip', () => {
  it('рисует сетку и бруски эталона', () => {
    stubCanvas()
    render(<PitchStrip pitch={pitch} duration={200} time={5} dotsRef={dots([])} />)
    expect(calls['clearRect']).toBeGreaterThan(0)
    expect(calls['fillRect']).toBeGreaterThan(0) // сетка + бруски + курсор
    expect(calls['fillText']).toBeGreaterThan(0) // имена нот C
  })

  it('рисует точки пользователя в окне', () => {
    stubCanvas()
    render(
      <PitchStrip
        pitch={pitch}
        duration={200}
        time={5}
        dotsRef={dots([{ t: 2, midi: 62, hit: true, perfect: false }])}
      />,
    )
    expect(calls['arc']).toBe(1)
  })

  it('точки вне окна не рисует, пустой питч не роняет', () => {
    stubCanvas()
    const { rerender } = render(
      <PitchStrip
        pitch={pitch}
        duration={200}
        time={5}
        dotsRef={dots([{ t: 150, midi: 62, hit: true, perfect: false }])}
      />,
    )
    expect(calls['arc'] ?? 0).toBe(0)
    rerender(<PitchStrip pitch={null} duration={200} time={5} dotsRef={dots([])} />)
  })
})
