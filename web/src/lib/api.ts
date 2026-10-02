import type { Manifest, SongMeta } from './types'

/** базовый префикс API: '' — standalone, '/karaoke' — встроенный режим (VITE_API_BASE) */
export const BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '')

/** ключ токена в localStorage; пусто — Bearer не шлём (standalone без входа) */
const TOKEN_KEY = (import.meta.env.VITE_AUTH_STORAGE_KEY as string | undefined) ?? ''

export const AUTH_REQUIRED = 'Требуется вход в bebradio'

/** сервер требует вход в bebradio — не сетевая ошибка и не «бэкенд упал» */
export class AuthRequiredError extends Error {}

function authHeaders(): Record<string, string> {
  if (!TOKEN_KEY) return {}
  try {
    const t = localStorage.getItem(TOKEN_KEY)
    return t ? { Authorization: `Bearer ${t}` } : {}
  } catch {
    return {}
  }
}

export interface UploadOptions {
  lang: string
}

export interface JobStatus {
  id: string
  state: 'queued' | 'running' | 'done' | 'error'
  stage: string
  stageLabel: string
  progress: number
  title?: string
  songId?: string | null
  error?: string
}

/** текст ошибки сервера: сначала тело {error}, иначе HTTP-статус */
export async function errorBody(r: Response): Promise<string> {
  try {
    const data = (await r.json()) as { error?: unknown }
    if (typeof data.error === 'string' && data.error) return data.error
  } catch {
    /* не JSON — падаем на статус */
  }
  return `HTTP ${r.status}`
}

const NET_DOWN = 'Нет связи с сервером — проверьте подключение и попробуйте снова'
const NET_TIMEOUT = 'Сервер не отвечает — подождите немного и повторите попытку'

/** fetch бросает TypeError при обрыве связи и DOMException на таймауте — переводим в понятный текст */
function netFail(e: unknown): never {
  if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    throw new Error(NET_TIMEOUT)
  }
  throw new Error(NET_DOWN)
}

/** fetch с таймаутом: висящий запрос не должен намертво заморозить интерфейс */
async function fetchTo(url: string, init?: RequestInit, ms = 15_000): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctl.signal })
  } catch (e) {
    netFail(e)
  } finally {
    clearTimeout(timer)
  }
}

/** fetch к API: базовый префикc + Bearer из localStorage */
export async function apiFetch(url: string, init?: RequestInit, ms = 15_000): Promise<Response> {
  const headers = new Headers(init?.headers)
  for (const [k, v] of Object.entries(authHeaders())) if (!headers.has(k)) headers.set(k, v)
  return fetchTo(`${BASE}${url}`, { ...init, headers }, ms)
}

/** каталог: сначала пробуем API бэкенда, иначе статический manifest */
export async function fetchManifest(): Promise<SongMeta[]> {
  try {
    const r = await apiFetch('/api/songs')
    if (r.status === 401) throw new AuthRequiredError(AUTH_REQUIRED)
    if (r.ok) {
      const data = (await r.json()) as Manifest
      // пустой каталог — валидный ответ, а не повод лезть в статику
      if (Array.isArray(data.songs)) return data.songs
    }
  } catch (e) {
    if (e instanceof AuthRequiredError) throw e
    /* бэкенд не запущен — fallback ниже */
  }
  const r = await fetch('songs/manifest.json')
  if (!r.ok) return []
  const data = (await r.json()) as Manifest
  return Array.isArray(data.songs) ? data.songs : []
}

export async function apiAvailable(): Promise<boolean> {
  try {
    const r = await apiFetch('/api/songs')
    return r.ok
  } catch {
    return false
  }
}

export async function uploadSong(
  file: File,
  opts: UploadOptions,
  extra?: { lyricsText?: string; lyricsUrl?: string },
): Promise<string> {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('lang', opts.lang)
  if (extra?.lyricsText?.trim()) fd.append('lyrics_text', extra.lyricsText.trim())
  if (extra?.lyricsUrl?.trim()) fd.append('lyrics_url', extra.lyricsUrl.trim())
  // большой файл по медленному каналу — щедрый таймаут, но не вечность
  const r = await apiFetch('/api/upload', { method: 'POST', body: fd }, 10 * 60_000)
  if (!r.ok) throw new Error(await errorBody(r))
  const data = (await r.json()) as { jobId?: string; error?: string }
  if (data.error) throw new Error(data.error)
  if (!data.jobId) throw new Error('Нет jobId в ответе')
  return data.jobId
}

/** статус задачи; 404 — задача исчезла (перезапуск бэкенда), не сетевой сбой */
export async function getJob(jobId: string): Promise<JobStatus | null> {
  const r = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}`)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(await errorBody(r))
  return (await r.json()) as JobStatus
}

/** подтянуть текст с Genius через бэкенд (без CORS-проблем) */
export async function fetchGeniusLines(url: string): Promise<string[]> {
  const r = await apiFetch(`/api/lyrics/fetch?url=${encodeURIComponent(url)}`, undefined, 30_000)
  if (!r.ok) throw new Error(await errorBody(r))
  const data = (await r.json()) as { lines?: string[]; error?: string }
  if (data.error) throw new Error(data.error)
  return data.lines ?? []
}
