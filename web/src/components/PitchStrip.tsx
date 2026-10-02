import { useEffect, useMemo, useRef, useState } from 'react'
import { cssVar, hexRgba } from '../lib/theme'
import type { PitchTrack, SkipRange } from '../lib/types'
import { midiName, sliceWindow, visibleRange, windowForTime } from '../lib/pitch'
import { inSkip } from '../lib/songs'

export interface UserDot {
  t: number
  midi: number
  hit: boolean
  perfect: boolean
}

interface Props {
  pitch: PitchTrack | null
  duration: number
  time: number
  dotsRef: React.MutableRefObject<UserDot[]>
  /** пропуски «не поём» — эталон там бледный */
  skips?: SkipRange[]
}

const GUTTER = 44

/** полоса тона как в настоящем караоке: скролл-окно за курсором,
 *  сетка полутонов с именами, эталон брусками, твои ноты точками,
 *  живой детюн в центах */
export default function PitchStrip({ pitch, duration, time, dotsRef, skips }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  // Y-шкала фиксирована на весь трек: высота не дышит при скролле окна
  const fullRange = useMemo(
    () => visibleRange(pitch, 0, Number.isFinite(duration) ? duration : 0) ?? { lo: 58, hi: 74 },
    [pitch, duration],
  )
  // кэш размера: реаллокация canvas только при смене геометрии, а не каждый кадр
  const sizeRef = useRef({ w: 0, h: 0, dpr: 0 })
  // перерисовка при смене темы/акцента (событие из lib/theme)
  const [themeTick, setThemeTick] = useState(0)
  useEffect(() => {
    const onTheme = () => setThemeTick((t) => t + 1)
    window.addEventListener('karaoke:theme', onTheme)
    return () => window.removeEventListener('karaoke:theme', onTheme)
  }, [])

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const W = cv.clientWidth
    const H = cv.clientHeight
    if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return
    const cached = sizeRef.current
    if (cached.w !== W || cached.h !== H || cached.dpr !== dpr) {
      cv.width = W * dpr
      cv.height = H * dpr
      sizeRef.current = { w: W, h: H, dpr }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    // цвета темы (читаем на каждый кадр — тема может смениться)
    const HL = cssVar('--color-highlight')
    const TX = cssVar('--color-text')
    const DR = cssVar('--color-danger')

    // окно фиксированной длины едет за курсором: масштаб стоит, движется лента
    const { t0, t1 } = windowForTime(time, duration)
    const span = Math.max(0.01, t1 - t0)
    const X = (t: number) => GUTTER + ((t - t0) / span) * (W - GUTTER - 4)
    const range = fullRange
    const ySpan = Math.max(1, range.hi - range.lo)
    const Y = (m: number) => H - 10 - ((m - range.lo) / ySpan) * (H - 28)
    // за краями не прячем, а прижимаем к краю — видно, что ушло за шкалу
    const Yc = (m: number): number => Y(Math.min(range.hi, Math.max(range.lo, m)))

    // сетка полутонов + имена нот C
    ctx.font = '10px Inter, system-ui, sans-serif'
    for (let m = Math.ceil(range.lo); m <= range.hi; m++) {
      const isC = ((m % 12) + 12) % 12 === 0
      ctx.fillStyle = isC ? hexRgba(TX, 0.22) : hexRgba(TX, 0.07)
      ctx.fillRect(GUTTER, Y(m), W - GUTTER - 4, 1)
      if (isC) {
        ctx.fillStyle = hexRgba(TX, 0.5)
        ctx.fillText(midiName(m), 6, Y(m) + 3)
      }
    }

    // эталон брусками: будущее ярко, спетое приглушено (только окно, бинпоиск)
    if (pitch && pitch.t.length === pitch.midi.length) {
      const [a, b] = sliceWindow(pitch.t, t0, t1)
      const step = Math.max(1, Math.floor((b - a) / 600))
      for (let i = a; i < b; i += step) {
        const m = pitch.midi[i]
        if (m === null || m === undefined) continue
        const t = pitch.t[i]
        if (t === undefined) continue
        const next = i + 1 < pitch.t.length ? pitch.t[i + 1] : t + 0.1
        const w = Math.max(3, X(Math.min(next, t1)) - X(t))
        const dimmed = inSkip(skips, t)
        ctx.fillStyle =
          t < time
            ? dimmed
              ? hexRgba(TX, 0.07)
              : hexRgba(TX, 0.20)
            : dimmed
              ? hexRgba(TX, 0.15)
              : hexRgba(TX, 0.55)
        const yy = Yc(m)
        if (typeof ctx.roundRect === 'function') {
          ctx.beginPath()
          ctx.roundRect(X(t), yy - 5, w, 10, 4)
          ctx.fill()
        } else {
          ctx.fillRect(X(t), yy - 5, w, 10)
        }
      }
    }

    // твои ноты
    for (const d of dotsRef.current) {
      if (d.t < t0 || d.t > t1) continue
      ctx.fillStyle = !d.hit
        ? hexRgba(DR, 0.7)
        : d.perfect
          ? hexRgba(HL, 0.95)
          : hexRgba(TX, 0.75)
      ctx.beginPath()
      ctx.arc(X(d.t), Yc(d.midi), 4.2, 0, Math.PI * 2)
      ctx.fill()
    }

    // курсор
    const cx = X(Math.max(t0, Math.min(t1, time)))
    ctx.fillStyle = hexRgba(TX, 0.85)
    ctx.fillRect(cx - 0.75, 4, 1.5, H - 8)
  }, [pitch, duration, time, dotsRef, skips, themeTick])

  return (
    <canvas ref={ref} className="h-44 w-full" aria-label="Высота тона" />
  )
}
