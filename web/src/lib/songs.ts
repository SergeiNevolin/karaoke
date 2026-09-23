import type { PitchTrack, Segment, SongData, SongMeta, WaveformData } from './types'
import { fetchManifest } from './api'

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`)
  return (await r.json()) as T
}

export async function loadManifest(): Promise<SongMeta[]> {
  try {
    return await fetchManifest()
  } catch {
    return []
  }
}

interface RawLyrics {
  language?: string
  segments: { start: number; end: number; text: string; part?: string; words?: { w: string; s: number; e: number }[] }[]
}

const lyricsKey = (id: string) => `karaoke:lyrics:${id}`

/** правки пользователя из localStorage (приоритет над бандлом) */
export function loadLocalLyrics(id: string): Segment[] | null {
  try {
    const raw = localStorage.getItem(lyricsKey(id))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { segments?: Segment[] }
    if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) return null
    return parsed.segments
  } catch {
    return null
  }
}

export function saveLocalLyrics(id: string, language: string | undefined, segments: Segment[]): void {
  localStorage.setItem(lyricsKey(id), JSON.stringify({ language, segments }))
}

export function clearLocalLyrics(id: string): void {
  localStorage.removeItem(lyricsKey(id))
}

export function hasLocalLyrics(id: string): boolean {
  try {
    return localStorage.getItem(lyricsKey(id)) !== null
  } catch {
    return false
  }
}

export async function loadSong(meta: SongMeta): Promise<SongData> {
  const base = `songs/${meta.id}`
  const [lyr, pitch, waveform] = await Promise.all([
    getJSON<RawLyrics>(`${base}/lyrics.json`),
    getJSON<PitchTrack>(`${base}/pitch.json`).catch(() => null),
    getJSON<WaveformData>(`${base}/waveform.json`).catch(() => null),
  ])
  const segments: Segment[] = lyr.segments.map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text,
    part: s.part,
    words:
      s.words && s.words.length > 0
        ? s.words
        : s.text.split(/\s+/).map((w, i, arr) => ({
            w,
            s: s.start + ((s.end - s.start) * i) / arr.length,
            e: s.start + ((s.end - s.start) * (i + 1)) / arr.length,
          })),
  }))
  const local = loadLocalLyrics(meta.id)
  return { ...meta, segments: local ?? segments, pitch, waveform }
}

/** индекс активного сегмента + сколько слов уже спето */
export function locate(segments: Segment[], t: number): { seg: number; sungWords: number } {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    if (t >= s.start - 0.15 && t <= s.end + 0.4) {
      let n = 0
      s.words.forEach((w) => {
        if (t >= w.s - 0.05) n++
      })
      return { seg: i, sungWords: n }
    }
  }
  let prev = -1
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].end < t) prev = i
  }
  return { seg: prev, sungWords: Number.MAX_SAFE_INTEGER }
}

/** ближайшая строка к моменту t — для кликов (без допусков locate) */
export function nearestSegment(segments: Segment[], t: number): number {
  if (segments.length === 0) return -1
  for (let i = 0; i < segments.length; i++) {
    if (t >= segments[i].start && t <= segments[i].end) return i
  }
  let best = 0
  let bd = Infinity
  for (let i = 0; i < segments.length; i++) {
    const d = t < segments[i].start ? segments[i].start - t : t - segments[i].end
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return best
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/* ---------- редактор текста ---------- */

/** равномерно разложить слова строки по её интервалу */
export function evenWords(text: string, start: number, end: number): Segment['words'] {
  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const s = Number.isFinite(start) ? start : 0
  let e = Number.isFinite(end) ? end : s + 1
  if (!(e > s)) e = s + tokens.length * 0.4 // сломанный интервал — не даём словам инвертироваться
  return tokens.map((w, i) => ({
    w,
    s: Math.round((s + ((e - s) * i) / tokens.length) * 100) / 100,
    e: Math.round((s + ((e - s) * (i + 1)) / tokens.length) * 100) / 100,
  }))
}

/**
 * Наложить вставленный текст на существующие тайминги:
 * строки [в скобках] пропускаются (это заголовки секций).
 * Лишние строки дописываются после последней (+2.5с каждая).
 * Если текста меньше, чем сегментов — остаток НЕ трогаем (не удаляем молча).
 */
export function applyTextToSegments(
  segments: Segment[],
  raw: string,
): { segments: Segment[]; replaced: number; kept: number; appended: number } {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\[.*\]$/.test(l))
  if (lines.length === 0) return { segments, replaced: 0, kept: segments.length, appended: 0 }
  const out: Segment[] = lines.slice(0, segments.length).map((text, i) => ({
    ...segments[i],
    text,
    words: evenWords(text, segments[i].start, segments[i].end),
  }))
  const replaced = Math.min(lines.length, segments.length)
  let kept = 0
  if (lines.length < segments.length) {
    // хвост оставляем как был — середине песни текст не придумываем
    for (let i = lines.length; i < segments.length; i++) out.push(segments[i])
    kept = segments.length - lines.length
  }
  let cursor = segments[segments.length - 1]?.end ?? 0
  let appended = 0
  for (let i = segments.length; i < lines.length; i++) {
    const s = Math.round((cursor + 0.3) * 100) / 100
    const e = Math.round((s + 2.5) * 100) / 100
    out.push({ start: s, end: e, text: lines[i], words: evenWords(lines[i], s, e) })
    cursor = e
    appended++
  }
  return { segments: out, replaced, kept, appended }
}

/** вытащить строки текста из HTML страницы Genius */
export function parseGeniusHtml(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const boxes = doc.querySelectorAll('[data-lyrics-container="true"]')
  const lines: string[] = []
  boxes.forEach((box) => {
    box.innerHTML = box.innerHTML.replace(/<br\s*\/?>/gi, '\n')
    const text = (box.textContent ?? '').replace(/\u2005/g, ' ')
    text.split('\n').forEach((l) => {
      const t = l.trim()
      if (t && !/^\[.*\]$/.test(t)) lines.push(t)
    })
  })
  return lines
}

/**
 * Загрузить текст по URL (напр. Genius).
 * Напрямую мешает CORS, поэтому при неудаче идём через прокси allorigins.
 */
export async function fetchLyricsFromUrl(url: string): Promise<string[]> {
  const read = async (u: string): Promise<string> => {
    const r = await fetch(u)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.text()
  }
  let html: string
  try {
    html = await read(url)
  } catch {
    html = await read(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`)
  }
  const lines = parseGeniusHtml(html)
  if (lines.length === 0) throw new Error('Текст не найден на странице')
  return lines
}

/** скачать lyrics.json в веб-формате (для постоянного сохранения) */
export function downloadLyrics(id: string, language: string | undefined, segments: Segment[]): void {
  const blob = new Blob([JSON.stringify({ language, segments }, null, 1)], {
    type: 'application/json',
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${id}-lyrics.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
