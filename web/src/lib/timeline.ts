/**
 * Чистая геометрия ленты слов (без React/DOM): время <-> пиксели,
 * дорожки, попадания в слова и края. WordTimeline — тонкая обёртка.
 */

/** высота дорожки строки в ленте (прошлая/текущая/следующая) */
export const LANE_H = 36
/** допуск попадания в слово по времени (сек) */
export const HIT_EPS = 0.05

export interface LaneWord {
  s: number
  e: number
}

export interface LaneBlock {
  key: number
  words: LaneWord[]
  active: boolean
}

/** x (клиентская) -> время окна */
export function timeAt(clientX: number, rectLeft: number, rectWidth: number, t0: number, t1: number): number {
  if (!(rectWidth > 0)) return t0
  return t0 + Math.max(0, Math.min(1, (clientX - rectLeft) / rectWidth)) * (t1 - t0)
}

/** время -> x в пикселях окна */
export function xAt(t: number, t0: number, t1: number, viewW: number): number {
  return ((t - t0) / Math.max(0.01, t1 - t0)) * viewW
}

/** дорожка (индекс блока) под пальцем или null — ниже слов (волна/пустое) */
export function laneAtY(clientY: number, rectTop: number, laneH: number, blockCount: number): number | null {
  const li = Math.floor((clientY - rectTop) / laneH)
  return li >= 0 && li < blockCount ? li : null
}

/** слово дорожки, содержащее момент t (с допуском) */
export function hitWord(
  blocks: LaneBlock[],
  lane: number,
  t: number,
  eps = HIT_EPS,
): { b: number; wi: number } | null {
  const blk = blocks[lane]
  if (!blk) return null
  for (let wi = 0; wi < blk.words.length; wi++) {
    const w = blk.words[wi]
    if (t >= w.s - eps && t <= w.e + eps) return { b: lane, wi }
  }
  return null
}

/** край слова рядом с моментом t (порог в пикселях пересчитываем во время) */
export function hitEdge(
  blocks: LaneBlock[],
  lane: number,
  t: number,
  t0: number,
  t1: number,
  viewW: number,
  edgePx = 10,
): { b: number; wi: number; edge: 's' | 'e' } | null {
  const blk = blocks[lane]
  if (!blk || !(viewW > 0)) return null
  const tol = (edgePx / viewW) * Math.max(0.01, t1 - t0)
  for (let wi = 0; wi < blk.words.length; wi++) {
    const w = blk.words[wi]
    if (Math.abs(t - w.s) <= tol) return { b: lane, wi, edge: 's' }
    if (Math.abs(t - w.e) <= tol) return { b: lane, wi, edge: 'e' }
  }
  return null
}

/** сдвиг слова в допустимых границах, в мс */
export function clampDragDelta(delta: number, minD: number, maxD: number): number {
  if (!(minD <= maxD)) return 0
  return Math.round(Math.min(maxD, Math.max(minD, delta)) * 1000) / 1000
}
