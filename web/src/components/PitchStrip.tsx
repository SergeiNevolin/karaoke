import { useEffect, useRef } from 'react'
import type { PitchTrack } from '../lib/types'

export interface UserDot {
  t: number
  midi: number
  hit: boolean
}

interface Props {
  pitch: PitchTrack | null
  duration: number
  time: number
  dotsRef: React.MutableRefObject<UserDot[]>
}

/** минималистичная полоса тона: серый эталон + твои ноты */
export default function PitchStrip({ pitch, duration, time, dotsRef }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

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

    const dur = Math.max(1, duration)
    const x = (t: number) => (t / dur) * W
    // диапазон нот эталона
    let lo = 60
    let hi = 72
    if (pitch) {
      const ms = pitch.midi.filter((m): m is number => m !== null)
      if (ms.length) {
        lo = Math.min(...ms) - 2
        hi = Math.max(...ms) + 2
      }
    }
    const y = (m: number) => H - 8 - ((m - lo) / Math.max(1, hi - lo)) * (H - 16)

    // эталон
    if (pitch) {
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      const step = Math.max(1, Math.floor(pitch.t.length / 600))
      for (let i = 0; i < pitch.t.length; i += step) {
        const m = pitch.midi[i]
        if (m === null) continue
        ctx.beginPath()
        ctx.arc(x(pitch.t[i]), y(m), 1.6, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // твои ноты
    for (const d of dotsRef.current) {
      ctx.fillStyle = d.hit ? 'rgba(252,211,77,0.95)' : 'rgba(244,114,182,0.7)'
      ctx.beginPath()
      ctx.arc(x(d.t), y(d.midi), 2.6, 0, Math.PI * 2)
      ctx.fill()
    }

    // курсор
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.fillRect(x(time) - 0.5, 4, 1.5, H - 8)
  }, [pitch, duration, time, dotsRef])

  return (
    <canvas ref={ref} className="h-20 w-full" aria-label="Высота тона" />
  )
}
