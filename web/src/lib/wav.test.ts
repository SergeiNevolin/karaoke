import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeWavBlobUrl, encodeWavBytes, mp3UrlToWavBlobUrl, type PcmSource } from './wav'

const src = (ch: number, sr: number, data: number[][]): PcmSource => ({
  numberOfChannels: ch,
  sampleRate: sr,
  length: data[0].length,
  getChannelData: (c: number) => Float32Array.from(data[c]),
})

describe('encodeWavBytes', () => {
  it('пишет корректный 16-бит PCM WAV', () => {
    const buf = encodeWavBytes(src(1, 8000, [[0.5, -0.5, 0]]))
    expect(buf.byteLength).toBe(44 + 3 * 2)
    const v = new DataView(buf)
    const str = (o: number, n: number): string =>
      String.fromCharCode(...new Uint8Array(buf, o, n))
    expect(str(0, 4)).toBe('RIFF')
    expect(str(8, 4)).toBe('WAVE')
    expect(str(12, 4)).toBe('fmt ')
    expect(v.getUint16(20, true)).toBe(1) // PCM
    expect(v.getUint16(22, true)).toBe(1)
    expect(v.getUint32(24, true)).toBe(8000)
    expect(v.getUint16(34, true)).toBe(16)
    expect(str(36, 4)).toBe('data')
    expect(v.getInt16(44, true)).toBe(16384) // 0.5
    expect(v.getInt16(46, true)).toBe(-16384) // -0.5
    expect(v.getInt16(48, true)).toBe(0)
  })

  it('стерео интерливится, значения клиппятся', () => {
    const buf = encodeWavBytes(src(2, 44100, [[1, 2], [-1, -2]]))
    const v = new DataView(buf)
    expect(v.getUint16(22, true)).toBe(2)
    expect(v.getInt16(44, true)).toBe(32767) // L0: клип 1
    expect(v.getInt16(46, true)).toBe(-32768) // R0: клип -1
    expect(v.getInt16(48, true)).toBe(32767) // L1: клип 2
    expect(v.getInt16(50, true)).toBe(-32768) // R1: клип -2
  })
})

describe('encodeWavBlobUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('audio/wav blob-URL', () => {
    let got: Blob | null = null
    vi.stubGlobal('URL', { createObjectURL: vi.fn((b: Blob) => ((got = b), 'blob:wav')) } as never)
    const url = encodeWavBlobUrl(src(1, 8000, [[0]]))
    expect(url).toBe('blob:wav')
    expect(got!.type).toBe('audio/wav')
  })
})

describe('mp3UrlToWavBlobUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const pcm = (): PcmSource => ({
    numberOfChannels: 1,
    sampleRate: 44100,
    length: 4,
    getChannelData: () => new Float32Array([0, 0.5, -0.5, 0]),
  })

  const stubAudio = () => {
    function Ctx() {
      return { decodeAudioData: async () => pcm() }
    }
    vi.stubGlobal('OfflineAudioContext', Ctx)
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:wav') } as never)
  }

  it('простой путь: arrayBuffer + прогресс 100', async () => {
    stubAudio()
    const seen: number[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(8) })),
    )
    const url = await mp3UrlToWavBlobUrl('http://x/a.mp3', (p) => seen.push(p))
    expect(url).toBe('blob:wav')
    expect(seen).toEqual([100])
  })

  it('стриминг с content-length: склейка чанков и проценты', async () => {
    stubAudio()
    const seen: number[] = []
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'content-length': '3' }),
        body: {
          getReader: () => {
            let i = 0
            return {
              read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
            }
          },
        },
      })),
    )
    const url = await mp3UrlToWavBlobUrl('http://x/a.mp3', (p) => seen.push(p))
    expect(url).toBe('blob:wav')
    expect(seen).toEqual([67, 100]) // 2/3, 3/3
  })

  it('HTTP-ошибка пробрасывается', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    await expect(mp3UrlToWavBlobUrl('http://x/a.mp3')).rejects.toThrow('HTTP 404')
  })
})
