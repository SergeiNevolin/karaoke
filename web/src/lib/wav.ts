/**
 * Точный звук для редактора.
 *
 * MP3 нельзя мотать точно: seek ложится на границы кадров (~26мс) плюс
 * encoder delay/padding сдвигают тайминги. WAV (PCM) мотается посемплово
 * (~0.02мс) и без сдвигов — песня и текст совпадают до миллисекунды.
 *
 * Поэтому при входе в редактор mp3 декодируем в WAV-блоб в памяти
 * (mp3UrlToWavBlobUrl) и кормим движок им. Хранить WAV в public/dist
 * не нужно: декодирование 3-минутного трека занимает ~1с.
 * Не вышло декодировать — вызыватель просто играет mp3 как раньше.
 */

export interface PcmSource {
  numberOfChannels: number
  sampleRate: number
  length: number
  getChannelData(ch: number): Float32Array | number[]
}

/** частота декода: нативная для нашего пайплайна (44.1к), НЕ rate устройства */
export const WAV_SAMPLE_RATE = 44100

/** PCM -> 16-бит WAV (чистая функция, тестируется в node без DOM). */
export function encodeWavBytes(src: PcmSource): ArrayBuffer {
  const ch = Math.max(1, Math.min(2, src.numberOfChannels | 0))
  const sr = Math.max(1, src.sampleRate | 0)
  const len = Math.max(0, src.length | 0)
  const buf = new ArrayBuffer(44 + len * ch * 2)
  const v = new DataView(buf)
  const wstr = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  wstr(0, 'RIFF')
  v.setUint32(4, 36 + len * ch * 2, true)
  wstr(8, 'WAVE')
  wstr(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, ch, true)
  v.setUint32(24, sr, true)
  v.setUint32(28, sr * ch * 2, true)
  v.setUint16(32, ch * 2, true)
  v.setUint16(34, 16, true)
  wstr(36, 'data')
  v.setUint32(40, len * ch * 2, true)
  let off = 44
  const chans: (Float32Array | number[])[] = []
  for (let c = 0; c < ch; c++) chans.push(src.getChannelData(Math.min(c, src.numberOfChannels - 1)))
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = chans[c][i] ?? 0
      const q = Math.max(-1, Math.min(1, s))
      v.setInt16(off, q < 0 ? Math.round(q * 32768) : Math.round(q * 32767), true)
      off += 2
    }
  }
  return buf
}

export function encodeWavBlobUrl(src: PcmSource): string {
  return URL.createObjectURL(new Blob([encodeWavBytes(src)], { type: 'audio/wav' }))
}

/**
 * Скачать mp3, декодировать на фиксированных 44100 Гц и вернуть WAV blob-URL.
 * Офлайн-контекст: жест не нужен, rate устройства не влияет.
 * Владение blob-URL — у вызывателя (revoke при выходе).
 */
export async function mp3UrlToWavBlobUrl(
  url: string,
  onDownload?: (pct: number) => void,
): Promise<string> {
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`)
  const total = Number(r.headers.get('content-length') || 0)
  let bytes: ArrayBuffer
  if (r.body && total > 0 && onDownload) {
    const reader = r.body.getReader()
    const chunks: Uint8Array[] = []
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        got += value.length
        onDownload(Math.round((got / total) * 100))
      }
    }
    const all = new Uint8Array(got)
    let o = 0
    for (const c of chunks) {
      all.set(c, o)
      o += c.length
    }
    bytes = all.buffer as ArrayBuffer
  } else {
    bytes = await r.arrayBuffer()
    onDownload?.(100)
  }
  // ВАЖНО: декодируем офлайн-контекстом на фиксированных 44100 Гц.
  // Обычный AudioContext наследует rate устройства вывода — на Bluetooth-гарнитуре
  // в режиме звонка это 8/16 кГц, и «точное» WAV навсегда оставалось бы телефонным.
  const ctx = new OfflineAudioContext(2, 1, WAV_SAMPLE_RATE)
  const audio = await ctx.decodeAudioData(bytes)
  return encodeWavBlobUrl(audio)
}
