import type { PitchTrack, Segment, SkipRange, SongData, SongMeta, WaveformData, Word } from './types'
import { fetchManifest } from './api'
import { displayPitchTrack, gatePitchToSegments, quantizePitchTrack } from './pitch'
import { evenWords } from './wordModel'

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
  skips?: { s: number; e: number }[]
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

/**
 * Сохранить правки текста+пропусков: сначала на бэкенд (канон data/songs),
 * при недоступности — в localStorage как раньше. Возвращает, куда легло.
 * При успехе локальный оверрайд стираем (дальше читаем канон).
 */
export async function saveSongLyrics(
  id: string,
  language: string | undefined,
  segments: Segment[],
  skips: SkipRange[],
): Promise<'server' | 'local'> {
  try {
    const r = await fetch(`/api/songs/${encodeURIComponent(id)}/lyrics`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language, segments, skips }),
    })
    const data = (await r.json()) as { ok?: boolean; error?: string }
    if (r.ok && data.ok) {
      try {
        localStorage.removeItem(lyricsKey(id))
        clearLocalSkips(id)
      } catch {
        /* ignore */
      }
      return 'server'
    }
  } catch {
    /* бэкенд недоступен — fallback ниже */
  }
  saveLocalLyrics(id, language, segments)
  saveLocalSkips(id, skips)
  return 'local'
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

/** пропуски «не поём»: валидация (концы обязаны быть числами, e > s) + сортировка */
export function validSkips(raw: unknown): SkipRange[] {
  if (!Array.isArray(raw)) return []
  const out: SkipRange[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const s = Number((r as { s?: unknown }).s)
    const e = Number((r as { e?: unknown }).e)
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s) continue
    out.push({ s, e })
  }
  out.sort((a, b) => a.s - b.s)
  return out
}

const skipsKey = (id: string) => `karaoke:skips:${id}`

/** правки пропусков из localStorage. null — нет ключа/битый; [] — валидно (всё стёрто) */
export function loadLocalSkips(id: string): SkipRange[] | null {
  try {
    const raw = localStorage.getItem(skipsKey(id))
    if (raw === null) return null
    return validSkips((JSON.parse(raw) as { skips?: unknown }).skips)
  } catch {
    return null
  }
}

export function saveLocalSkips(id: string, skips: SkipRange[]): void {
  localStorage.setItem(skipsKey(id), JSON.stringify({ skips: validSkips(skips) }))
}

export function clearLocalSkips(id: string): void {
  localStorage.removeItem(skipsKey(id))
}

/** момент внутри пропуска */
export function inSkip(skips: readonly SkipRange[] | undefined, t: number): boolean {
  if (!skips) return false
  for (const s of skips) {
    if (t >= s.s && t <= s.e) return true
  }
  return false
}

/** какую дорожку должно быть слышно: оригинал — в плюсе и на пропусках (если есть файл) */
export function wantOriginal(
  backing: 'minus' | 'full',
  skips: readonly SkipRange[] | undefined,
  hasOriginal: boolean,
  t: number,
): boolean {
  if (!hasOriginal) return false
  if (backing === 'full') return true
  return inSkip(skips, t)
}

export async function loadSong(meta: SongMeta): Promise<SongData> {
  const base = `songs/${meta.id}`
  const [lyr, pitch, waveform] = await Promise.all([
    getJSON<RawLyrics>(`${base}/lyrics.json`),
    getJSON<PitchTrack>(`${base}/pitch.json`).catch(() => null),
    getJSON<WaveformData>(`${base}/waveform.json`).catch(() => null),
  ])
  // валидация бандла: битые сегменты/слова выкидываем, а не роняем плеер
  const rawSegs = Array.isArray(lyr.segments) ? lyr.segments : []
  const segments: Segment[] = []
  for (const s of rawSegs) {
    const start = Number(s.start)
    const end = Number(s.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    const text = String(s.text ?? '')
    const words: Word[] = Array.isArray(s.words)
      ? s.words
        .filter((w) => w && typeof w.w === 'string' && Number.isFinite(Number(w.s)) && Number.isFinite(Number(w.e)))
        .map((w) => ({ w: w.w, s: Number(w.s), e: Number(w.e) }))
      : []
    segments.push({
      start,
      end,
      text,
      part: typeof s.part === 'string' ? s.part : undefined,
      words: words.length > 0 ? words : evenWords(text, start, end),
    })
  }
  const local = loadLocalLyrics(meta.id)
  // localStorage приоритетнее бандла, но только если валиден целиком
  const validLocal: Segment[] | null =
    local !== null &&
    local.every((s) =>
      Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start &&
      typeof s.text === 'string' && Array.isArray(s.words) &&
      s.words.every((w) => typeof w.w === 'string' && Number.isFinite(w.s) && Number.isFinite(w.e)))
      ? local
      : null
  // эталон чистим сразу: строгий — для скоринга, гладкий — для показа.
  // оба гейтим по сегментам: bleed из интро/соло/аутро в ноты не пускаем
  const segs = validLocal ?? segments
  // пропуски: localStorage целиком перекрывает бандл (пусто — валидно)
  const localSkips = loadLocalSkips(meta.id)
  return {
    ...meta,
    segments: segs,
    pitch: gatePitchToSegments(quantizePitchTrack(pitch), segs),
    pitchSmooth: gatePitchToSegments(displayPitchTrack(pitch), segs),
    skips: localSkips ?? validSkips(lyr.skips),
    waveform,
  }
}

/** допуски подсветки при проигрывании (сек): ранний захват строки, хвост, слова */
const LOCATE_START_EPS = 0.15
const LOCATE_END_TAIL = 0.4
const LOCATE_WORD_EPS = 0.05
/** хвост удержания строки в окне караоке (сек) */
const WINDOW_TAIL = 0.15

/** индекс активного сегмента + сколько слов уже спето */
export function locate(segments: Segment[], t: number): { seg: number; sungWords: number } {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    if (t >= s.start - LOCATE_START_EPS && t <= s.end + LOCATE_END_TAIL) {
      let n = 0
      s.words.forEach((w) => {
        if (t >= w.s - LOCATE_WORD_EPS) n++
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

/** окно караоке: индекс строки, которая должна быть крупной.
 *  Правила по-простому и без залипаний:
 *  1. побеждает строка, чьё слово поётся ПРЯМО СЕЙЧАС — стык отдаётся ровно
 *     на границе слов, звучащая строка не скипается раньше времени;
 *     ничья (поют обе — перекрытие) — позже начавшаяся; равный старт (дубли) —
 *     сначала короткая, потом длинная подхватывает;
 *  2. иначе ближайшая будущая в окне упреждения leadIn — встаёт ЗАРАНЕЕ;
 *  3. иначе последняя прошедшая (пауза) — окно стоит, а не прыгает.
 *  Битые строки (конец раньше начала) окно не держат; порядок не важен. */
export function locateWindow(segments: Segment[], t: number, leadIn = 0.35): number {
  if (segments.length === 0) return -1
  let cur = -1
  let curSounding = false
  let curStart = -Infinity
  let curEnd = Infinity
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    if (s.end < s.start) continue
    if (t < s.start || t > s.end + WINDOW_TAIL) continue
    const sounding = s.words.some((w) => t >= w.s - 0.01 && t <= w.e + 0.01)
    if (
      cur < 0 ||
      (sounding && !curSounding) ||
      (sounding === curSounding && (s.start > curStart || (s.start === curStart && s.end < curEnd)))
    ) {
      cur = i
      curSounding = sounding
      curStart = s.start
      curEnd = s.end
    }
  }
  if (cur >= 0) return cur
  let idx = 0
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].start <= t + leadIn) idx = i
  }
  return idx
}

/** ближайшая строка к моменту t — для кликов (без допусков locate) */
export function nearestSegment(segments: Segment[], t: number): number {
  if (segments.length === 0) return -1
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].end < segments[i].start) continue // битые пропускаем
    if (t >= segments[i].start && t <= segments[i].end) return i
  }
  let best = -1
  let bd = Infinity
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].end < segments[i].start) continue
    const d = t < segments[i].start ? segments[i].start - t : t - segments[i].end
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return best
}

/**
 * Порядок строк по времени: если правки утянули строку раньше соседней —
 * строки меняются местами. Уже упорядоченные возвращает как есть (тот же ref,
 * без лишних ререндеров); сортировка стабильная — равные старты не тасует.
 */
export function sortRowsByStart<T extends { start: number }>(rows: T[]): T[] {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].start < rows[i - 1].start) return [...rows].sort((a, b) => a.start - b.start)
  }
  return rows
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const mm = h > 0 ? `${m}`.padStart(2, '0') : `${m}`
  return `${h > 0 ? `${h}:` : ''}${mm}:${s.toString().padStart(2, '0')}`
}

/** русская плюрализация: plural(1,'песня','песни','песен') */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = Math.abs(n) % 10
  const m100 = Math.abs(n) % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

/** время с миллисекундами для редактора: 1:23.456 */
export function formatTimeMs(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.floor((sec - Math.floor(sec)) * 1000)
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`
}

/* ---------- редактор текста ---------- */

// evenWords живёт в wordModel (рядом с остальной механикой слов); здесь — для совместимости
export { evenWords } from './wordModel'

/* ---------- нечёткое наложение текста ---------- */

/** порог сходства строк для пары (как в бэкенде) */
const FUZZY_THRESHOLD = 0.45

/** нормализация для сравнения: регистр, ё, пунктуация */
function normLine(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>()
  const t = ` ${s} `
  for (let i = 0; i + 1 < t.length; i++) {
    const b = t.slice(i, i + 2)
    m.set(b, (m.get(b) ?? 0) + 1)
  }
  return m
}

/** сходство строк 0..1 (Дайс по биграммам); равные после нормы — 1 */
function lineSim(a: string, b: string): number {
  const na = normLine(a)
  const nb = normLine(b)
  if (na === nb) return 1
  if (!na || !nb) return 0
  const ma = bigrams(na)
  const mb = bigrams(nb)
  let hit = 0
  let total = 0
  ma.forEach((c, k) => {
    total += c
    hit += Math.min(c, mb.get(k) ?? 0)
  })
  mb.forEach((c) => {
    total += c
  })
  return total === 0 ? 0 : (2 * hit) / total
}

/**
 * Глобальное выравнивание строк на сегменты (монотонно, оптимально —
 * в отличие от жадного «каждый сегмент берёт лучшее»: жадность ворует
 * строки у соседей и плодит дубли).
 * Возвращает пары segIdx -> lineIdx, только при сходстве >= порога.
 */
function alignSegments(segNorm: string[], lineNorm: string[], thr: number): Map<number, number> {
  const n = segNorm.length
  const m = lineNorm.length
  const sim: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: m }, (_, j) => lineSim(segNorm[i], lineNorm[j])),
  )
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = sim[i - 1][j - 1]
      const pair = s >= thr ? dp[i - 1][j - 1] + s : -Infinity
      dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1], pair)
    }
  }
  const pairs = new Map<number, number>()
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    const s = sim[i - 1][j - 1]
    if (s >= thr && dp[i][j] === dp[i - 1][j - 1] + s) {
      pairs.set(i - 1, j - 1)
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }
  return pairs
}

/** relaxed-порог второго прохода: добираем пограничные пары, иначе они плодят дубли */
const RELAXED_THRESHOLD = 0.3

/** LCS токенов по точному совпадению нормы: пары [whisperIdx, customIdx] */
function lcsTokens(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  return out
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000

/**
 * Перенести тайминги whisper-слов на слова custom-строки:
 * совпавшие токены наследуют точные тайминги, остальные — интерполяция
 * между соседними якорями (а не равномерный разброс по всему интервалу).
 */
function transferWords(seg: Segment, text: string): Word[] {
  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  // токены whisper (склеенные слова делят интервал равномерно) с таймингами
  const wt: { text: string; s: number; e: number }[] = []
  for (const w of seg.words) {
    const toks = w.w.split(/\s+/).filter(Boolean)
    toks.forEach((t, k) => {
      wt.push({
        text: t,
        s: r3(w.s + ((w.e - w.s) * k) / toks.length),
        e: r3(w.s + ((w.e - w.s) * (k + 1)) / toks.length),
      })
    })
  }
  if (wt.length === 0) return evenWords(text, seg.start, seg.end)
  const anchored = new Array<number>(tokens.length).fill(-1)
  for (const [wi, ci] of lcsTokens(wt.map((t) => normLine(t.text)), tokens.map((t) => normLine(t)))) {
    if (anchored[ci] === -1) anchored[ci] = wi
  }
  const out: Word[] = new Array(tokens.length)
  let k = 0
  while (k < tokens.length) {
    if (anchored[k] >= 0) {
      const w = wt[anchored[k]]
      out[k] = { w: tokens[k], s: w.s, e: w.e }
      k++
    } else {
      let r = k
      while (r < tokens.length && anchored[r] < 0) r++
      const lo = k > 0 ? out[k - 1].e : seg.start
      const hi = r < tokens.length ? wt[anchored[r]].s : seg.end
      const cnt = r - k
      for (let q = 0; q < cnt; q++) {
        out[k + q] = {
          w: tokens[k + q],
          s: r3(lo + ((hi - lo) * q) / cnt),
          e: r3(lo + ((hi - lo) * (q + 1)) / cnt),
        }
      }
      k = r
    }
  }
  return out
}

/** равномерно разложить строки по паузе [gs, ge]; тесно — расширяем, но не дальше hardEnd */
function distributeGap(texts: string[], gs: number, ge: number, hardEnd?: number): Segment[] {
  if (texts.length === 0) return []
  const a = Math.max(0, gs)
  let b = Math.max(a + 0.1, ge)
  if (b - a < texts.length * 0.4) b = a + texts.length * 2.0
  if (hardEnd !== undefined) b = Math.min(b, Math.max(a + 0.1, hardEnd))
  return texts.map((text, idx) => {
    const s = r3(a + ((b - a) * idx) / texts.length)
    const e = r3(a + ((b - a) * (idx + 1)) / texts.length)
    return { start: s, end: e, text, words: evenWords(text, s, e) }
  })
}

/**
 * Наложить вставленный текст на существующие тайминги:
 * строки [в скобках] пропускаются (это заголовки секций).
 * Совпавшие строки встают на похожие сегменты (глобальное выравнивание,
 * тайминги слов переносятся, а не разбрасываются); пропущенные дописываются
 * в паузы и в конец (+2.5с каждая); несопоставленные сегменты НЕ трогаем.
 */
export function applyTextToSegments(
  segments: Segment[],
  raw: string,
): {
  segments: Segment[]
  matched: number
  relaxed: number
  replaced: number
  kept: number
  inserted: number
  appended: number
  deduped: number
} {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\[.*\]$/.test(l))
  if (lines.length === 0) {
    return { segments, matched: 0, relaxed: 0, replaced: 0, kept: segments.length, inserted: 0, appended: 0, deduped: 0 }
  }
  const segNorm = segments.map((s) => normLine(s.text))
  const lineNorm = lines.map(normLine)
  const pairs = alignSegments(segNorm, lineNorm, FUZZY_THRESHOLD)
  const strict = pairs.size
  // второй проход послабее: пограничные пары, мимо которых строгий прошёл, —
  // иначе они плодят дубли (оригинал + вставленная копия)
  const usedSeg = new Set(pairs.keys())
  const usedLine = new Set(pairs.values())
  const rs = segments.map((_, i) => i).filter((i) => !usedSeg.has(i))
  const rl = lines.map((_, k) => k).filter((k) => !usedLine.has(k))
  if (rs.length > 0 && rl.length > 0) {
    const sub = alignSegments(
      rs.map((i) => segNorm[i]),
      rl.map((k) => lineNorm[k]),
      RELAXED_THRESHOLD,
    )
    sub.forEach((b, a) => {
      pairs.set(rs[a], rl[b])
    })
  }
  const relaxed = pairs.size - strict
  const putGap = (out: Segment[], custom: { s: number; e: number; text: string }[], texts: string[], gs: number, ge: number, hardEnd?: number): void => {
    const gap = distributeGap(texts, gs, ge, hardEnd ?? Infinity)
    out.push(...gap)
    for (const g of gap) custom.push({ s: g.start, e: g.end, text: g.text })
  }
  const out: Segment[] = []
  let replaced = 0
  let inserted = 0
  let appended = 0
  let cursor = 0 // следующая неиспользованная строка
  let prevEnd = 0
  const keptPos: number[] = [] // позиции без пары
  const custom: { s: number; e: number; text: string }[] = [] // всё из custom-текста
  segments.forEach((seg, i) => {
    const k = pairs.get(i)
    if (k !== undefined) {
      if (k > cursor) {
        // пропущенные строки — в паузу перед сегментом (не залезая в него)
        const before = out.length
        putGap(out, custom, lines.slice(cursor, k), prevEnd, seg.start, seg.start)
        inserted += out.length - before
      }
      const nt = lines[k]
      if (normLine(nt) === normLine(seg.text)) {
        out.push({ ...seg }) // тот же текст — точные тайминги целы
      } else {
        out.push({ ...seg, text: nt, words: transferWords(seg, nt) })
        replaced++
      }
      custom.push({ s: seg.start, e: seg.end, text: nt })
      cursor = k + 1
      prevEnd = seg.end
    } else {
      out.push({ ...seg }) // без пары — оставляем как распознали
      keptPos.push(out.length - 1)
      prevEnd = seg.end
    }
  })
  if (cursor < lines.length) {
    // хвост — после последней строки
    const before = out.length
    putGap(out, custom, lines.slice(cursor), prevEnd + 0.3, prevEnd + 0.3 + (lines.length - cursor) * 2.5)
    appended += out.length - before
  }
  // подавление дублей: без пары, почти целиком внутри custom-строки
  // с похожим текстом, — тень merge, в караоке никогда не показывается
  const drop = new Set<number>()
  for (const p of keptPos) {
    const ks = out[p]
    const kd = ks.end - ks.start
    if (!(kd > 0)) continue
    for (const c of custom) {
      const inter = Math.min(ks.end, c.e) - Math.max(ks.start, c.s)
      if (inter / kd > 0.6 && lineSim(ks.text, c.text) >= 0.5) {
        drop.add(p)
        break
      }
    }
  }
  const deduped = drop.size
  const finalSegs = drop.size > 0 ? out.filter((_, idx) => !drop.has(idx)) : out
  return { segments: finalSegs, matched: pairs.size, relaxed, replaced, kept: keptPos.length - deduped, inserted, appended, deduped }
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
