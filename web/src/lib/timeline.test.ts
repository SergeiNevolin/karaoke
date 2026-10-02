import { describe, expect, it } from 'vitest'
import {
  LANE_H,
  clampDragDelta,
  hitEdge,
  hitWord,
  laneAtY,
  timeAt,
  xAt,
  type LaneBlock,
} from './timeline'

const blocks = (): LaneBlock[] => [
  { key: 1, active: false, words: [{ s: 10, e: 11 }] },
  { key: 2, active: true, words: [{ s: 14, e: 15 }, { s: 15, e: 16 }] },
  { key: 3, active: false, words: [{ s: 20, e: 21 }] },
]

describe('timeAt / xAt', () => {
  it('края и середина окна в мс', () => {
    expect(timeAt(0, 0, 600, 9, 23)).toBe(9)
    expect(timeAt(600, 0, 600, 9, 23)).toBe(23)
    expect(timeAt(300, 0, 600, 9, 23)).toBe(16)
    expect(timeAt(150, 100, 600, 9, 23)).toBeCloseTo(10.1667, 3)
  })

  it('клики мимо окна clampятся', () => {
    expect(timeAt(-50, 0, 600, 9, 23)).toBe(9)
    expect(timeAt(999, 0, 600, 9, 23)).toBe(23)
  })

  it('xAt — обратное преобразование', () => {
    expect(xAt(9, 9, 23, 600)).toBe(0)
    expect(xAt(23, 9, 23, 600)).toBe(600)
    expect(xAt(16, 9, 23, 600)).toBe(300)
  })
})

describe('laneAtY', () => {
  it('три дорожки по LANE_H, ниже — null', () => {
    expect(laneAtY(0, 0, LANE_H, 3)).toBe(0)
    expect(laneAtY(35, 0, LANE_H, 3)).toBe(0)
    expect(laneAtY(36, 0, LANE_H, 3)).toBe(1)
    expect(laneAtY(100, 0, LANE_H, 3)).toBe(2)
    expect(laneAtY(108, 0, LANE_H, 3)).toBe(null) // волна
    expect(laneAtY(500, 0, LANE_H, 3)).toBe(null)
  })

  it('с учётом сдвига rect и неполных блоков', () => {
    expect(laneAtY(50, 10, LANE_H, 3)).toBe(1)
    expect(laneAtY(10, 0, LANE_H, 1)).toBe(0)
    expect(laneAtY(40, 0, LANE_H, 1)).toBe(null)
  })
})

describe('hitWord', () => {
  it('слово своей дорожки', () => {
    expect(hitWord(blocks(), 1, 15.5)).toEqual({ b: 1, wi: 1 })
    expect(hitWord(blocks(), 0, 10.5)).toEqual({ b: 0, wi: 0 })
  })

  it('чужая дорожка не цепляется', () => {
    expect(hitWord(blocks(), 0, 15.5)).toBe(null)
    expect(hitWord(blocks(), 2, 15.5)).toBe(null)
  })

  it('мимо слов и мимо блоков — null', () => {
    expect(hitWord(blocks(), 1, 17)).toBe(null)
    expect(hitWord(blocks(), 5, 15.5)).toBe(null)
  })
})

describe('hitEdge', () => {
  // окно [9,23] на 600px: 10px = 0.233с
  it('начала и концы в пороге', () => {
    expect(hitEdge(blocks(), 1, 14.1, 9, 23, 600)).toEqual({ b: 1, wi: 0, edge: 's' })
    expect(hitEdge(blocks(), 1, 15.9, 9, 23, 600)).toEqual({ b: 1, wi: 1, edge: 'e' })
  })

  it('дальше порога — null, чужая дорожка — null', () => {
    expect(hitEdge(blocks(), 1, 14.5, 9, 23, 600)).toBe(null)
    expect(hitEdge(blocks(), 0, 14.1, 9, 23, 600)).toBe(null)
  })
})

describe('clampDragDelta', () => {
  it('внутри — как есть, в мс', () => {
    expect(clampDragDelta(0.1234, -1, 1)).toBe(0.123)
    expect(clampDragDelta(-0.5, -1, 1)).toBe(-0.5)
  })

  it('режем по границам', () => {
    expect(clampDragDelta(5, -1, 2)).toBe(2)
    expect(clampDragDelta(-5, -1, 2)).toBe(-1)
  })

  it('пустой интервал — стоим', () => {
    expect(clampDragDelta(1, 2, 1)).toBe(0)
  })
})
