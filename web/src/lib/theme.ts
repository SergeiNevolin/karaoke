/**
 * Тема и акцент — в те же ключи localStorage ('theme', 'accent'), что у
 * bebradio: origin у iframe и родителя общий, поэтому переключение темы или
 * акцента в bebradio подхватывается караоке через событие storage.
 */

const THEME_KEY = 'theme'
const ACCENT_KEY = 'accent'

export type Theme = 'light' | 'dark'

export function getStoredTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* приватный режим и т.п. */
  }
  // как в bebradio (App.tsx): без сохранённого значения — системная тема
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  window.dispatchEvent(new Event('karaoke:theme'))
}

function darkenColor(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16)
  const r = Math.max(0, (num >> 16) - amount)
  const g = Math.max(0, ((num >> 8) & 0x00ff) - amount)
  const b = Math.max(0, (num & 0x0000ff) - amount)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

export function getStoredAccent(): string {
  try {
    return localStorage.getItem(ACCENT_KEY) || ''
  } catch {
    return ''
  }
}

export function applyAccent(color: string): void {
  const root = document.documentElement
  if (color) {
    root.style.setProperty('--color-primary', color)
    root.style.setProperty('--color-primary-hover', darkenColor(color, 20))
  } else {
    root.style.removeProperty('--color-primary')
    root.style.removeProperty('--color-primary-hover')
  }
  window.dispatchEvent(new Event('karaoke:theme'))
}

/** Применить сохранённые тему/акцент и следить за их сменой в bebradio. */
export function initTheme(): void {
  const sync = () => {
    applyTheme(getStoredTheme())
    applyAccent(getStoredAccent())
  }
  sync()
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_KEY || e.key === ACCENT_KEY || e.key === null) sync()
  })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync()
  })
}

/** Значение CSS-переменной на <html> (для canvas-отрисовки). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** hex → rgba(...) с альфой (токены у нас hex-овые). */
export function hexRgba(hex: string, alpha: number): string {
  const m = /^#?([\da-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}
