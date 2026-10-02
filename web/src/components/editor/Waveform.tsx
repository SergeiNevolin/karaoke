import { useEffect, useRef, useState } from 'react'
import { cssVar, hexRgba } from '../../lib/theme'
import type { Segment, WaveformData } from '../../lib/types'

interface Props {
  wave: WaveformData
  segments: Segment[]
  activeSeg: number
  time: number
  /** пропуски «не поём» — янтарная подложка */
  skips?: { s: number; e: number }[]
  /** режим выделения: таскание по волне выделяет диапазон, а не мотает */
  selectMode?: boolean
  /** конец выделения (уже min/max, короче 0.2с не зовём) */
  onSelectRange?: (s: number, e: number) => void
  /** false — звук ещё грузится: клики игнорируются */
  disabled?: boolean
  onSeek(t: number): void
  /** тап (pointerdown) — старт с позиции; если нет, тап = обычный seek */
  onTap?(t: number): void
  onScrub?(scrubbing: boolean): void
}

/** обзор всего трека: волны вокала + регионы строк, клик — играть с позиции */
export default function Waveform({ wave, segments, activeSeg, time, skips, selectMode, onSelectRange, disabled, onSeek, onTap, onScrub }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const scrub = useRef(false)
  // X нажатия: дрожание пальца в пределах порога — не скраб (не отменяем старт playFrom)
  const downX = useRef(0)
  // якорь выделения в режиме selectMode + черновик для отрисовки.
  // Позиции — в ref'ах (логика без зависимости от рендера), draft — только картинка.
  const anchor = useRef<number | null>(null)
  const pos = useRef(0)
  const [draft, setDraft] = useState<{ a: number; b: number } | null>(null)
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
    cv.width = W * dpr
    cv.height = H * dpr
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)

    // цвета темы (читаем на каждый кадр — тема может смениться)
    const HL = cssVar('--color-highlight')
    const TX = cssVar('--color-text')

    const dur = Math.max(1, wave.duration)
    const x = (t: number) => (Math.max(0, Math.min(dur, t)) / dur) * W
    const mid = H / 2

    // регионы строк
    segments.forEach((s, i) => {
      ctx.fillStyle = i === activeSeg ? hexRgba(HL, 0.16) : hexRgba(TX, 0.045)
      ctx.fillRect(x(s.start), 0, Math.max(2, x(s.end) - x(s.start)), H)
    })

    // пропуски «не поём»
    for (const r of skips ?? []) {
      ctx.fillStyle = hexRgba(HL, 0.22)
      ctx.fillRect(x(r.s), 0, Math.max(2, x(r.e) - x(r.s)), H)
    }

    // черновик выделения
    if (draft) {
      const a = Math.min(draft.a, draft.b)
      const b = Math.max(draft.a, draft.b)
      ctx.fillStyle = hexRgba(HL, 0.35)
      ctx.fillRect(x(a), 0, Math.max(2, x(b) - x(a)), H)
      ctx.fillStyle = hexRgba(HL, 0.9)
      ctx.fillRect(x(a) - 1, 0, 2, H)
      ctx.fillRect(x(b) - 1, 0, 2, H)
    }

    // волны
    const n = wave.peaks.length
    const bw = W / n
    ctx.fillStyle = hexRgba(TX, 0.38)
    for (let i = 0; i < n; i++) {
      const h = Math.max(1, wave.peaks[i] * (H - 8))
      const bx = i * bw
      ctx.fillRect(bx, mid - h / 2, Math.max(1, bw - 0.4), h)
    }

    // сыгранная часть
    ctx.fillStyle = hexRgba(TX, 0.45)
    ctx.fillRect(x(time), 0, W - x(time), H)

    // курсор
    ctx.fillStyle = HL
    ctx.fillRect(x(time) - 1, 0, 2, H)
  }, [wave, segments, activeSeg, time, skips, draft, themeTick])

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

  const endSelect = () => {
    const a = anchor.current
    anchor.current = null
    setDraft(null)
    if (a === null) return
    const s = Math.min(a, pos.current)
    const e = Math.max(a, pos.current)
    if (e - s >= 0.2) onSelectRange?.(s, e)
  }

  const cancelSelect = () => {
    anchor.current = null
    setDraft(null)
  }

  return (
    <canvas
      ref={ref}
      className={`h-[60px] w-full touch-none rounded-xl ${disabled ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}
      onPointerDown={(e) => {
        if (disabled) return
        if (selectMode) {
          const t = toTime(e.clientX)
          anchor.current = t
          pos.current = t
          setDraft({ a: t, b: t })
          ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
          return
        }
        scrub.current = true
        downX.current = e.clientX
        onScrub?.(true)
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        const t = toTime(e.clientX)
        // тап стартует воспроизведение, таскание — только мотает (см. onPointerMove)
        if (onTap) onTap(t)
        else onSeek(t)
      }}
      onPointerMove={(e) => {
        if (selectMode) {
          if (anchor.current !== null) {
            pos.current = toTime(e.clientX)
            setDraft({ a: anchor.current, b: pos.current })
          }
          return
        }
        // дрожание в пределах 4px — не скраб: иначе seek отменит только что стартовавший playFrom
        if (scrub.current && Math.abs(e.clientX - downX.current) > 4) onSeek(toTime(e.clientX))
      }}
      onPointerUp={() => {
        if (selectMode) {
          endSelect()
          return
        }
        endScrub()
      }}
      onPointerCancel={() => {
        if (selectMode) {
          cancelSelect()
          return
        }
        endScrub()
      }}
    />
  )
}
