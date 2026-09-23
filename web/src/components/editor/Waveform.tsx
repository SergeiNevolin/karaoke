import { useEffect, useRef } from 'react'
import type { Segment, WaveformData } from '../../lib/types'

interface Props {
  wave: WaveformData
  segments: Segment[]
  activeSeg: number
  time: number
  /** false — звук ещё грузится: клики игнорируются */
  disabled?: boolean
  onSeek(t: number): void
  onScrub?(scrubbing: boolean): void
}

/** обзор всего трека: волны вокала + регионы строк, клик — перемотка */
export default function Waveform({ wave, segments, activeSeg, time, disabled, onSeek, onScrub }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const scrub = useRef(false)

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
    ctx.clearRect(0, 0, W, H)

    const dur = Math.max(1, wave.duration)
    const x = (t: number) => (Math.max(0, Math.min(dur, t)) / dur) * W
    const mid = H / 2

    // регионы строк
    segments.forEach((s, i) => {
      ctx.fillStyle = i === activeSeg ? 'rgba(252,211,77,0.16)' : 'rgba(255,255,255,0.045)'
      ctx.fillRect(x(s.start), 0, Math.max(2, x(s.end) - x(s.start)), H)
    })

    // волны
    const n = wave.peaks.length
    const bw = W / n
    ctx.fillStyle = 'rgba(255,255,255,0.38)'
    for (let i = 0; i < n; i++) {
      const h = Math.max(1, wave.peaks[i] * (H - 8))
      const bx = i * bw
      ctx.fillRect(bx, mid - h / 2, Math.max(1, bw - 0.4), h)
    }

    // сыгранная часть
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.fillRect(x(time), 0, W - x(time), H)

    // курсор
    ctx.fillStyle = '#fcd34d'
    ctx.fillRect(x(time) - 1, 0, 2, H)
  }, [wave, segments, activeSeg, time])

  const toTime = (clientX: number) => {
    const cv = ref.current
    if (!cv) return 0
    const r = cv.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    return ratio * Math.max(1, wave.duration)
  }

  const endScrub = () => {
    if (scrub.current) {
      scrub.current = false
      onScrub?.(false)
    }
  }

  return (
    <canvas
      ref={ref}
      className={`h-[72px] w-full touch-none rounded-xl ${disabled ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}
      onPointerDown={(e) => {
        if (disabled) return
        scrub.current = true
        onScrub?.(true)
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        onSeek(toTime(e.clientX))
      }}
      onPointerMove={(e) => {
        if (scrub.current) onSeek(toTime(e.clientX))
      }}
      onPointerUp={endScrub}
      onPointerCancel={endScrub}
    />
  )
}
