import type { SongMeta } from './types'

export interface UploadOptions {
  model: 'htdemucs' | 'htdemucs_ft'
  whisper: 'large-v3' | 'medium' | 'small'
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

/** каталог: сначала пробуем API бэкенда, иначе статический manifest */
export async function fetchManifest(): Promise<SongMeta[]> {
  try {
    const r = await fetch('/api/songs')
    if (r.ok) {
      const data = (await r.json()) as { songs: SongMeta[] }
      if (Array.isArray(data.songs) && data.songs.length > 0) return data.songs
    }
  } catch {
    /* бэкенд не запущен — fallback ниже */
  }
  const r = await fetch('songs/manifest.json')
  if (!r.ok) return []
  return ((await r.json()) as { songs: SongMeta[] }).songs ?? []
}

export async function apiAvailable(): Promise<boolean> {
  try {
    const r = await fetch('/api/songs')
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
  fd.append('model', opts.model)
  fd.append('whisper', opts.whisper)
  fd.append('lang', opts.lang)
  if (extra?.lyricsText?.trim()) fd.append('lyrics_text', extra.lyricsText.trim())
  if (extra?.lyricsUrl?.trim()) fd.append('lyrics_url', extra.lyricsUrl.trim())
  const r = await fetch('/api/upload', { method: 'POST', body: fd })
  if (!r.ok) throw new Error(`Upload HTTP ${r.status}`)
  const data = (await r.json()) as { jobId?: string; error?: string }
  if (data.error) throw new Error(data.error)
  if (!data.jobId) throw new Error('Нет jobId в ответе')
  return data.jobId
}

export async function getJob(jobId: string): Promise<JobStatus> {
  const r = await fetch(`/api/jobs/${jobId}`)
  if (!r.ok) throw new Error(`Job HTTP ${r.status}`)
  return (await r.json()) as JobStatus
}

/** подтянуть текст с Genius через бэкенд (без CORS-проблем) */
export async function fetchGeniusLines(url: string): Promise<string[]> {
  const r = await fetch(`/api/lyrics/fetch?url=${encodeURIComponent(url)}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const data = (await r.json()) as { lines?: string[]; error?: string }
  if (data.error) throw new Error(data.error)
  return data.lines ?? []
}
