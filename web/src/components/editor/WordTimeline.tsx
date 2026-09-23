import { useEffect, useRef } from 'react'
import type { Segment, WaveformData, Word } from '../../lib/types'

interface Props {
  wave: WaveformData
  line: Segment
  time: number
  selected: number | null
  /** индекс слова, которое ждёт тап (подсветка) */
  tapIndex: number | null
  pad: number
  /** магнит: притянуть границу к началу звука; null — выключен */
  snapT: ((t: number) => number) | null
  onSelectWord(i: number): void
  onChange(lineStart: number, lineEnd: number, words: Word[]): void
  onSeek(t: number): void
  onPreview(i: number): void
  onScrub?(scrubbing: boolean): void
}

const EDGE_PX = 10

/** детальный таймлайн строки: слова таскаются за края, даблклик — прослушать */
export default function WordTimeline({
  wave, line, time, selected, tapIndex, pad, snapT,
  onSelectWord, onChange, onSeek, onPreview, onScrub,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ wi: number; edge: 's' | 'e' } | null>(null)
  const geom = useRef({ t0: 0, t1: 1, W: 0 })

  const words = line.words
  const t0 = Math.max(0, line.start - pad)
  const t1 = line.end + pad

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
    geom.current = { t0, t1, W }

    const X = (t: number) => ((t - t0) / Math.max(0.01, t1 - t0)) * W
    const mid = 44

    // волны в окне
    const dur = Math.max(1, wave.duration)
    ctx.fillStyle = 'rgba(255,255,255,0.30)'
    const step = Math.max(1, Math.floor(W / 220))
    for (let px = 0; px < W; px += step) {
      const t = t0 + (px / W) * (t1 - t0)
      const pi = Math.max(0, Math.min(wave.peaks.length - 1, Math.floor((t / dur) * wave.peaks.length)))
      const h = Math.max(1, wave.peaks[pi] * 56)
      ctx.fillRect(px, mid - h / 2, step - 0.5, h)
    }

    // блоки слов
    ctx.font = '11px Inter, system-ui, sans-serif'
    words.forEach((w, i) => {
      const x1 = X(w.s)
      const x2 = X(w.e)
      const sung = time >= w.e
      const active = time >= w.s && time <= w.e
      const isSel = i === selected
      const isTap = i === tapIndex
      ctx.fillStyle = isTap
        ? 'rgba(252,211,77,0.30)'
        : active
          ? 'rgba(252,211,77,0.22)'
          : sung
            ? 'rgba(255,255,255,0.10)'
            : 'rgba(255,255,255,0.05)'
      const bw = Math.max(3, x2 - x1)
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath()
        ctx.roundRect(x1, 8, bw, 30, 6)
        ctx.fill()
      } else {
        ctx.fillRect(x1, 8, bw, 30)
      }
      if (isSel || isTap) {
        ctx.strokeStyle = '#fcd34d'
        ctx.lineWidth = isTap ? 2 : 1.5
        ctx.stroke()
      }
      // подпись
      ctx.fillStyle = sung || active || isTap ? '#fcd34d' : '#d4d4d8'
      const label = w.w.length * 6.6 > bw - 6 ? w.w.slice(0, Math.max(1, Math.floor((bw - 6) / 6.6))) : w.w
      ctx.fillText(label, x1 + 5, 27)
      // время
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.font = '9px Inter, system-ui, sans-serif'
      ctx.fillText(`${w.s.toFixed(1)}`, x1 + 5, 62)
      ctx.font = '11px Inter, system-ui, sans-serif'
      // ручки краёв
      ctx.fillStyle = isSel ? '#fcd34d' : 'rgba(255,255,255,0.35)'
      ctx.fillRect(x1 - 1.5, 8, 3, 30)
      ctx.fillRect(x2 - 1.5, 8, 3, 30)
    })

    // курсор
    if (time >= t0 && time <= t1) {
      ctx.fillStyle = '#fafafa'
      ctx.fillRect(X(time) - 0.75, 0, 1.5, H)
    }

    // линейка времени
    const span = t1 - t0
    const labelStep = span > 14 ? 2 : 1
    ctx.font = '9px Inter, system-ui, sans-serif'
    for (let tt = Math.floor(t0 * 2) / 2; tt <= t1 + 1e-6; tt += 0.5) {
      const xx = X(tt)
      const isSec = Math.abs(tt - Math.round(tt)) < 1e-6
      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      ctx.fillRect(xx, H - 6, 1, isSec ? 6 : 3)
      if (isSec && Math.round(tt) % labelStep === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.45)'
        ctx.fillText(`${Math.round(tt)}с`, xx + 3, H - 9)
      }
    }
  })

  const toTime = (clientX: number) => {
    const cv = ref.current
    if (!cv) return 0
    const r = cv.getBoundingClientRect()
    const { t0: a, t1: b } = geom.current
    return a + (Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (b - a))
  }

  const edgeAt = (clientX: number): { wi: number; edge: 's' | 'e' } | null => {
    const cv = ref.current
    if (!cv) return null
    const r = cv.getBoundingClientRect()
    const { t0: a, t1: b, W } = geom.current
    const X = (t: number) => ((t - a) / Math.max(0.01, b - a)) * W
    const px = clientX - r.left
    for (let i = 0; i < words.length; i++) {
      if (Math.abs(px - X(words[i].s)) <= EDGE_PX) return { wi: i, edge: 's' }
      if (Math.abs(px - X(words[i].e)) <= EDGE_PX) return { wi: i, edge: 'e' }
    }
    return null
  }

  const wordAt = (clientX: number): number | null => {
    const t = toTime(clientX)
    for (let i = 0; i < words.length; i++) {
      if (t >= words[i].s - 0.05 && t <= words[i].e + 0.05) return i
    }
    return null
  }

  const commit = (ws: Word[]) => {
    const r2 = (v: number) => Math.round(v * 100) / 100
    const fixed = ws.map((w) => ({ ...w, s: r2(w.s), e: r2(w.e) }))
    const ls = Math.min(line.start, fixed[0]?.s ?? line.start)
    const le = Math.max(line.end, fixed[fixed.length - 1]?.e ?? line.end)
    onChange(r2(ls), r2(le), fixed)
  }

  return (
    <canvas
      ref={ref}
      className="h-[92px] w-full cursor-crosshair touch-none rounded-xl bg-white/[0.02]"
      onPointerDown={(e) => {
        onScrub?.(true)
        const edge = edgeAt(e.clientX)
        if (edge) {
          drag.current = edge
          onSelectWord(edge.wi)
          ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        } else {
          const wi = wordAt(e.clientX)
          if (wi !== null) onSelectWord(wi)
          onSeek(toTime(e.clientX))
        }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) {
          const hot = edgeAt(e.clientX) !== null
          ;(e.target as HTMLElement).style.cursor = hot ? 'ew-resize' : 'crosshair'
          return
        }
        const t = toTime(e.clientX)
        const ws = words.map((w) => ({ ...w }))
        const prevE = d.wi > 0 ? ws[d.wi - 1].e : t0
        const nextS = d.wi < ws.length - 1 ? ws[d.wi + 1].s : t1
        const snapped = snapT ? snapT(t) : t
        if (d.edge === 's') {
          ws[d.wi].s = Math.max(prevE, Math.min(snapped, ws[d.wi].e - 0.06))
        } else {
          ws[d.wi].e = Math.min(nextS, Math.max(snapped, ws[d.wi].s + 0.06))
        }
        commit(ws)
      }}
      onPointerUp={() => {
        drag.current = null
        onScrub?.(false)
      }}
      onPointerCancel={() => {
        drag.current = null
        onScrub?.(false)
      }}
      onDoubleClick={(e) => {
        const wi = wordAt(e.clientX)
        if (wi !== null) {
          onSelectWord(wi)
          onPreview(wi)
        }
      }}
    />
  )
}
