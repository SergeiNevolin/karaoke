import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, Loader2, Pause, Pencil, Play, RotateCcw, Volume2, Mic, MicOff } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { locate, formatTime, loadSong, clearLocalLyrics } from '../lib/songs'
import { buildScore, gradeText, hzToMidi, LivePitch, makeRefLookup, pitchClassError } from '../lib/pitch'
import type { ScoreResult, Segment } from '../lib/types'
import { useKaraoke } from '../store'
import PitchStrip, { type UserDot } from './PitchStrip'
import Editor from './Editor'

type Phase = 'ready' | 'countdown' | 'playing' | 'paused' | 'finished'

interface Frame {
  t: number
  user: number
  ref: number
}

export default function Player() {
  const song = useKaraoke((s) => s.song)
  const openSong = useKaraoke((s) => s.openSong)
  const back = useKaraoke((s) => s.back)
  const pushRecent = useKaraoke((s) => s.pushRecent)

  const [phase, setPhase] = useState<Phase>('ready')
  const [count, setCount] = useState(3)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(song?.duration ?? 0)
  const [volume, setVolume] = useState(0.85)
  const [withMic, setWithMic] = useState(true)
  const [level, setLevel] = useState(0)
  const [micError, setMicError] = useState<string | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string>('')
  const [score, setScore] = useState<ScoreResult | null>(null)
  const [scored, setScored] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  // счётчик сбросов: заставляет открытый редактор перечитать song.segments
  const [editorReset, setEditorReset] = useState(0)
  // позиция пальца на ползунке во время драга — чтобы не дёргался за звуком
  const [scrub, setScrub] = useState<number | null>(null)

  const audioRef = useRef<HTMLAudioElement>(null)
  const rafRef = useRef(0)
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const waveRef = useRef<Float32Array>(new Float32Array(2048))
  const detectorRef = useRef(new LivePitch())
  const lookup = useMemo(() => makeRefLookup(song?.pitch ?? null), [song])
  const framesRef = useRef<Frame[]>([])
  const dotsRef = useRef<UserDot[]>([])
  const lastPitchRef = useRef(0)
  const curSegRef = useRef<HTMLDivElement>(null)
  // Шарик караоке: refs/состояние; измерение — ниже, после activeSeg
  const lineRef = useRef<HTMLDivElement>(null)
  const wordRefs = useRef<Array<HTMLSpanElement | null>>([])
  const [centers, setCenters] = useState<number[]>([])
  const [measureKey, setMeasureKey] = useState(0)

  const stopMic = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    void ctxRef.current?.close().catch(() => undefined)
    ctxRef.current = null
    analyserRef.current = null
  }, [])

  useEffect(() => stopMic, [stopMic])
  useEffect(() => {
    const a = audioRef.current
    if (a) a.volume = volume
  }, [volume])

  // автопрокрутка к текущей строке
  const { seg: activeSeg, sungWords } = useMemo(
    () => locate(song?.segments ?? [], time),
    [song, time],
  )
  useEffect(() => {
    curSegRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeSeg])

  // Перемеряем центры слов при смене строки / ресайзе / загрузке шрифтов
  useLayoutEffect(() => {
    const box = lineRef.current
    if (!box) return
    const cRect = box.getBoundingClientRect()
    const pts: number[] = []
    for (let j = 0; j < wordRefs.current.length; j++) {
      const el = wordRefs.current[j]
      if (!el) break
      const r = el.getBoundingClientRect()
      pts.push(r.left - cRect.left + r.width / 2)
    }
    setCenters(pts)
  }, [activeSeg, song, measureKey])

  useEffect(() => {
    const bump = () => setMeasureKey((k) => k + 1)
    window.addEventListener('resize', bump)
    const fontsReady = document.fonts?.ready
    if (fontsReady) fontsReady.then(bump).catch(() => undefined)
    return () => window.removeEventListener('resize', bump)
  }, [])

  const loop = useCallback(() => {
    const a = audioRef.current
    if (!a) return
    const t = a.currentTime
    setTime((prev) => (Math.abs(t - prev) < 0.03 ? prev : t))

    const an = analyserRef.current
    const ctx = ctxRef.current
    if (an && ctx) {
      const buf = waveRef.current
      an.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      const rms = Math.sqrt(sum / buf.length)
      setLevel((prev) => {
        const v = Math.min(1, rms * 6)
        return Math.abs(v - prev) < 0.02 ? prev : v
      })
      const now = performance.now()
      if (now - lastPitchRef.current > 120) {
        lastPitchRef.current = now
        const hit = detectorRef.current.detect(buf, ctx.sampleRate)
        if (hit) {
          const midi = hzToMidi(hit.freq)
          const ref = lookup.at(t)
          if (ref !== null && ref !== undefined) {
            const err = pitchClassError(midi, ref)
            framesRef.current.push({ t, user: midi, ref })
            dotsRef.current.push({ t, midi, hit: err <= 1 })
            if (dotsRef.current.length > 3000) dotsRef.current.shift()
          }
        }
      }
    }
    rafRef.current = requestAnimationFrame(loop)
  }, [lookup])

  const startLoop = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(loop)
  }, [loop])

  const setupMic = useCallback(async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
      streamRef.current = stream
      const Ctx = window.AudioContext
      const ctx = new Ctx()
      ctxRef.current = ctx
      const src = ctx.createMediaStreamSource(stream)
      const an = ctx.createAnalyser()
      an.fftSize = 2048
      src.connect(an)
      analyserRef.current = an
      const devs = await navigator.mediaDevices.enumerateDevices()
      setDevices(devs.filter((d) => d.kind === 'audioinput'))
      return true
    } catch {
      setMicError('Не удалось включить микрофон — можно петь без оценки')
      return false
    }
  }, [deviceId])

  const begin = useCallback(
    async (useMic: boolean) => {
      if (!audioRef.current || !song) return
      pushRecent(song.id)
      setMicError(null)
      setScore(null)
      setScored(false)
      framesRef.current = []
      dotsRef.current = []
      setTime(0)
      audioRef.current.currentTime = 0
      setWithMic(useMic)
      if (useMic) {
        const ok = await setupMic()
        if (!ok) setWithMic(false)
      }
      setPhase('countdown')
      setCount(3)
      let n = 3
      const timer = setInterval(() => {
        n -= 1
        if (n <= 0) {
          clearInterval(timer)
          audioRef.current
            ?.play()
            .then(() => {
              setPhase('playing')
              startLoop()
            })
            .catch(() => {
              setPhase('ready')
              setMicError('Браузер заблокировал автоплей — нажмите «Петь» ещё раз')
            })
        } else setCount(n)
      }, 750)
    },
    [setupMic, song, startLoop, pushRecent],
  )

  const togglePlay = useCallback(() => {
    const a = audioRef.current
    if (!a) return
    if (phase === 'playing') {
      a.pause()
      setPhase('paused')
      cancelAnimationFrame(rafRef.current)
    } else if (phase === 'paused') {
      void a.play().then(() => {
        setPhase('playing')
        startLoop()
      })
    }
  }, [phase, startLoop])

  /** открыть редактор: минус обязательно на паузу, иначе два звука разъедутся */
  const openEditor = useCallback(() => {
    if (phase === 'playing') togglePlay()
    setEditorOpen(true)
  }, [phase, togglePlay])

  const restart = useCallback(() => {    const a = audioRef.current
    if (!a) return
    framesRef.current = []
    dotsRef.current = []
    a.currentTime = 0
    setTime(0)
    setScore(null)
    setScored(false)
    void a.play().then(() => {
      setPhase('playing')
      startLoop()
    })
  }, [startLoop])

  const backToCatalog = useCallback(() => {
    audioRef.current?.pause()
    stopMic()
    back()
  }, [back, stopMic])

  const onEnded = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    setPhase('finished')
    stopMic()
    if (framesRef.current.length > 10) {
      setScore(buildScore(framesRef.current))
      setScored(true)
    }
  }, [stopMic])

  const seek = useCallback((v: number) => {
    const a = audioRef.current
    if (!a) return
    a.currentTime = v
    setTime(v)
    dotsRef.current = dotsRef.current.filter((d) => d.t <= v + 0.2)
    framesRef.current = framesRef.current.filter((f) => f.t <= v + 0.2)
  }, [])

  const applyEdited = useCallback((segments: Segment[]) => {
    if (!song) return
    openSong({ ...song, segments })
  }, [song, openSong])

  const resetToBundle = useCallback(async () => {
    if (!song) return
    clearLocalLyrics(song.id)
    try {
      openSong(await loadSong(song))
      setEditorReset((k) => k + 1)
    } catch (e) {
      console.error(e)
    }
  }, [song, openSong])

  // пробуем заранее показать список микрофонов
  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices?.()
      .then((ds) => setDevices(ds.filter((d) => d.kind === 'audioinput')))
      .catch(() => undefined)
  }, [])

  if (!song) return null
  const segs = song.segments

  return (
    <div className="mx-auto flex h-[calc(100%-64px)] w-full max-w-3xl flex-col px-5">
      <audio ref={audioRef} src={song.audio} preload="auto" onEnded={onEnded}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || song.duration)} />

      {/* верхняя панель */}
      <div className="flex items-center gap-2.5 py-3">
        <button onClick={backToCatalog} title="Вернуться в каталог" aria-label="Вернуться в каталог"
          className="flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-white/5 px-3.5 text-[13px] font-medium text-zinc-300 transition hover:bg-white/12 hover:text-zinc-100">
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Каталог</span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-medium text-zinc-100">{song.title}</div>
          <div className="text-xs text-zinc-500 tabular-nums">{formatTime(time)} / {formatTime(duration)}</div>
        </div>
        <div title={withMic ? 'Микрофон включён' : 'Микрофон выключен — поёте без оценки'}
          className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2 text-xs ${withMic && (phase === 'playing' || phase === 'paused') ? 'bg-white/8 text-zinc-200' : 'bg-white/4 text-zinc-600'}`}>
          {withMic ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
          <span className="hidden font-medium md:inline">{withMic ? 'Микрофон' : 'Без микрофона'}</span>
          <div className="h-1 w-12 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-amber-300 transition-[width]" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
        </div>
        <button onClick={openEditor} title="Исправить текст и тайминги песни (минус встанет на паузу)"
          aria-label="Исправить текст и тайминги песни"
          className="flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-white/5 px-3.5 text-[13px] font-medium text-zinc-300 transition hover:bg-white/12 hover:text-zinc-100">
          <Pencil className="h-4 w-4" />
          <span className="hidden sm:inline">Текст</span>
        </button>
      </div>

      {/* текст */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-white/8 bg-white/[0.02] px-6 py-6">
        {segs.length === 0 ? (
          <p className="text-center text-sm text-zinc-500">Текст не распознан — пойте под минус</p>
        ) : (
          segs.map((s, i) => {
            const isCur = i === activeSeg
            const isPast = activeSeg >= 0 && i < activeSeg
            const showPart = s.part && (i === 0 || segs[i - 1].part !== s.part)
            // Шарик: летит от текущего слова к следующему, приземляется ровно в его начало
            const nWords = s.words.length
            const ballOn = isCur && nWords > 0 && centers.length === nWords
            const sung = Math.max(0, Math.min(sungWords, nWords))
            const ci = Math.max(0, sung - 1)
            const fromX = ballOn ? centers[ci] : 0
            const toX = ballOn ? (sung < nWords ? centers[sung] : centers[nWords - 1]) : 0
            const t0 = ballOn ? (sung === 0 ? s.start - 0.6 : s.words[ci].s) : 0
            const t1 = ballOn ? (sung < nWords ? s.words[sung].s : s.words[nWords - 1].e) : 1
            const p = ballOn && t1 > t0 ? Math.min(1, Math.max(0, (time - t0) / (t1 - t0))) : 1
            const ballX = fromX + (toX - fromX) * p
            const ballY = -Math.abs(Math.sin(p * Math.PI)) * 20
            return (
              <div key={i} ref={isCur ? curSegRef : undefined}
                className={`py-2.5 transition-all duration-300 ${isCur ? '' : 'opacity-100'}`}>
                {showPart && (
                  <div className={`mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${isCur ? 'text-amber-200/70' : 'text-zinc-600'}`}>
                    {s.part}
                  </div>
                )}
                {isCur ? (
                  <div ref={lineRef} className="relative pt-8">
                    {ballOn && (
                      <div className="pointer-events-none absolute z-10" style={{ left: ballX, top: 4, transform: `translate(-50%, ${ballY}px)` }}>
                        <div className="h-3.5 w-3.5 rounded-full bg-amber-300 shadow-[0_0_12px_2px_rgba(252,211,77,0.8)]" />
                      </div>
                    )}
                    <p className="text-[26px] font-semibold leading-snug">
                      {s.words.map((w, j) => (
                        <span key={j} ref={(el) => { wordRefs.current[j] = el }} className={j < sungWords ? 'text-amber-300' : 'text-zinc-100'}>
                          {w.w}{' '}
                        </span>
                      ))}
                    </p>
                  </div>
                ) : (
                  <p className={`text-[17px] leading-relaxed ${isPast ? 'text-zinc-600' : 'text-zinc-400'}`}>
                    {s.text}
                  </p>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* полоса тона */}
      {song.pitch && (phase === 'playing' || phase === 'paused') && (
        <div className="mt-3 rounded-2xl border border-white/8 bg-white/[0.02] px-4 pb-1 pt-2">
          <div className="px-1 text-[11px] text-zinc-600">Попадание в ноты · жёлтые — точно, розовые — мимо</div>
          <PitchStrip pitch={song.pitch} duration={duration || song.duration} time={time} dotsRef={dotsRef} />
        </div>
      )}

      {/* прогресс: во время драга ползунок слушается пальца, а не звука */}
      <input type="range" min={0} max={Math.max(1, duration)} step={0.1}
        value={scrub ?? Math.min(time, duration || 0)}
        onChange={(e) => {
          const v = Number(e.target.value)
          setScrub(v)
          seek(v)
        }}
        onPointerUp={() => setScrub(null)}
        onPointerCancel={() => setScrub(null)}
        onKeyUp={() => setScrub(null)}
        onBlur={() => setScrub(null)}
        className="mt-3 w-full accent-amber-300" aria-label="Позиция в песне" />

      {/* управление */}
      <div className="flex items-center gap-3 py-4">
        {(phase === 'playing' || phase === 'paused') && (
          <>
            <button onClick={togglePlay} title={phase === 'playing' ? 'Пауза (пробел)' : 'Продолжить (пробел)'}
              aria-label={phase === 'playing' ? 'Пауза' : 'Продолжить'}
              className="grid h-12 w-12 place-items-center rounded-full bg-zinc-100 text-zinc-950 transition hover:bg-white">
              {phase === 'playing' ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
            </button>
            <button onClick={restart} title="Начать песню сначала"
              aria-label="Начать песню сначала"
              className="flex h-10 items-center gap-1.5 rounded-full bg-white/6 px-3.5 text-[13px] font-medium text-zinc-300 transition hover:bg-white/12 hover:text-zinc-100">
              <RotateCcw className="h-4 w-4" />
              Сначала
            </button>
          </>
        )}
        <div className="flex flex-1 items-center gap-2">
          <Volume2 className="h-4 w-4 shrink-0 text-zinc-500" />
          <input type="range" min={0} max={1} step={0.01} value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="w-full max-w-36 accent-zinc-300" aria-label="Громкость" />
        </div>
        {phase === 'finished' && (
          <button onClick={restart}
            className="rounded-full bg-amber-300 px-5 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-amber-200">
            Ещё раз
          </button>
        )}
      </div>

      {micError && <p className="pb-3 text-center text-[13px] text-rose-300/90">{micError}</p>}

      {/* стартовый экран */}
      <AnimatePresence>
        {phase === 'ready' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-20 grid place-items-center bg-black/70 p-5 backdrop-blur-sm">
            <motion.div initial={{ scale: 0.96, y: 10 }} animate={{ scale: 1, y: 0 }}
              className="w-full max-w-md rounded-3xl border border-white/10 bg-[#141417] p-7 text-center">
              <h2 className="text-xl font-semibold text-zinc-50">{song.title}</h2>
              <p className="mt-1 text-sm text-zinc-500">
                {segs.length} строк · {formatTime(duration || song.duration)} · минус готов
              </p>
              {devices.length > 0 && (
                <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}
                  className="mt-5 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-zinc-200 outline-none">
                  <option value="">Микрофон по умолчанию</option>
                  {devices.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Микрофон ${i + 1}`}
                    </option>
                  ))}
                </select>
              )}
              <div className="mt-5 flex flex-col gap-2">
                <button onClick={() => void begin(true)}
                  className="flex items-center justify-center gap-2 rounded-2xl bg-amber-300 py-3.5 text-[15px] font-semibold text-zinc-950 transition hover:bg-amber-200">
                  <Mic className="h-4.5 w-4.5" /> Петь с оценкой
                </button>
                <button onClick={() => void begin(false)}
                  className="rounded-2xl bg-white/8 py-3.5 text-[15px] font-medium text-zinc-100 transition hover:bg-white/14">
                  Просто подпевать
                </button>
              </div>
              <button onClick={backToCatalog} className="mt-4 text-[13px] text-zinc-500 hover:text-zinc-300">
                Назад к каталогу
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* отсчёт */}
      <AnimatePresence>
        {phase === 'countdown' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-20 grid place-items-center bg-black/70 backdrop-blur-sm">
            <motion.div key={count} initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              className="text-[110px] font-bold text-amber-300 tabular-nums">
              {count}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* редактор текста */}
      <AnimatePresence>
        {editorOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Editor
              song={song}
              onClose={() => setEditorOpen(false)}
              onSave={applyEdited}
              onReset={() => void resetToBundle()}
              onSeek={seek}
              resetSignal={editorReset}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* оценка */}
      <AnimatePresence>
        {phase === 'finished' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-20 grid place-items-center bg-black/70 p-5 backdrop-blur-sm">
            <motion.div initial={{ scale: 0.95, y: 12 }} animate={{ scale: 1, y: 0 }}
              className="w-full max-w-md rounded-3xl border border-white/10 bg-[#141417] p-8 text-center">
              {scored && score ? (
                <>
                  <motion.div initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 14 }}
                    className="text-[84px] font-bold leading-none text-amber-300 tabular-nums">
                    {score.score}
                  </motion.div>
                  <div className="mt-2 text-lg font-medium text-zinc-100">{gradeText(score.score)}</div>
                  <div className="mt-1 text-[13px] text-zinc-500">
                    попаданий {score.hits}/{score.total} · ошибка {score.medianError} полутона
                  </div>
                </>
              ) : (
                <>
                  <div className="flex justify-center">
                    {score === null && <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />}
                  </div>
                  <div className="mt-3 text-lg font-medium text-zinc-100">Готово!</div>
                  <div className="mt-1 text-[13px] text-zinc-500">
                    {withMic ? 'Мало данных с микрофона для оценки — попробуйте ещё раз' : 'Вы пели без микрофона — так тоже отлично'}
                  </div>
                </>
              )}
              <div className="mt-6 flex gap-2">
                <button onClick={restart}
                  className="flex-1 rounded-2xl bg-amber-300 py-3 text-[15px] font-semibold text-zinc-950 transition hover:bg-amber-200">
                  Ещё раз
                </button>
                <button onClick={backToCatalog}
                  className="flex-1 rounded-2xl bg-white/8 py-3 text-[15px] font-medium text-zinc-100 transition hover:bg-white/14">
                  Каталог
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
