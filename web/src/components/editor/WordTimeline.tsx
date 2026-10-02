import { useEffect, useRef, useState } from 'react'
import { clampDragDelta, hitEdge, hitWord, LANE_H, laneAtY, timeAt } from '../../lib/timeline'
import { cssVar, hexRgba } from '../../lib/theme'
import type { WaveformData, Word } from '../../lib/types'

export interface TimelineBlock {
  key: number
  words: Word[]
  active: boolean
  start: number
  end: number
}

interface Props {
  wave: WaveformData
  /** строки в окне: соседние видны приглушёнными, активная ярко */
  blocks: TimelineBlock[]
  time: number
  selected: { key: number; wi: number } | null
  /** индекс слова, которое ждёт тап (подсветка) */
  tapPos: { key: number; wi: number } | null
  pad: number
  /** магнит: притянуть границу к началу звука; null — выключен */
  snapT: ((t: number) => number) | null
  onSelectWord(key: number, wi: number): void
  onChangeWords(key: number, lineStart: number, lineEnd: number, words: Word[]): void
  onSeek(t: number): void
  onPreview(key: number, wi: number): void
  onScrub?(scrubbing: boolean): void
}

const EDGE_PX = 10
// геометрия: 3 дорожки строк (прошлая/текущая/следующая) НАД волной
const WAVE_Y = LANE_H * 3 + 4
const WAVE_H = 40

interface Flat {
  b: number
  wi: number
  w: Word
}

/** лента расстановки: текущая строка ярко + соседи приглушённо, всё таскается */
export default function WordTimeline({
  wave, blocks, time, selected, tapPos, pad, snapT,
  onSelectWord, onChangeWords, onSeek, onPreview, onScrub,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ b: number; wi: number; edge: 's' | 'e' } | null>(null)
  /** нажатие до решения «клик / таскание слова / таскание строки» */
  const press = useRef<{
    x: number; t: number
    hit: { b: number; wi: number } | null
    /** строка для двигания целиком (пустое место или Shift+слово) */
    lineB: number | null
  } | null>(null)
  /** активное таскание строки целиком */
  const lineBody = useRef<{
    b: number
    s0: number[]; e0: number[]
    ls0: number; le0: number
    startT: number; minD: number; maxD: number
  } | null>(null)
  /** активное таскание слов (одного или Ctrl-группы): общий сдвиг в пересечении допусков */
  const body = useRef<{
    items: { b: number; wi: number; s0: number; e0: number; minD: number; maxD: number }[]
    startT: number
  } | null>(null)
  /** мультивыбор для группового двигания: «key:wi» */
  const [multi, setMulti] = useState<Set<string>>(() => new Set())
  // перерисовка при смене темы/акцента (событие из lib/theme)
  const [, setThemeTick] = useState(0)
  useEffect(() => {
    const onTheme = () => setThemeTick((t) => t + 1)
    window.addEventListener('karaoke:theme', onTheme)
    return () => window.removeEventListener('karaoke:theme', onTheme)
  }, [])
  const mkKey = (key: number, wi: number): string => `${key}:${wi}`
  // строка сменилась — групповое выделение сбрасываем
  const activeKey = blocks.find((b) => b.active)?.key
  useEffect(() => {
    setMulti(new Set())
  }, [activeKey])

  const starts = blocks.map((b) => b.start)
  const ends = blocks.map((b) => b.end)
  const t0 = blocks.length ? Math.max(0, Math.min(...starts) - pad) : 0
  const t1 = blocks.length ? Math.max(...ends) + pad : 1

  // плоский список для хит-тестов: сначала активный блок
  const order = [...blocks.keys()].sort((a, b) => Number(blocks[b].active) - Number(blocks[a].active))
  const flat: Flat[] = []
  order.forEach((b) => {
    blocks[b].words.forEach((w, wi) => flat.push({ b, wi, w }))
  })

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const W = cv.clientWidth
    const H = cv.clientHeight
    cv.width = W * dpr
    cv.height = H * dpr
    ctx.scale(dpr, dpr)

    const X = (t: number) => ((t - t0) / Math.max(0.01, t1 - t0)) * W
    // цвета темы (читаем на каждый кадр — тема может смениться)
    const HL = cssVar('--color-highlight')
    const TX = cssVar('--color-text')

    // активная дорожка подсвечена (шахматка строк)
    blocks.forEach((blk, li) => {
      if (!blk.active) return
      ctx.fillStyle = hexRgba(HL, 0.06)
      ctx.fillRect(0, li * LANE_H, W, LANE_H)
    })

    // волны — отдельной полосой НИЖЕ слов, слова её не перекрывают
    const dur = Math.max(1, wave.duration)
    const waveMid = WAVE_Y + WAVE_H / 2
    ctx.fillStyle = hexRgba(TX, 0.28)
    const step = Math.max(1, Math.floor(W / 220))
    for (let px = 0; px < W; px += step) {
      const t = t0 + (px / W) * (t1 - t0)
      const pi = Math.max(0, Math.min(wave.peaks.length - 1, Math.floor((t / dur) * wave.peaks.length)))
      const h = Math.max(1, wave.peaks[pi] * (WAVE_H - 6))
      ctx.fillRect(px, waveMid - h / 2, step - 0.5, h)
    }

    // блоки слов: сначала приглушённые соседи, активные поверх
    ctx.font = '11px Inter, system-ui, sans-serif'
    for (const f of flat) {
      const blk = blocks[f.b]
      const laneY = f.b * LANE_H
      const w = f.w
      const x1 = X(w.s)
      const x2 = X(w.e)
      const sung = time >= w.e
      const active = time >= w.s && time <= w.e
      const isSel = selected !== null && selected.key === blk.key && selected.wi === f.wi
      const isTap = tapPos !== null && tapPos.key === blk.key && tapPos.wi === f.wi
      const isMulti = multi.has(mkKey(blk.key, f.wi))
      ctx.globalAlpha = blk.active ? 1 : 0.45
      ctx.fillStyle = isTap
        ? hexRgba(HL, 0.30)
        : active
          ? hexRgba(HL, 0.22)
          : sung
            ? hexRgba(TX, 0.10)
            : hexRgba(TX, 0.05)
      const bw = Math.max(3, x2 - x1)
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath()
        ctx.roundRect(x1, laneY + 3, bw, 22, 6)
        ctx.fill()
      } else {
        ctx.fillRect(x1, laneY + 3, bw, 22)
      }
      if (isSel || isTap || isMulti) {
        ctx.strokeStyle = HL
        ctx.lineWidth = isTap ? 2 : 1.5
        ctx.stroke()
      }
      // подпись
      ctx.fillStyle = sung || active || isTap || isMulti ? HL : TX
      const label = w.w.length * 6.6 > bw - 6 ? w.w.slice(0, Math.max(1, Math.floor((bw - 6) / 6.6))) : w.w
      ctx.fillText(label, x1 + 5, laneY + 18)
      // время
      ctx.fillStyle = hexRgba(TX, 0.35)
      ctx.font = '9px Inter, system-ui, sans-serif'
      ctx.fillText(`${w.s.toFixed(2)}`, x1 + 5, laneY + 32)
      ctx.font = '11px Inter, system-ui, sans-serif'
      // ручки краёв
      ctx.fillStyle = isSel ? HL : hexRgba(TX, 0.35)
      ctx.fillRect(x1 - 1.5, laneY + 3, 3, 22)
      ctx.fillRect(x2 - 1.5, laneY + 3, 3, 22)
      ctx.globalAlpha = 1
    }

    // курсор на всю высоту
    if (time >= t0 && time <= t1) {
      ctx.fillStyle = TX
      ctx.fillRect(X(time) - 0.75, 0, 1.5, H)
    }

    // линейка времени
    const span = t1 - t0
    const labelStep = span > 14 ? 2 : 1
    ctx.font = '9px Inter, system-ui, sans-serif'
    for (let tt = Math.floor(t0 * 2) / 2; tt <= t1 + 1e-6; tt += 0.5) {
      const xx = X(tt)
      const isSec = Math.abs(tt - Math.round(tt)) < 1e-6
      ctx.fillStyle = hexRgba(TX, 0.4)
      ctx.fillRect(xx, H - 6, 1, isSec ? 6 : 3)
      if (isSec && Math.round(tt) % labelStep === 0) {
        ctx.fillStyle = hexRgba(TX, 0.45)
        ctx.fillText(`${Math.round(tt)}с`, xx + 3, H - 9)
      }
    }
  })

  /** ширина окна в CSS-пикселях (в тестах clientWidth=0 — берём из rect) */
  const viewW = (): number => {
    const cv = ref.current
    if (!cv) return 0
    return cv.clientWidth || cv.getBoundingClientRect().width
  }

  const toTime = (clientX: number) => {
    const cv = ref.current
    if (!cv) return t0
    const r = cv.getBoundingClientRect()
    return timeAt(clientX, r.left, r.width, t0, t1)
  }

  /** дорожка под пальцем (индекс блока) или null — ниже слов (волна/пустое) */
  const laneAt = (clientY: number): number | null => {
    const cv = ref.current
    if (!cv) return null
    return laneAtY(clientY, cv.getBoundingClientRect().top, LANE_H, blocks.length)
  }

  const edgeAt = (clientX: number, clientY: number): { b: number; wi: number; edge: 's' | 'e' } | null => {
    const lane = laneAt(clientY)
    if (lane === null) return null
    return hitEdge(blocks, lane, toTime(clientX), t0, t1, viewW(), EDGE_PX)
  }

  const wordAt = (clientX: number, clientY: number): { b: number; wi: number } | null => {
    const lane = laneAt(clientY)
    if (lane === null) return null
    return hitWord(blocks, lane, toTime(clientX))
  }

  /** старт сдвига строки: снепшот слов и границ, упоры в окно и соседей */
  const startLineDrag = (b: number, startT: number): boolean => {
    const blk = blocks[b]
    if (!blk) return false
    const prevEnd = b > 0 ? blocks[b - 1].end : t0
    const nextStart = b < blocks.length - 1 ? blocks[b + 1].start : t1
    lineBody.current = {
      b,
      s0: blk.words.map((w) => w.s),
      e0: blk.words.map((w) => w.e),
      ls0: blk.start,
      le0: blk.end,
      startT,
      minD: Math.max(t0 - blk.start, prevEnd - blk.start),
      maxD: Math.min(t1 - blk.end, nextStart - blk.end),
    }
    return true
  }

  /** применить сдвиг строки: всё едет жёстко, магнит тянет за первое слово */
  const applyLineDrag = (rawT: number): void => {
    const lb = lineBody.current
    if (!lb) return
    const blk = blocks[lb.b]
    if (!blk) return
    let delta = rawT - lb.startT
    if (snapT && lb.s0.length > 0) delta = snapT(lb.s0[0] + delta) - lb.s0[0]
    const d = clampDragDelta(delta, lb.minD, lb.maxD)
    if (d === 0) return
    const r3 = (v: number) => Math.round(v * 1000) / 1000
    const ws = blk.words.map((w) => ({ ...w }))
    lb.s0.forEach((s, i) => {
      const cur = ws[i]
      const e = lb.e0[i]
      if (cur && e !== undefined) {
        cur.s = r3(s + d)
        cur.e = r3(e + d)
      }
    })
    onChangeWords(blk.key, r3(lb.ls0 + d), r3(lb.le0 + d), ws)
  }

  /** старт таскания: группа = multi (если первичное внутри), иначе одно слово */
  const startBodyDrag = (hit: { b: number; wi: number }, startT: number): boolean => {
    const pblk = blocks[hit.b]
    const pw = pblk?.words[hit.wi]
    if (!pblk || !pw) return false
    const pk = mkKey(pblk.key, hit.wi)
    const ordered = multi.has(pk) && multi.size > 0
      ? [pk, ...[...multi].filter((g) => g !== pk)]
      : [pk]
    const items: { b: number; wi: number; s0: number; e0: number; minD: number; maxD: number }[] = []
    for (const gk of ordered) {
      const sep = gk.lastIndexOf(':')
      const gkey = Number(gk.slice(0, sep))
      const gwi = Number(gk.slice(sep + 1))
      const b = blocks.findIndex((bl) => bl.key === gkey)
      const w = b >= 0 ? blocks[b].words[gwi] : undefined
      if (b < 0 || !w) continue
      const ws = blocks[b].words
      const prevE = gwi > 0 ? ws[gwi - 1].e : t0
      const nextS = gwi < ws.length - 1 ? ws[gwi + 1].s : t1
      items.push({
        b, wi: gwi, s0: w.s, e0: w.e,
        minD: Math.max(prevE - w.s, t0 - w.s),
        maxD: Math.min(nextS - w.e, t1 - w.e),
      })
    }
    if (items.length === 0) return false
    body.current = { items, startT }
    return true
  }

  /** применить сдвиг группы: общий дельта в пересечении допусков, магнит тянет за начало */
  const applyBodyDrag = (rawT: number): void => {
    const bd = body.current
    if (!bd || bd.items.length === 0) return
    const lead = bd.items[0]
    let delta = rawT - bd.startT
    if (snapT) delta = snapT(lead.s0 + delta) - lead.s0
    let dMin = -Infinity
    let dMax = Infinity
    for (const it of bd.items) {
      dMin = Math.max(dMin, it.minD)
      dMax = Math.min(dMax, it.maxD)
    }
    if (!(dMin <= dMax)) return // двигать некуда — стоим
    const r3 = (v: number) => Math.round(v * 1000) / 1000
    const d = r3(Math.min(dMax, Math.max(dMin, delta)))
    if (d === 0) return
    const byBlock = new Map<number, Map<number, Word>>()
    for (const it of bd.items) {
      const base = blocks[it.b].words[it.wi]
      if (!base) continue
      if (!byBlock.has(it.b)) byBlock.set(it.b, new Map())
      byBlock.get(it.b)?.set(it.wi, { ...base, s: r3(it.s0 + d), e: r3(it.e0 + d) })
    }
    byBlock.forEach((list, b) => {
      const ws = blocks[b].words.map((w) => ({ ...w }))
      list.forEach((w, wi) => {
        ws[wi] = w
      })
      commit(b, ws)
    })
  }

  const commit = (b: number, ws: Word[]) => {
    const blk = blocks[b]
    if (!blk) return
    const r3 = (v: number) => Math.round(v * 1000) / 1000
    const fixed = ws.map((w) => ({ ...w, s: r3(w.s), e: r3(w.e) }))
    const ls = Math.min(blk.start, fixed[0]?.s ?? blk.start)
    const le = Math.max(blk.end, fixed[fixed.length - 1]?.e ?? blk.end)
    onChangeWords(blk.key, r3(ls), r3(le), fixed)
  }

  return (
    <canvas
      ref={ref}
      className="h-[168px] w-full cursor-crosshair touch-none rounded-xl bg-surface-hover"
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        onScrub?.(true)
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        const edge = edgeAt(e.clientX, e.clientY)
        if (edge) {
          drag.current = edge
          const blk = blocks[edge.b]
          // край тянем молча: переселект перецентровал бы ленту и угнал блок из-под пальца.
          // Слово выбираем только в активной строке (там перецентровки нет).
          if (blk && blk.active) onSelectWord(blk.key, edge.wi)
          return
        }
        const hit = wordAt(e.clientX, e.clientY)
        if (hit) {
          const blk = blocks[hit.b]
          const w = blk?.words[hit.wi]
          if (blk && w && (e.ctrlKey || e.metaKey)) {
            // Ctrl+клик: выделить/снять слово, без выбора, игры и перемотки
            const k = mkKey(blk.key, hit.wi)
            setMulti((prev) => {
              const next = new Set(prev)
              if (next.has(k)) next.delete(k)
              else next.add(k)
              return next
            })
            press.current = null
            return
          }
          if (blk && w && e.shiftKey) {
            // Shift+слово — двигать всю строку
            press.current = { x: e.clientX, t: toTime(e.clientX), hit, lineB: hit.b }
            return
          }
          // слово: выбор — только по клику (молча), таскание — по движению
          press.current = { x: e.clientX, t: toTime(e.clientX), hit, lineB: null }
          return
        }
        const lane = laneAt(e.clientY)
        if (lane !== null) {
          // пустое место дорожки — двигать строку; клик без движения — играть
          press.current = { x: e.clientX, t: toTime(e.clientX), hit: null, lineB: lane }
          return
        }
        press.current = null
        // ниже слов (волна/пустое) — играть с позиции
        onSeek(toTime(e.clientX))
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d) {
          const blk = blocks[d.b]
          if (!blk) return
          const t = toTime(e.clientX)
          const ws = blk.words.map((w) => ({ ...w }))
          const prevE = d.wi > 0 ? ws[d.wi - 1].e : t0
          const nextS = d.wi < ws.length - 1 ? ws[d.wi + 1].s : t1
          const snapped = snapT ? snapT(t) : t
          if (d.edge === 's') {
            ws[d.wi].s = Math.max(prevE, Math.min(snapped, ws[d.wi].e - 0.06))
          } else {
            ws[d.wi].e = Math.min(nextS, Math.max(snapped, ws[d.wi].s + 0.06))
          }
          commit(d.b, ws)
          return
        }
        const p = press.current
        if (p) {
          // порог 4px: дрожание — ещё клик, дальше — таскание
          if (Math.abs(e.clientX - p.x) <= 4) return
          const movedT = toTime(e.clientX)
          press.current = null
          if (p.lineB !== null) {
            if (startLineDrag(p.lineB, p.t)) {
              ;(e.target as HTMLElement).style.cursor = 'move'
              applyLineDrag(movedT)
            }
            return
          }
          if (p.hit && startBodyDrag(p.hit, p.t)) {
            ;(e.target as HTMLElement).style.cursor = 'grabbing'
            // применяем сразу, иначе одиночный сдвиг потеряется
            applyBodyDrag(movedT)
            return
          }
        }
        if (lineBody.current) {
          applyLineDrag(toTime(e.clientX))
          return
        }
        if (body.current) {
          applyBodyDrag(toTime(e.clientX))
          return
        }
        if (!drag.current) {
          const inWords = laneAt(e.clientY) !== null
          const hot = inWords && edgeAt(e.clientX, e.clientY) !== null
          const hov = inWords && !hot && wordAt(e.clientX, e.clientY) !== null
          ;(e.target as HTMLElement).style.cursor = hot ? 'ew-resize' : hov ? 'grab' : 'crosshair'
        }
      }}
      onPointerUp={(e) => {
        const wasBody = body.current !== null
        const wasLine = lineBody.current !== null
        const p = press.current
        drag.current = null
        body.current = null
        lineBody.current = null
        press.current = null
        ;(e.target as HTMLElement).style.cursor = 'crosshair'
        onScrub?.(false)
        if (wasBody || wasLine || !p) return // двигали — без выбора и игры
        if (p.hit) {
          // клик по слову: выбрать молча (перемотки и игры нет — они только ниже слов)
          const blk = blocks[p.hit.b]
          const w = blk?.words[p.hit.wi]
          if (!blk || !w) return
          setMulti(new Set([mkKey(blk.key, p.hit.wi)]))
          onSelectWord(blk.key, p.hit.wi)
        } else if (p.lineB !== null) {
          // клик по пустому месту дорожки — играть с позиции
          onSeek(toTime(e.clientX))
        }
      }}
      onPointerCancel={() => {
        drag.current = null
        body.current = null
        lineBody.current = null
        press.current = null
        onScrub?.(false)
      }}
      onDoubleClick={(e) => {
        const hit = wordAt(e.clientX, e.clientY)
        if (hit) {
          const blk = blocks[hit.b]
          if (blk) {
            onSelectWord(blk.key, hit.wi)
            onPreview(blk.key, hit.wi)
          }
        }
      }}
    />
  )
}
