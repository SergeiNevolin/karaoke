import type { Segment, Word } from './types'

/** равномерно разложить слова текста по интервалу (мс, стыки без щелей) */
export function evenWords(text: string, start: number, end: number): Segment['words'] {
  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const s = Number.isFinite(start) ? start : 0
  let e = Number.isFinite(end) ? end : s + 1
  if (!(e > s)) e = s + tokens.length * 0.4 // сломанный интервал — не даём словам инвертироваться
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  return tokens.map((w, i) => ({
    w,
    s: r3(s + ((e - s) * i) / tokens.length),
    e: r3(s + ((e - s) * (i + 1)) / tokens.length),
  }))
}

/** границы слов в мс: clamp в [s, e], монотонность, без инверсий (никого не удаляем) */
export function normalizeWords(words: Word[], s: number, e: number): Word[] {
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  const lo = r3(Math.min(s, e))
  const hi = r3(Math.max(s, e))
  const out: Word[] = []
  let prev = lo
  for (const w of words) {
    const ws = Number.isFinite(w.s) ? w.s : lo
    const we = Number.isFinite(w.e) ? w.e : hi
    const s2 = Math.max(lo, Math.min(r3(ws), hi), prev)
    let e2 = Math.max(lo, Math.min(r3(we), hi))
    if (e2 < s2) e2 = Math.min(hi, r3(s2 + 0.03))
    if (e2 < s2) e2 = s2
    out.push({ ...w, s: s2, e: e2 })
    prev = e2
  }
  return out
}

/** токены внутри одного слова (склеенные содержат пробелы) */
export function wordTokens(w: Word): string[] {
  return w.w.split(/\s+/).filter(Boolean)
}

/** сколько текстовых токенов покрывает каждое слово */
export function tokenSpans(words: Word[]): number[] {
  return words.map((w) => Math.max(1, wordTokens(w).length))
}

/** индекс первого токена слова i */
export function tokenStart(spans: number[], i: number): number {
  let s = 0
  for (let k = 0; k < i; k++) s += spans[k]
  return s
}

/**
 * Согласовать слова с текстом строки:
 * - склеенные слова покрывают несколько токенов — их тайминги целы;
 * - число токенов изменилось — раскладываем равномерно.
 */
export function syncWords(row: Segment): Segment {
  const tokens = row.text.split(/\s+/).filter(Boolean)
  const spans = tokenSpans(row.words)
  const total = spans.reduce((a, b) => a + b, 0)
  if (tokens.length > 0 && tokens.length === total) {
    let ti = 0
    const words = row.words.map((w) => {
      const k = Math.max(1, wordTokens(w).length)
      const text = tokens.slice(ti, ti + k).join(' ')
      ti += k
      return { ...w, w: text }
    })
    return { start: row.start, end: row.end, text: row.text.trim(), part: row.part, words }
  }
  return {
    start: row.start,
    end: row.end,
    text: row.text.trim(),
    part: row.part,
    words: evenWords(row.text, row.start, row.end),
  }
}
