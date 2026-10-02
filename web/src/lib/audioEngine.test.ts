import { describe, expect, it } from 'vitest'
import { EditorAudioEngine, type EngineAudioElement } from './audioEngine'

/** управляемый мок медиа-элемента: часы двигаем руками */
class FakeAudio {
  src = ''
  readyState = 4
  paused = true
  playbackRate = 1
  volume = 1
  muted = false
  preservesPitch = true
  plays = 0
  pauses = 0
  playMode: 'ok' | 'reject' = 'ok'
  failSeek = false
  seeks: number[] = []
  listeners = new Map<string, Array<() => void>>()
  private t = 0

  get currentTime(): number {
    return this.t
  }
  set currentTime(v: number) {
    this.seeks.push(v)
    if (this.failSeek) return // молча не применяем — как зависший элемент
    this.t = v
  }
  /** тест двигает часы напрямую, минуя лог seek'ов */
  setClock(v: number): void {
    this.t = v
  }
  async play(): Promise<void> {
    this.plays++
    if (this.playMode === 'reject') throw new Error('blocked')
    this.paused = false
  }
  pause(): void {
    this.pauses++
    this.paused = true
  }
  load(): void {}
  addEventListener(type: string, fn: () => void): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }
  removeEventListener(type: string, fn: () => void): void {
    const arr = this.listeners.get(type) ?? []
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
  }
  fire(type: string): void {
    const arr = this.listeners.get(type) ?? []
    this.listeners.set(type, [])
    arr.forEach((fn) => fn())
  }
}

function harness() {
  const frames = new Map<number, () => void>()
  let fid = 0
  let now = 0
  const vocals = new FakeAudio()
  const minus = new FakeAudio()
  const log: Record<string, unknown[][]> = {
    playing: [],
    time: [],
    stuck: [],
    error: [],
    progress: [],
    ready: [],
  }
  let n = 0
  const eng = new EditorAudioEngine(
    {
      onPlayingChange: (v) => log.playing.push([v]),
      onTime: (t) => log.time.push([t]),
      onStuck: (w) => log.stuck.push([w]),
      onError: (m) => log.error.push([m]),
      onProgress: (p) => log.progress.push([p]),
      onReady: (m) => log.ready.push([m]),
    },
    {
      createAudio: () => {
        n++
        return (n === 1 ? vocals : minus) as unknown as EngineAudioElement
      },
      requestFrame: (cb) => {
        fid++
        frames.set(fid, cb)
        return fid
      },
      cancelFrame: (id) => {
        frames.delete(id)
      },
      now: () => now,
      fetchImpl: (async () => {
        throw new Error('no fetch in unit tests')
      }) as typeof fetch,
      createObjectURL: () => 'blob:x',
      revokeObjectURL: () => undefined,
      seekTimeoutMs: 0,
    },
  )
  vocals.src = 'v.mp3'
  minus.src = 'm.mp3'
  const runFrames = (count: number): void => {
    for (let i = 0; i < count; i++) {
      const cbs = [...frames.values()]
      frames.clear()
      cbs.forEach((cb) => cb())
    }
  }
  const advance = (ms: number): void => {
    now += ms
  }
  const flush = async (): Promise<void> => {
    // качаем микротаски, пока движок не перейдёт в playing (детерминированно)
    for (let i = 0; i < 50; i++) {
      await Promise.resolve()
      if (eng.isPlaying()) break
    }
  }
  return { eng, vocals, minus, log, runFrames, advance, flush, frames }
}

describe('EditorAudioEngine: транспорт', () => {
  it('playFrom мотает обе дорожки на одну цель и стартует обе', async () => {
    const h = harness()
    expect(h.eng.playFrom(42, { stopAt: 50 })).toBe(true)
    await h.flush()
    expect(h.vocals.seeks).toEqual([42])
    expect(h.minus.seeks).toEqual([42])
    expect(h.vocals.plays).toBe(1)
    expect(h.minus.plays).toBe(1)
    expect(h.log.playing).toEqual([[true]])
    expect(h.log.time[0]).toEqual([42])
  })

  it('без src ничего не делает и сообщает об ошибке', () => {
    const h = harness()
    h.vocals.src = ''
    expect(h.eng.playFrom(10)).toBe(false)
    expect(h.vocals.plays).toBe(0)
    expect(h.log.error).toEqual([['loading']])
  })

  it('минус с src, но readyState=0 — старт с рандома блокируем', () => {
    const h = harness()
    h.minus.readyState = 0
    expect(h.eng.playFrom(10)).toBe(false)
    expect(h.vocals.plays).toBe(0)
    expect(h.log.error).toEqual([['loading']])
  })

  it('stopAt останавливает обе дорожки', async () => {
    const h = harness()
    h.eng.playFrom(10, { stopAt: 12 })
    await h.flush()
    h.vocals.setClock(12.5)
    h.runFrames(1)
    expect(h.vocals.paused).toBe(true)
    expect(h.minus.paused).toBe(true)
    expect(h.log.playing[h.log.playing.length - 1]).toEqual([false])
  })

  it('повторный playFrom гасит первое поколение (гонка play-промисов)', async () => {
    const h = harness()
    h.eng.playFrom(10)
    h.eng.playFrom(50) // до резолва первого play
    await h.flush()
    h.vocals.setClock(50.1)
    h.runFrames(3)
    // жив только второй запуск: время идёт, пауз нет
    expect(h.vocals.paused).toBe(false)
    expect(h.log.playing).toEqual([[true]])
  })

  it('resume возвращается к последнему времени', () => {
    const h = harness()
    h.eng.playFrom(20)
    h.eng.pause()
    h.vocals.setClock(99) // кто-то сдвинул часы снаружи
    h.eng.resume()
    expect(h.vocals.seeks[h.vocals.seeks.length - 1]).toBe(20)
  })

  it('pause останавливает всё и чистит цели', async () => {
    const h = harness()
    h.eng.playFrom(10, { stopAt: 50 })
    await h.flush()
    h.eng.pause()
    expect(h.vocals.paused).toBe(true)
    expect(h.minus.paused).toBe(true)
    expect(h.log.playing[h.log.playing.length - 1]).toEqual([false])
    const framesBefore = h.frames.size
    h.runFrames(3)
    expect(h.frames.size).toBe(framesBefore) // новых кадров нет
  })

  it('playFrom ждёт завершения seek обеих дорожек перед play()', async () => {
    // элемент, у которого seek применяется только по fire('seeked')
    class AsyncSeekAudio extends FakeAudio {
      private pending: number | null = null
      override set currentTime(v: number) {
        this.seeks.push(v)
        this.pending = v
      }
      applySeek(): void {
        if (this.pending == null) return
        ;(this as unknown as { t: number }).t = this.pending
        this.pending = null
        this.fire('seeked')
      }
    }
    const frames = new Map<number, () => void>()
    let fid = 0
    const vocals = new AsyncSeekAudio()
    const minus = new AsyncSeekAudio()
    let n = 0
    const eng = new EditorAudioEngine(
      {},
      {
        createAudio: () => (n++ === 0 ? vocals : minus) as unknown as EngineAudioElement,
        requestFrame: (cb) => {
          fid++
          frames.set(fid, cb)
          return fid
        },
        cancelFrame: (id) => frames.delete(id),
        now: () => 0,
        fetchImpl: (async () => {
          throw new Error('no')
        }) as typeof fetch,
        createObjectURL: () => 'blob:x',
        revokeObjectURL: () => undefined,
        seekTimeoutMs: 5000,
      },
    )
    vocals.src = 'v.mp3'
    minus.src = 'm.mp3'
    expect(eng.playFrom(77)).toBe(true)
    await Promise.resolve()
    expect(vocals.plays).toBe(0) // ждём seeked, play ещё не зван
    expect(minus.plays).toBe(0)
    vocals.applySeek()
    await Promise.resolve()
    expect(vocals.plays).toBe(0) // минус ещё не долетел — общий старт
    minus.applySeek()
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(vocals.plays).toBe(1)
    expect(minus.plays).toBe(1)
    expect(vocals.seeks).toEqual([77])
    expect(minus.seeks).toEqual([77])
    eng.destroy()
  })

  it('single-track (оригинал): тап → скраб → тап, звук стартует каждый раз', async () => {
    const h = harness()
    h.minus.src = '' // минуса нет — одна дорожка
    // тап по произвольной позиции
    expect(h.eng.playFrom(30, { stopAt: null })).toBe(true)
    await h.flush()
    expect(h.vocals.plays).toBe(1)
    expect(h.minus.plays).toBe(0)
    expect(h.eng.isPlaying()).toBe(true)
    // скраб во время игры: мотаем, игра продолжается
    h.vocals.setClock(30.5)
    expect(h.eng.seek(60)).toBe(true)
    h.vocals.setClock(60.1)
    h.runFrames(3)
    expect(h.eng.isPlaying()).toBe(true)
    // пауза и новый тап в другое место
    h.eng.pause()
    expect(h.eng.playFrom(90, { stopAt: null })).toBe(true)
    await h.flush()
    expect(h.vocals.plays).toBe(2)
    expect(h.eng.isPlaying()).toBe(true)
    expect(h.vocals.seeks).toContain(90)
  })

  it('отклонённый play() сообщает blocked, а не молчит', async () => {
    const h = harness()
    h.minus.src = ''
    h.vocals.playMode = 'reject'
    expect(h.eng.playFrom(10)).toBe(true)
    await h.flush()
    expect(h.eng.isPlaying()).toBe(false)
    expect(h.vocals.plays).toBe(1)
    expect(h.log.error).toEqual([['blocked']])
  })
})

describe('EditorAudioEngine: проверка долёта', () => {
  it('медленно долетающий элемент НЕ дёргаем повторными seek (нет шторма)', async () => {
    const h = harness()
    h.eng.playFrom(100)
    await h.flush()
    // вокал долетает постепенно, минус мгновенно
    h.vocals.setClock(100)
    h.minus.setClock(100)
    h.runFrames(1)
    const seeksAfterLand = h.vocals.seeks.length
    // играем дальше маленькими шагами — лишних seek быть не должно
    for (let i = 0; i < 5; i++) {
      h.vocals.setClock(100 + (i + 1) * 0.1)
      h.minus.setClock(100 + (i + 1) * 0.1)
      h.advance(100)
      h.runFrames(1)
    }
    expect(h.vocals.seeks.length).toBe(seeksAfterLand)
    expect(h.minus.seeks.length).toBe(1)
    expect(h.vocals.paused).toBe(false)
  })

  it('зависший вокал: дожимаем, потом честная остановка с диагнозом', async () => {
    const h = harness()
    h.vocals.failSeek = true // seek'и не применяются, часы стоят
    h.eng.playFrom(100)
    await h.flush()
    h.runFrames(1) // первая проверка фиксирует часы
    for (let i = 0; i < 12; i++) {
      h.advance(600)
      h.runFrames(1)
    }
    expect(h.vocals.seeks.length).toBeGreaterThan(1) // дожимали
    expect(h.vocals.paused).toBe(true)
    expect(h.log.stuck).toEqual([['vocals']])
  })

  it('отвалившийся минус в режиме вокала не останавливает пение', async () => {
    const h = harness()
    h.eng.playFrom(30)
    await h.flush()
    h.vocals.setClock(30)
    h.minus.paused = true // play минуса отклонён
    h.minus.failSeek = true
    for (let i = 0; i < 12; i++) {
      h.advance(600)
      h.vocals.setClock(30 + i * 0.5) // вокал идёт
      h.runFrames(1)
    }
    expect(h.vocals.paused).toBe(false) // поём дальше
    expect(h.log.stuck).toEqual([]) // и молчим — минус приглушён
  })

  it('отвалившийся минус в режиме микса останавливает с диагнозом', async () => {
    const h = harness()
    h.eng.setMixMode('full')
    h.minus.failSeek = true // seek'и минуса не применяются с самого начала
    h.eng.playFrom(30)
    await h.flush()
    h.vocals.setClock(30)
    h.minus.paused = true // элемент ещё и отвалился
    for (let i = 0; i < 12; i++) {
      h.advance(600)
      h.vocals.setClock(30 + i * 0.5)
      h.runFrames(1)
    }
    expect(h.vocals.paused).toBe(true)
    expect(h.log.stuck).toEqual([['minus']])
  })

  it('минус играет, но не у цели дольше grace — дожимаем повторным seek', async () => {
    const h = harness()
    h.eng.playFrom(100)
    await h.flush()
    h.vocals.setClock(100)
    h.minus.setClock(50) // мимо цели, часы идут (не frozen)
    h.runFrames(1)
    const seeksBefore = h.minus.seeks.length
    // двигаемся вперёд мимо цели — после GRACE жёсткий re-seek
    for (let i = 1; i <= 3; i++) {
      h.advance(600)
      h.vocals.setClock(100 + i * 0.3)
      h.minus.setClock(50 + i * 0.3)
      h.runFrames(1)
    }
    expect(h.minus.seeks.length).toBeGreaterThan(seeksBefore)
    // и дрифт-дозор тоже подтягивает к вокалу, когда оба играют
    const seeksAfterGrace = h.minus.seeks.length
    h.vocals.setClock(110)
    h.minus.setClock(55)
    h.advance(600)
    h.runFrames(1)
    expect(h.minus.seeks.length).toBeGreaterThan(seeksAfterGrace)
    expect(h.minus.currentTime).toBe(110)
  })

  it('вокал играет, но не у цели дольше grace — дожимаем повторным seek', async () => {
    const h = harness()
    h.eng.playFrom(100)
    await h.flush()
    h.minus.setClock(100)
    h.vocals.setClock(80) // мимо цели, часы идут (не frozen)
    h.runFrames(1)
    const seeksBefore = h.vocals.seeks.length
    for (let i = 1; i <= 3; i++) {
      h.advance(600)
      h.minus.setClock(100 + i * 0.3)
      h.vocals.setClock(80 + i * 0.3)
      h.runFrames(1)
    }
    expect(h.vocals.seeks.length).toBeGreaterThan(seeksBefore)
    expect(h.vocals.currentTime).toBe(100)
  })

  it('мс: долёт в пределах 50мс — цель снята, лишних seek нет', async () => {
    const h = harness()
    h.eng.playFrom(100)
    await h.flush()
    // обе дорожки в 30мс и 49мс от цели — в допуске
    h.vocals.setClock(100.03)
    h.minus.setClock(100.049)
    h.runFrames(1)
    const seeksV = h.vocals.seeks.length
    const seeksM = h.minus.seeks.length
    h.advance(600)
    h.vocals.setClock(100.63)
    h.minus.setClock(100.649)
    h.runFrames(1)
    expect(h.vocals.seeks.length).toBe(seeksV)
    expect(h.minus.seeks.length).toBe(seeksM)
    expect(h.eng.isPlaying()).toBe(true)
  })

  it('мс: мимо на 60мс и стоим — дожимаем, а не сдаёмся', async () => {
    const h = harness()
    h.minus.src = '' // одна дорожка: bothLive не вмешивается
    h.eng.playFrom(100)
    await h.flush()
    h.vocals.setClock(100.06) // 60мс мимо цели, стоим
    h.runFrames(1) // первая проверка фиксирует часы
    const seeksBefore = h.vocals.seeks.length
    h.advance(600)
    h.runFrames(1) // RETRY прошёл
    h.advance(600)
    h.runFrames(1) // frozen re-seek
    expect(h.vocals.seeks.length).toBe(seeksBefore + 1)
    expect(h.vocals.seeks[h.vocals.seeks.length - 1]).toBe(100)
    expect(h.eng.isPlaying()).toBe(true)
  })

  it('мс: дрифт 40мс терпим, 60мс подтягиваем', async () => {
    const h = harness()
    h.eng.playFrom(100)
    await h.flush()
    h.vocals.setClock(100)
    h.minus.setClock(100)
    h.runFrames(1) // долетели — цели больше нет
    const seeksBase = h.minus.seeks.length
    h.vocals.setClock(200)
    h.minus.setClock(200.04) // 40мс — в допуске
    h.advance(600)
    h.runFrames(1)
    expect(h.minus.seeks.length).toBe(seeksBase)
    h.vocals.setClock(201)
    h.minus.setClock(201.06) // 60мс — дрифт-дозор чинит
    h.advance(600)
    h.runFrames(1)
    expect(h.minus.seeks.length).toBe(seeksBase + 1)
    expect(h.minus.currentTime).toBe(201)
  })
})

describe('EditorAudioEngine: loop и настройки', () => {  it('виток повтора мотает обе дорожки', async () => {
    const h = harness()
    h.eng.setLoop({ start: 10, end: 12 })
    h.eng.playFrom(10)
    await h.flush()
    h.vocals.setClock(12.5)
    h.minus.setClock(12.5)
    h.runFrames(1)
    expect(h.vocals.seeks[h.vocals.seeks.length - 1]).toBe(10)
    expect(h.minus.seeks[h.minus.seeks.length - 1]).toBe(10)
  })

  it('setLoop(null) отключает повтор', async () => {
    const h = harness()
    h.eng.setLoop({ start: 10, end: 12 })
    h.eng.setLoop(null)
    h.eng.playFrom(10)
    await h.flush()
    h.vocals.setClock(20)
    h.runFrames(1)
    expect(h.vocals.seeks).toEqual([10]) // только стартовый seek
  })

  it('rate/volume/mute раскладываются по элементам', () => {
    const h = harness()
    h.eng.setRate(0.5)
    h.eng.setVolume(0.8, 0.5)
    expect(h.vocals.playbackRate).toBe(0.5)
    expect(h.minus.playbackRate).toBe(0.5)
    expect(h.vocals.volume).toBeCloseTo(0.4)
    expect(h.minus.volume).toBe(0.8)
    expect(h.minus.muted).toBe(true) // режим вокала по умолчанию
    h.eng.setMixMode('full')
    expect(h.minus.muted).toBe(false)
  })

  it('onTime троттлится', async () => {
    const h = harness()
    h.eng.playFrom(10) // +1 emit сразу
    await h.flush()
    const base = h.log.time.length
    for (let i = 1; i <= 4; i++) {
      h.vocals.setClock(10 + i * 0.001) // шаг 1мс — ниже EMIT_STEP (5мс)
      h.runFrames(1)
    }
    expect(h.log.time.length).toBe(base) // ничего лишнего
    h.vocals.setClock(10.004) // 4мс — ещё тихо
    h.runFrames(1)
    expect(h.log.time.length).toBe(base)
    h.vocals.setClock(10.006) // 6мс — эмит
    h.runFrames(1)
    expect(h.log.time.length).toBe(base + 1)
    expect(h.log.time[h.log.time.length - 1]).toEqual([10.006])
  })
})

/** fetch, отдающий байты кусками */
function fakeFetch(bytes: Uint8Array, total?: number, fail = false) {
  return (async (_url?: string) => {
    if (fail) throw new Error('network')
    return {
      ok: true,
      headers: { get: () => (total === undefined ? null : String(total)) },
      body: {
        getReader() {
          let i = 0
          return {
            async read() {
              if (i >= bytes.length) return { done: true, value: undefined }
              const v = bytes.slice(i, i + 3)
              i += 3
              return { done: false, value: v }
            },
            async cancel() {},
          }
        },
      },
    }
  }) as unknown as typeof fetch
}

function loadHarness(vBytes = 10) {
  const h = harness()
  h.vocals.src = ''
  h.minus.src = ''
  const revoked: string[] = []
  const created: string[] = []
  let n = 0
  const eng = new EditorAudioEngine(
    {
      onPlayingChange: (v) => h.log.playing.push([v]),
      onTime: (t) => h.log.time.push([t]),
      onStuck: (w) => h.log.stuck.push([w]),
      onError: (m) => h.log.error.push([m]),
      onProgress: (p) => h.log.progress.push([p]),
      onReady: (m) => h.log.ready.push([m]),
    },
    {
      createAudio: () => {
        n++
        return (n === 1 ? h.vocals : h.minus) as unknown as EngineAudioElement
      },
      requestFrame: (cb) => h.frames.set(999, cb) && 999,
      cancelFrame: (id) => {
        h.frames.delete(id)
      },
      now: () => 0,
      fetchImpl: fakeFetch(new Uint8Array(vBytes), vBytes),
      createObjectURL: () => {
        const u = `blob:${created.length}`
        created.push(u)
        return u
      },
      revokeObjectURL: (u) => {
        revoked.push(u)
      },
      seekTimeoutMs: 0,
    },
  )
  return { ...h, eng, created, revoked }
}

describe('EditorAudioEngine: загрузка', () => {
  it('качает оба файла с прогрессом, кладёт blob, сообщает готовность', async () => {
    const h = loadHarness(9)
    await h.eng.load('http://x/v.mp3', 'http://x/m.mp3')
    expect(h.vocals.src).toMatch(/^blob:/)
    expect(h.minus.src).toMatch(/^blob:/)
    expect(h.log.progress[h.log.progress.length - 1]).toEqual([100])
    expect(h.log.ready).toEqual([[false], [true]])
    // destroy отзывает оба url и останавливает звук
    const pausesBefore = h.vocals.pauses
    h.eng.destroy()
    expect(h.revoked).toHaveLength(2)
    expect(h.vocals.pauses).toBe(pausesBefore + 1)
  })

  it('упавший минус не роняет вокал: готов без микса', async () => {
    const h = loadHarness()
    const vocalsOnly = new EditorAudioEngine(      {
        onReady: (m) => h.log.ready.push([m]),
        onError: (m) => h.log.error.push([m]),
      },
      {
        createAudio: (() => {
          let n = 0
          return () => (n++ === 0 ? h.vocals : h.minus) as unknown as EngineAudioElement
        })(),
        requestFrame: () => 0,
        cancelFrame: () => undefined,
        now: () => 0,
        fetchImpl: (async (url: string) => {
          if (String(url).includes('/m.mp3')) throw new Error('network')
          const fetcher = fakeFetch(new Uint8Array(9), 9)
          return fetcher('http://x/v.mp3')
        }) as unknown as typeof fetch,
        createObjectURL: () => 'blob:v',
        revokeObjectURL: () => undefined,
        seekTimeoutMs: 0,
      },
    )
    await vocalsOnly.load('http://x/v.mp3', 'http://x/m.mp3')
    expect(h.vocals.src).toMatch(/^blob:/)
    expect(h.minus.src).toBe('')
    expect(h.log.ready).toEqual([[false]])
    expect(vocalsOnly.hasMinus()).toBe(false)
    expect(vocalsOnly.playFrom(5)).toBe(true)
  })

  it('внешний blob (WAV из декодера) забирается без fetch', async () => {
    const h = harness()
    h.vocals.src = ''
    h.minus.src = ''
    // fetch вообще запрещён — loadOne не должен его касаться
    await h.eng.load('blob:wav-take', null)
    expect(h.vocals.src).toBe('blob:wav-take')
    expect(h.log.progress[h.log.progress.length - 1]).toEqual([100])
    expect(h.log.ready).toEqual([[false]])
    expect(h.eng.playFrom(1.234)).toBe(true)
  })
})

describe('EditorAudioEngine: дефолтный fetch вызываем любым способом', () => {
  it('голый вызов через deps не роняет brand-check (баг Firefox)', async () => {
    const vocals = new FakeAudio()
    const minus = new FakeAudio()
    let n = 0
    const errors: string[][] = []
    const ready: boolean[][] = []
    // fetch, требующий корректного this — как настоящий в Firefox/Chrome
    const strictFetch = function (this: unknown, input: string) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("'fetch' called on an object that does not implement interface Window.")
      }
      const inner = fakeFetch(new Uint8Array(12), 12)
      return inner(input)
    }
    const origFetch = globalThis.fetch
    globalThis.fetch = strictFetch as unknown as typeof fetch
    try {
      const eng = new EditorAudioEngine(
        {
          onReady: (m) => ready.push([m]),
          onError: (m) => errors.push([m]),
          onMinusError: (m) => errors.push([m]),
        },
        {
          // fetchImpl специально НЕ передаём — проверяем дефолт движка
          createAudio: () => {
            n++
            return (n === 1 ? vocals : minus) as unknown as EngineAudioElement
          },
          requestFrame: () => 0,
          cancelFrame: () => undefined,
          now: () => 0,
          createObjectURL: () => 'blob:x',
          revokeObjectURL: () => undefined,
          seekTimeoutMs: 0,
        },
      )
      await eng.load('http://x/v.mp3', 'http://x/m.mp3')
      expect(vocals.src).toMatch(/^blob:/)
      expect(minus.src).toMatch(/^blob:/)
      expect(ready).toEqual([[false], [true]])
      expect(errors).toEqual([])
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
  function retryHarness(failMinus: () => boolean) {
    const h = harness()
    h.vocals.src = ''
    h.minus.src = ''
    const minusErrors: string[][] = []
    const ready: boolean[][] = []
    let n = 0
    const eng = new EditorAudioEngine(
      {
        onReady: (m) => ready.push([m]),
        onMinusError: (m) => minusErrors.push([m]),
      },
      {
        createAudio: () => {
          n++
          return (n === 1 ? h.vocals : h.minus) as unknown as EngineAudioElement
        },
        requestFrame: () => 0,
        cancelFrame: () => undefined,
        now: () => 0,
        fetchImpl: (async (url: string) => {
          if (String(url).includes('/m.mp3') && failMinus()) {
            return { ok: false, status: 404, headers: { get: () => null }, body: null }
          }
          return fakeFetch(new Uint8Array(9), 9)('http://x/ok')
        }) as unknown as typeof fetch,
        createObjectURL: () => 'blob:x',
        revokeObjectURL: () => undefined,
        seekTimeoutMs: 0,
      },
    )
    return { ...h, eng, minusErrors, ready }
  }

describe('EditorAudioEngine: повтор загрузки минуса', () => {
  it('ошибка минуса при загрузке сообщается с причиной', async () => {
    const h = retryHarness(() => true)
    await h.eng.load('http://x/v.mp3', 'http://x/m.mp3')
    expect(h.minusErrors).toEqual([['m.mp3: HTTP 404']])
    expect(h.eng.hasMinus()).toBe(false)
    // вокал при этом готов
    expect(h.vocals.src).toMatch(/^blob:/)
  })

  it('retryMinus чинит минус после сбоя', async () => {
    let broken = true
    const h = retryHarness(() => broken)
    await h.eng.load('http://x/v.mp3', 'http://x/m.mp3')
    expect(h.eng.hasMinus()).toBe(false)
    broken = false
    expect(await h.eng.retryMinus()).toBe(true)
    expect(h.minus.src).toMatch(/^blob:/)
    expect(h.ready).toContainEqual([true])
  })

  it('retryMinus без URL минуса — false и тихо', async () => {
    const h = retryHarness(() => true)
    await h.eng.load('http://x/v.mp3', null)
    expect(await h.eng.retryMinus()).toBe(false)
    expect(h.minusErrors).toEqual([])
  })
})
