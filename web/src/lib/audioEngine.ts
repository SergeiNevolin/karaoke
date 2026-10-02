/**
 * Аудио-движок редактора: два элемента (вокал + минус), один мастер-час (вокал).
 *
 * Правила, которые здесь зафиксированы раз и навсегда:
 * 1. Обе дорожки всегда мотаются на ОДНУ явную цель — никаких чтений
 *    «текущей позиции» одного элемента для позиционирования другого.
 * 2. playFrom дожидается завершения seek ОБЕИХ дорожек (событие seeked /
 *    таймаут), и только потом зовёт play() — иначе с рандомной позиции
 *    вокал стартует раньше минуса.
   * 3. Проверка долёта дожимает зависшие часы; двигающийся, но не у цели
   *    вокал и минус подтягиваются после grace-периода; минус ещё и
   *    дозором дрифта (|V−M|).
 * 4. Неустранимое расхождение — честная остановка с диагнозом, а не тихое враньё.
 * 5. Промисы play() привязаны к поколению (seq): опоздавшие игнорируются.
 *
 * Всё браузерное инжектится через deps — движок полностью тестируем в node.
 */

export interface EngineAudioElement {
  src: string
  currentTime: number
  paused: boolean
  playbackRate: number
  volume: number
  muted: boolean
  readyState: number
  preservesPitch?: boolean
  play(): Promise<void>
  pause(): void
  load(): void
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: string, listener: () => void): void
}

export interface EngineEvents {
  onPlayingChange?: (playing: boolean) => void
  onTime?: (t: number) => void
  onProgress?: (pct: number) => void
  onReady?: (minus: boolean) => void
  onStuck?: (which: 'vocals' | 'minus') => void
  onError?: (msg: string) => void
  /** минус не загрузился (с причиной) — показать статус и кнопку повтора */
  onMinusError?: (msg: string) => void
}

export interface EngineDeps {
  createAudio: () => EngineAudioElement
  requestFrame: (cb: () => void) => number
  cancelFrame: (id: number) => void
  now: () => number
  fetchImpl: typeof fetch
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
  /** сколько ждать события seeked, мс (0 — не ждать; в тестах 0) */
  seekTimeoutMs?: number
}

export interface LoopRegion {
  start: number
  end: number
}

interface SeekTarget {
  t: number
  lastA: number
  lastM: number
  lastTry: number
  stuckA: number
  stuckM: number
  armedAt: number
}

const TOLERANCE = 0.05 // часы в пределах 50мс — считаем долетевшими
const FROZEN_EPS = 0.02 // часы сдвинулись меньше — считаем зависшими
const RETRY_MS = 500 // не чаще
const GIVE_UP_STUCKS = 5 // ~2.5с зависший элемент — сдаёмся
const EMIT_STEP = 0.005 // троттлинг onTime (5мс — индикатор времени в редакторе идёт плавно)
const GRACE_MS = 500 // после этой выдержки двигающийся «мимо» элемент дожимаем
const DRIFT_LIMIT = 0.05 // |V−M| больше 50мс — дозор подтягивает минус
const DRIFT_THROTTLE_MS = 500 // не чаще дрифт-фикса
const SEEK_TIMEOUT_MS = 800 // дефолт ожидания seeked (VBR-мотание бывает долгим)

export class EditorAudioEngine {
  readonly vocals: EngineAudioElement
  readonly minus: EngineAudioElement

  private events: EngineEvents
  private deps: EngineDeps
  private raf = 0
  private seq = 0
  private stop: { t: number; seq: number } | null = null
  private target: SeekTarget | null = null
  private loop: LoopRegion | null = null
  private playing = false
  private lastTime = 0
  private lastEmit = -1
  private destroyed = false
  private blobUrls: string[] = []

  private rate = 1
  private volume = 1
  private vocalLevel = 1
  private mixMode: 'vocals' | 'full' = 'vocals'
  private minusUrl: string | null = null
  private seekTimeoutMs: number
  private lastDriftFix = -Infinity

  constructor(events: EngineEvents = {}, deps: Partial<EngineDeps> = {}) {
    this.events = events
    this.seekTimeoutMs = deps.seekTimeoutMs ?? SEEK_TIMEOUT_MS
    // Дефолты — ленивые замыкания: в node без DOM конструктор не должен ничего трогать
    this.deps = {
      createAudio: deps.createAudio ?? (() => document.createElement('audio')),
      requestFrame: deps.requestFrame ?? ((cb) => requestAnimationFrame(cb)),
      cancelFrame: deps.cancelFrame ?? ((id) => cancelAnimationFrame(id)),
      now: deps.now ?? (() => performance.now()),
      // ВАЖНО: голый `fetch` нельзя класть как есть — вызов method-style
      // (deps.fetchImpl(url)) уронит его с Illegal invocation, т.к. this
      // окажется не Window. Только стрелка с обычным вызовом.
      fetchImpl: deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
      createObjectURL: deps.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b)),
      revokeObjectURL: deps.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u)),
      seekTimeoutMs: this.seekTimeoutMs,
    }
    this.vocals = this.deps.createAudio()
    this.minus = this.deps.createAudio()
  }

  // ---------- загрузка ----------

  async load(vocalsUrl: string | null, minusUrl: string | null): Promise<void> {
    this.pause()
    this.blobUrls.forEach((u) => this.deps.revokeObjectURL(u))
    this.blobUrls = []
    this.minusUrl = minusUrl
    if (!vocalsUrl) {
      this.events.onError?.('нет вокала')
      return
    }
    let pv = 0
    let pm = 0
    // без минуса второй счётчик всегда 0 — делить на 2 нельзя (потолок 50%)
    const paint = () => this.events.onProgress?.(minusUrl ? Math.round((pv + pm) / 2) : pv)
    let minusError: string | null = null
    const [vok, min] = await Promise.all([
      this.loadOne(vocalsUrl, this.vocals, (p) => {
        pv = p
        paint()
      }).catch(() => false),
      minusUrl
        ? this.loadOne(minusUrl, this.minus, (p) => {
            pm = p
            paint()
          }).catch((e: unknown) => {
            minusError = e instanceof Error ? e.message : String(e)
            return false
          })
        : Promise.resolve(false),
    ])
    if (this.destroyed) return
    if (vok) {
      await this.waitCanplay(this.vocals)
      if (!this.destroyed) this.events.onReady?.(false)
    }
    if (min) {
      await this.waitCanplay(this.minus)
      if (!this.destroyed) this.events.onReady?.(true)
    } else if (minusError && !this.destroyed) {
      this.events.onMinusError?.(minusError)
    }
    if (!vok && !this.destroyed) {
      // запасной вариант: стрим напрямую
      this.vocals.src = vocalsUrl
      await this.waitCanplay(this.vocals)
      if (!this.destroyed) this.events.onReady?.(false)
    }
  }

  /** повторить загрузку минуса (кнопка/авто-ретрай). Возвращает успех. */
  async retryMinus(): Promise<boolean> {
    if (!this.minusUrl || this.destroyed) return false
    try {
      const ok = await this.loadOne(this.minusUrl, this.minus, () => undefined)
      if (!ok || this.destroyed) return false
      await this.waitCanplay(this.minus)
      if (this.destroyed) return false
      this.events.onReady?.(true)
      return true
    } catch (e: unknown) {
      if (!this.destroyed) {
        this.events.onMinusError?.(e instanceof Error ? e.message : String(e))
      }
      return false
    }
  }

  private async loadOne(
    url: string,
    el: EngineAudioElement,
    onProg: (pct: number) => void,
  ): Promise<boolean> {
    if (url.startsWith('blob:')) {
      // внешний blob (напр. WAV из декодера редактора): забираем как есть,
      // fetch не нужен; revoke остаётся заботой владельца URL
      el.src = url
      el.load()
      onProg(100)
      return true
    }    // no-store: всегда свежие байты мимо HTTP-кэша — лечит отравленный
    // кэш (когда-то отданный 404). Файлы локальные, докачка быстрая.
    const r = await this.deps.fetchImpl(url, { cache: 'no-store' } as RequestInit)
    if (!r.ok || !r.body) {
      const name = url.split('/').pop() ?? url
      throw new Error(`${name}: HTTP ${r.status}`)
    }
    const total = Number(r.headers.get('content-length') || 0)
    const reader = r.body.getReader()
    const chunks: BlobPart[] = []
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      got += value.length
      if (total > 0) onProg(Math.round((got / total) * 100))
    }
    const obj = this.deps.createObjectURL(new Blob(chunks, { type: 'audio/mpeg' }))
    this.blobUrls.push(obj)
    el.src = obj
    el.load()
    return true
  }

  private waitCanplay(el: EngineAudioElement): Promise<void> {
    return new Promise((res) => {
      if (el.readyState >= 3) return res()
      const to = setTimeout(res, 8000)
      el.addEventListener(
        'canplay',
        () => {
          clearTimeout(to)
          res()
        },
        { once: true },
      )
    })
  }

  // ---------- настройки ----------

  setRate(rate: number): void {
    this.rate = rate
    this.applyProps()
  }

  setVolume(volume: number, vocalLevel: number): void {
    this.volume = volume
    this.vocalLevel = vocalLevel
    this.applyProps()
  }

  setMixMode(mode: 'vocals' | 'full'): void {
    this.mixMode = mode
    this.applyProps()
    // включаем микс, а минус стоит на паузе (старый останов/отклонённый play) —
    // размьют одного молчуна не даст: догоняем и стартуем явно
    const m = this.minus
    if (mode === 'full' && m.src && this.playing && m.paused) {
      try {
        m.currentTime = this.vocals.currentTime
      } catch {
        /* ignore */
      }
      void m.play().catch(() => undefined)
    }
  }

  setLoop(region: LoopRegion | null): void {
    this.loop = region
  }

  private applyProps(): void {
    this.vocals.playbackRate = this.rate
    this.vocals.volume = this.volume * this.vocalLevel
    if ('preservesPitch' in this.vocals) this.vocals.preservesPitch = true
    this.minus.playbackRate = this.rate
    this.minus.volume = this.volume
    this.minus.muted = this.mixMode === 'vocals'
    if ('preservesPitch' in this.minus) this.minus.preservesPitch = true
  }

  // ---------- транспорт ----------

  /** часы вокала (мастер) */
  getTime(): number {
    return this.lastTime
  }

  getClocks(): { v: number; m: number | null } {
    return {
      v: this.vocals.currentTime,
      m: this.minus.src ? this.minus.currentTime : null,
    }
  }

  isPlaying(): boolean {
    return this.playing
  }

  hasMinus(): boolean {
    return Boolean(this.minus.src)
  }

  private trySeek(el: EngineAudioElement, t: number): boolean {
    if (!el.src) return true
    try {
      el.currentTime = t
      return true
    } catch {
      return false
    }
  }

  /**
   * Мотать и дождаться завершения seek (seeked или таймаут).
   * Без этого play() стартует в разное время у обеих дорожек.
   */
  private seekEl(el: EngineAudioElement, t: number): Promise<void> {
    if (!el.src) return Promise.resolve()
    const target = Math.max(0, t)
    try {
      el.currentTime = target
    } catch {
      return Promise.resolve()
    }
    // FakeAudio / синхронный seek: уже на месте
    if (Math.abs(el.currentTime - target) < 0.001) return Promise.resolve()
    // в тестах (seekTimeoutMs=0) не ждём — checkTarget дожмёт
    if (this.seekTimeoutMs <= 0) return Promise.resolve()
    return new Promise<void>((res) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(to)
        el.removeEventListener('seeked', finish)
        // браузер может объявить seeked, но часы ещё не у цели (VBR/TOC) —
        // одна короткая доводка, дальше разберёт checkTarget
        if (Math.abs(el.currentTime - target) >= 0.001) {
          try {
            el.currentTime = target
          } catch {
            /* ignore */
          }
        }
        res()
      }
      const to = setTimeout(finish, this.seekTimeoutMs)
      el.addEventListener('seeked', finish, { once: true })
      // гонка: seek мог завершиться между set и подпиской
      if (Math.abs(el.currentTime - target) < 0.001) finish()
    })
  }

  private armTarget(t: number): void {
    this.target = {
      t,
      lastA: NaN,
      lastM: NaN,
      lastTry: 0,
      stuckA: 0,
      stuckM: 0,
      armedAt: this.deps.now(),
    }
  }

  /**
   * Запустить звук с позиции. Возвращает false, если играть нечего/нечем
   * (звук ещё грузится) — тогда ничего не трогаем вообще.
   */
  playFrom(t: number, opts: { stopAt?: number | null } = {}): boolean {
    if (!this.vocals.src || this.vocals.readyState < 1) {
      this.events.onError?.('loading')
      return false
    }
    // минус с src, но ещё не декодирован — старт с рандома разъедет дорожки
    if (this.minus.src && this.minus.readyState < 1) {
      this.events.onError?.('loading')
      return false
    }
    const from = Math.max(0, t)
    this.lastTime = from
    this.lastEmit = from
    this.events.onTime?.(from)
    this.armTarget(from)
    const s = ++this.seq
    this.stop = opts.stopAt == null ? null : { t: opts.stopAt, seq: s }
    void this.seekBothThenStart(s, from)
    return true
  }

  /** продолжить с текущей позиции, сведя обе дорожки */
  resume(): boolean {
    return this.playFrom(this.lastTime, { stopAt: null })
  }

  /**
   * Перемотать обе дорожки без старта (для скраба). Возвращает false,
   * если мотать рано — тогда ничего не трогаем вообще.
   */
  seek(t: number): boolean {
    if (!this.vocals.src || this.vocals.readyState < 1) {
      this.events.onError?.('loading')
      return false
    }
    if (this.minus.src && this.minus.readyState < 1) {
      this.events.onError?.('loading')
      return false
    }
    this.stop = null
    // отменяем in-flight playFrom, чтобы он не стартанул на старой цели
    this.seq++
    const tt = Math.max(0, t)
    this.trySeek(this.vocals, tt)
    this.trySeek(this.minus, tt)
    this.lastTime = tt
    this.lastEmit = tt
    this.events.onTime?.(tt)
    this.armTarget(tt)
    return true
  }

  private async seekBothThenStart(s: number, from: number): Promise<void> {
    await Promise.all([this.seekEl(this.vocals, from), this.seekEl(this.minus, from)])
    if (this.destroyed || this.seq !== s) return
    this.startElements(s)
  }

  private startElements(s: number): void {
    const jobs: Promise<void>[] = [this.vocals.play()]
    if (this.minus.src) {
      // немедленный один ретрай: отклонённый play после seek ждать checkTarget (500мс) — дыра
      jobs.push(
        this.minus.play().catch(() => {
          if (this.destroyed || this.seq !== s) return undefined
          return this.minus.play().catch(() => undefined)
        }),
      )
    }
    void Promise.all(jobs).then(
      () => {
        if (this.destroyed || this.seq !== s) return
        this.setPlaying(true)
      },
      () => {
        if (this.destroyed || this.seq !== s) return
        this.setPlaying(false)
        // честно сообщаем, а не молчим: иначе клик «играет», а звука нет
        // (заблокированный автоплей, битый src) — UI покажет причину
        this.events.onError?.('blocked')
      },
    )
  }

  pause(): void {
    this.seq++
    this.stop = null
    this.target = null
    this.vocals.pause()
    this.minus.pause()
    this.setPlaying(false)
  }

  private setPlaying(v: boolean): void {
    if (this.playing === v) return
    this.playing = v
    if (v) {
      this.deps.cancelFrame(this.raf)
      this.raf = this.deps.requestFrame(this.tick)
    } else {
      this.deps.cancelFrame(this.raf)
    }
    this.events.onPlayingChange?.(v)
  }

  destroy(): void {
    this.destroyed = true
    this.deps.cancelFrame(this.raf)
    try {
      this.vocals.pause()
      this.minus.pause()
    } catch {
      /* ignore */
    }
    this.blobUrls.forEach((u) => {
      try {
        this.deps.revokeObjectURL(u)
      } catch {
        /* ignore */
      }
    })
    this.blobUrls = []
  }

  // ---------- цикл ----------

  private lastWatch = 0

  private tick = (): void => {
    if (this.destroyed) return
    const t = this.vocals.currentTime
    this.lastTime = t
    if (Math.abs(t - this.lastEmit) >= EMIT_STEP) {
      this.lastEmit = t
      this.events.onTime?.(t)
    }
    this.checkTarget(t)
    if (this.destroyed) return
    if (this.checkStop(t)) return // встали на паузу — следующий кадр не планируем
    this.checkLoop(t)
    this.watchSync(t)
    this.watchDrift(t)
    this.raf = this.deps.requestFrame(this.tick)
  }

  /**
   * Дозор: пока играем в миксе, отвалившийся (вставший на паузу) элемент
   * возвращаем в строй. Без шторма — не чаще раза в 1.5с.
   */
  private watchSync(t: number): void {
    if (this.mixMode !== 'full') return
    const m = this.minus
    if (!m.src) return
    const now = this.deps.now()
    if (now - this.lastWatch < 1500) return
    const v = this.vocals
    if (!v.paused && m.paused) {
      this.lastWatch = now
      try {
        m.currentTime = t
      } catch {
        /* ignore */
      }
      void m.play().catch(() => undefined)
    } else if (v.paused && !m.paused) {
      this.lastWatch = now
      try {
        v.currentTime = m.currentTime
      } catch {
        /* ignore */
      }
      void v.play().catch(() => undefined)
    }
  }

  /**
   * Дрифт-дозор: обе играют, но разъехались сильнее DRIFT_LIMIT —
   * подтягиваем минус к мастер-часам вокала. Работает в любом mixMode,
   * чтобы переключение на «Микс» не вскрывало накопленный рассинхрон.
   * При активной цели молчит — её разбирает checkTarget/луп.
   */
  private watchDrift(_t: number): void {
    if (this.target) return
    const m = this.minus
    if (!m.src || m.paused || this.vocals.paused) return
    const t = this.vocals.currentTime // свежие часы мастера, не кадровая копия
    const now = this.deps.now()
    if (now - this.lastDriftFix < DRIFT_THROTTLE_MS) return
    const mT = m.currentTime
    if (Math.abs(t - mT) <= DRIFT_LIMIT) return
    this.lastDriftFix = now
    try {
      m.currentTime = t
    } catch {
      /* ignore */
    }
  }

  private checkTarget(t: number): void {
    const st = this.target
    if (!st) return
    const m = this.minus
    const now = this.deps.now()
    const aT = t
    const mT = m.src ? m.currentTime : st.t
    const aOk = Math.abs(aT - st.t) < TOLERANCE
    const mOk = !m.src || Math.abs(mT - st.t) < TOLERANCE
    if (aOk && mOk) {
      this.target = null
      return
    }
    // обе играют, сошлись с целью — цель достигнута (в т.ч. когда уже прошли её)
    const bothLive = !this.vocals.paused && !!m.src && !m.paused
    if (bothLive && Math.abs(aT - mT) < 0.12 && aT >= st.t - TOLERANCE && mT >= st.t - TOLERANCE) {
      this.target = null
      return
    }
    if (now - st.lastTry <= RETRY_MS) return
    st.lastTry = now
    const aFrozen = Math.abs(aT - st.lastA) < FROZEN_EPS
    const mFrozen = !m.src || Math.abs(mT - st.lastM) < FROZEN_EPS
    st.lastA = aT
    st.lastM = mT
    if (!aOk) {
      if (aFrozen) {
        st.stuckA += 1
        this.trySeek(this.vocals, st.t)
      } else if (aT < st.t - TOLERANCE && now - st.armedAt > GRACE_MS) {
        // играет, но позади цели дольше grace — дожимаем (не тащим назад,
        // если уже прошли цель: там решают bothLive/дрифт)
        st.stuckA += 1
        this.trySeek(this.vocals, st.t)
      } else {
        st.stuckA = 0
      }
    }
    if (!mOk) {
      if (m.paused) {
        // отвалившийся элемент seek'ом не чинится — возвращаем play'ем
        st.stuckM += 1
        this.trySeek(m, st.t)
        void m.play().catch(() => undefined)
      } else if (mFrozen) {
        st.stuckM += 1
        this.trySeek(m, st.t)
      } else if (now - st.armedAt > GRACE_MS) {
        // играет, но мимо цели дольше grace — жёстко дожимаем (раньше: ничего)
        st.stuckM += 1
        this.trySeek(m, Math.abs(aT - st.t) < TOLERANCE ? st.t : aT)
      } else {
        st.stuckM = 0
      }
    }
    if (st.stuckA > GIVE_UP_STUCKS || st.stuckM > GIVE_UP_STUCKS) {
      const vocalsBad = st.stuckA > GIVE_UP_STUCKS
      const minusBad = st.stuckM > GIVE_UP_STUCKS
      const needMinus = this.mixMode === 'full'
      this.target = null
      if (vocalsBad || (minusBad && needMinus)) {
        this.pause()
        this.events.onStuck?.(vocalsBad ? 'vocals' : 'minus')
      }
      // в режиме вокала отставший приглушённый минус не мешает — едем дальше молча;
      // его всё равно поймает watchDrift, когда оба играют
    }
  }

  private checkStop(t: number): boolean {
    const stop = this.stop
    if (!stop || stop.seq !== this.seq || t < stop.t) return false
    this.stop = null
    this.target = null
    this.vocals.pause()
    this.minus.pause()
    this.setPlaying(false)
    return true
  }

  private checkLoop(t: number): void {
    const L = this.loop
    if (!L || t <= L.end) return
    this.trySeek(this.vocals, L.start)
    this.trySeek(this.minus, L.start)
    this.armTarget(L.start)
  }
}
