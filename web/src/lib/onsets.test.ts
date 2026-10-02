import { describe, expect, it } from 'vitest'
import { computeOnsets, snapToOnset } from './onsets'

describe('computeOnsets', () => {
  it('находит резкие атаки и игнорит тишину', () => {
    // тишина, внезапный всплеск, спад, второй всплеск
    const peaks = [0.01, 0.02, 0.01, 0.5, 0.55, 0.4, 0.1, 0.05, 0.6, 0.5]
    const on = computeOnsets(peaks, 10)
    expect(on.length).toBeGreaterThanOrEqual(2)
    // первый онсет около 3с (индекс 3 * 1с)
    expect(on[0]).toBeGreaterThanOrEqual(2)
    expect(on[0]).toBeLessThanOrEqual(4)
  })

  it('пустой вход — пустой выход', () => {
    expect(computeOnsets([], 10)).toEqual([])
    expect(computeOnsets([0, 0, 0], 0)).toEqual([])
  })

  it('не дублирует близкие срабатывания', () => {
    const tail = new Array(16).fill(0.05)
    const peaks = [0.05, 0.5, 0.55, 0.5, ...tail]
    const on = computeOnsets(peaks, 2)
    expect(on.length).toBe(1)
  })
})

describe('snapToOnset', () => {  it('тянет к ближайшему в окне', () => {
    expect(snapToOnset(10.1, [9.0, 10.0, 12.0])).toBe(10.0)
  })

  it('вне окна — оставляет как было', () => {
    expect(snapToOnset(10.5, [9.0, 12.0])).toBe(10.5)
  })

  it('без онсетов — как было', () => {
    expect(snapToOnset(5, [])).toBe(5)
  })

  it('мс: результат округлён до тысячных', () => {
    expect(snapToOnset(10.12344, [10.12346])).toBe(10.123)
    expect(snapToOnset(10.12346, [10.12344], 0.01)).toBe(10.123)
  })

  it('мс: времена онсетов — в тысячных', () => {
    const on = computeOnsets([0.01, 0.5, 0.55, 0.4, 0.1, 0.05, 0.6, 0.5], 10)
    expect(on.length).toBeGreaterThan(0)
    for (const t of on) expect(t).toBe(Math.round(t * 1000) / 1000)
  })
})
