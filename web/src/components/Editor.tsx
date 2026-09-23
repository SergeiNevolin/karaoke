import {
  Check, ChevronLeft, ChevronRight, Download, Link2, Loader2, LocateFixed, Magnet, Mic, MousePointerClick,
  Pause, Play, Plus, Repeat, RotateCcw, Scissors, SkipForward, Trash2, Volume2, X,
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { computeOnsets, snapToOnset } from '../lib/onsets'
import {
  applyTextToSegments,
  downloadLyrics,
  evenWords,
  fetchLyricsFromUrl,
  formatTime,
  locate,
  nearestSegment,
  saveLocalLyrics,
} from '../lib/songs'
import type { Segment, SongData, Word } from '../lib/types'
import Waveform from './editor/Waveform'
import WordTimeline from './editor/WordTimeline'

interface Props {
  song: SongData
  onClose: () => void
  onSave: (segments: Segment[]) => void
  onReset: () => void
  onSeek: (t: number) => void
  /** меняется при «Сбросить»: открытый редактор перечитывает song.segments */
  resetSignal: number
}

interface Row extends Segment {
  key: number
}

const PARTS = ['', 'Интро', 'Куплет 1', 'Куплет 2', 'Куплет 3', 'Предприпев', 'Припев', 'Постприпев', 'Бридж', 'Аутро']
const RATES = [0.5, 0.75, 1]

let nextKey = 1

function toRows(segs: Segment[]): Row[] {
  return segs.map((s) => ({ ...s, words: s.words.map((w) => ({ ...w })), key: nextKey++ }))
}

/** сохранить word-timings, если число слов не изменилось, иначе разложить равномерно */
function syncWords(row: Row): Segment {
  const tokens = row.text.split(/\s+/).filter(Boolean)
  const spans = tokenSpans(row.words)
  const total = spans.reduce((a, b) => a + b, 0)
  if (tokens.length > 0 && tokens.length === total) {
    // склеенные слова покрывают несколько токенов — тайминги целы, текст обновляем
    let ti = 0
    const words = row.words.map((w) => {
      const k = Math.max(1, wordTokens(w).length)
      const text = tokens.slice(ti, ti + k).join(' ')
      ti += k
      return { ...w, w: text }
    })
    return { start: row.start, end: row.end, text: row.text.trim(), part: row.part, words }
  }
  return { start: row.start, end: row.end, text: row.text.trim(), part: row.part, words: evenWords(row.text, row.start, row.end) }
}

/** токены внутри одного слова (склеенные содержат пробелы) */
function wordTokens(w: Word): string[] {
  return w.w.split(/\s+/).filter(Boolean)
}

/** сколько текстовых токенов покрывает каждое слово */
function tokenSpans(words: Word[]): number[] {
  return words.map((w) => Math.max(1, wordTokens(w).length))
}

/** индекс первого токена слова i */
function tokenStart(spans: number[], i: number): number {
  let s = 0
  for (let k = 0; k < i; k++) s += spans[k]
  return s
}

interface LineRowProps {
  r: Row
  num: number
  selected: boolean
  onSelect: (key: number, start: number) => void
  onPatch: (key: number, p: Partial<Row>) => void
  onInsert: (key: number) => void
  onRemove: (key: number) => void
}

/** строка списка отдельно: не перерисовывается от тиков времени игры */
const LineRow = memo(function LineRow({ r, num, selected, onSelect, onPatch, onInsert, onRemove }: LineRowProps) {
  return (
    <div onClick={() => onSelect(r.key, r.start)}
      className={`mb-1.5 flex cursor-pointer items-center gap-1.5 rounded-xl px-1 py-1 transition ${selected ? 'bg-amber-300/8' : 'hover:bg-white/[0.04]'}`}>
      <span className={`w-7 shrink-0 text-right text-[11px] tabular-nums ${selected ? 'text-amber-200' : 'text-zinc-600'}`}>
        {num}
      </span>
      <input type="number" step={0.1} min={0} value={r.start}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onPatch(r.key, { start: Number(e.target.value) })}
        className="w-[64px] shrink-0 rounded-lg border border-white/10 bg-white/5 px-1 py-1.5 text-center text-xs text-zinc-200 tabular-nums outline-none focus:border-white/25" />
      <input type="number" step={0.1} min={0} value={r.end}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onPatch(r.key, { end: Number(e.target.value) })}
        className="w-[64px] shrink-0 rounded-lg border border-white/10 bg-white/5 px-1 py-1.5 text-center text-xs text-zinc-200 tabular-nums outline-none focus:border-white/25" />
      <input value={r.text} onChange={(e) => onPatch(r.key, { text: e.target.value })}
        onClick={(e) => e.stopPropagation()}
        placeholder="Строка песни"
        className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-[14px] text-zinc-100 outline-none focus:border-white/20 focus:bg-white/5" />
      <select value={r.part ?? ''} onChange={(e) => onPatch(r.key, { part: e.target.value || undefined })}
        onClick={(e) => e.stopPropagation()}
        className="hidden w-[104px] shrink-0 rounded-lg border border-white/10 bg-[#1c1c21] px-1 py-1.5 text-xs text-zinc-300 outline-none sm:block">
        {PARTS.map((p) => (
          <option key={p} value={p}>{p || '—'}</option>
        ))}
      </select>
      <button onClick={(e) => { e.stopPropagation(); onInsert(r.key) }} title="Добавить строку ниже"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-zinc-500 transition hover:bg-white/8 hover:text-zinc-200">
        <Plus className="h-3.5 w-3.5" />
      </button>
      <button onClick={(e) => { e.stopPropagation(); onRemove(r.key) }} title="Удалить"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-zinc-500 transition hover:bg-rose-400/15 hover:text-rose-300">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
})

export default function Editor({ song, onClose, onSave, onReset, onSeek, resetSignal }: Props) {
  const [rows, setRows] = useState<Row[]>(() => toRows(song.segments))
  // Выбор строки — ТОЛЬКО по стабильному key: вставки/удаления его не сдвигают
  const [selKey, setSelKey] = useState<number | null>(null)
  const [selWord, setSelWord] = useState<number | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importUrl, setImportUrl] = useState('')
  const [urlBusy, setUrlBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // Следовать за звуком: панель сама переходит к строке, которая играет
  const [follow, setFollow] = useState(true)

  // транспорт оригинала
  const audioRef = useRef<HTMLAudioElement>(null)
  // минус идёт всегда синхронно (приглушённый) — включение микса мгновенное
  const minusRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [rate, setRate] = useState(1)
  const [loopLine, setLoopLine] = useState(false)
  const [volume, setVolume] = useState(1)
  const [vocalLevel, setVocalLevel] = useState(1)
  const [mixMode, setMixMode] = useState<'vocals' | 'full'>('vocals')
  const [minusOk, setMinusOk] = useState(false)
  const [pad, setPad] = useState(1.5)
  const stopRef = useRef<{ t: number; seq: number } | null>(null)
  const seqRef = useRef(0)
  const raf = useRef(0)

  // Режимы — по одному объекту на режим: «наполовину включённых» состояний не бывает.
  // Таппинг: в какой строке и какое слово следующее.
  const [tap, setTap] = useState<{ key: number; idx: number } | null>(null)
  const tapBackup = useRef<Word[]>([])

  /* ---------- таппинг (состояние выше, рядом с playKey) ---------- */

  // магнит и пошаговый режим
  const [magnet, setMagnet] = useState(true)
  // Пошаговый режим: в какой строке и какое слово слушаем.
  const [step, setStep] = useState<{ key: number; idx: number } | null>(null)
  const onsets = useMemo(
    () => (song.waveform ? computeOnsets(song.waveform.peaks, song.waveform.duration) : []),
    [song],
  )

  // звук целиком в память (blob): перемотка мгновенная, без сетевых stall'ов
  const [audioReady, setAudioReady] = useState(false)
  const [loadPct, setLoadPct] = useState(0)

  useEffect(() => {
    if (!song.vocals) return
    let dead = false
    const urls: string[] = []
    setAudioReady(false)
    setMinusOk(false)
    setLoadPct(0)
    // качаем файл целиком с прогрессом
    const loadOne = async (
      url: string,
      el: HTMLAudioElement | null,
      onProg: (pct: number) => void,
    ): Promise<boolean> => {
      const r = await fetch(url)
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
      const total = Number(r.headers.get('content-length') || 0)
      const reader = r.body.getReader()
      const chunks: BlobPart[] = []
      let got = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (dead) {
          try {
            await reader.cancel()
          } catch {
            /* ignore */
          }
          return false
        }
        if (done) break
        chunks.push(value)
        got += value.length
        if (total > 0) onProg(Math.round((got / total) * 100))
      }
      if (dead) return false
      const obj = URL.createObjectURL(new Blob(chunks, { type: 'audio/mpeg' }))
      urls.push(obj)
      if (el && !dead) {
        el.src = obj
        el.load()
      }
      return true
    }
    const boot = async () => {
      try {
        let pv = 0
        let pm = 0
        const paint = () => {
          if (!dead) setLoadPct(Math.round((pv + pm) / 2))
        }
        const [vok, min] = await Promise.all([
          loadOne(song.vocals as string, audioRef.current, (p) => {
            pv = p
            paint()
          }).catch(() => false),
          loadOne(song.audio, minusRef.current, (p) => {
            pm = p
            paint()
          }).catch(() => false),
        ])
        if (dead) return
        if (vok) setAudioReady(true)
        if (min) setMinusOk(true)
        if (!vok && minusRef.current && !dead) {
          // запасной вариант: стрим напрямую
          if (audioRef.current) audioRef.current.src = song.vocals as string
          setAudioReady(true)
        }
      } catch {
        if (dead) return
        if (audioRef.current && song.vocals) audioRef.current.src = song.vocals
        setAudioReady(true)
      }
    }
    void boot()
    return () => {
      dead = true
      urls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [song.id, song.vocals, song.audio])

  const hasOriginal = Boolean(song.vocals && song.waveform && song.waveform.peaks.length > 0)
  // Текущая строка выводится из key; фолбэк — первая (например, после импорта)
  const line = useMemo(
    () => rows.find((r) => r.key === selKey) ?? rows[0],
    [rows, selKey],
  )
  const lineIdx = line ? rows.findIndex((r) => r.key === line.key) : -1

  const noticeTimer = useRef(0)
  const flash = (msg: string) => {
    setNotice(msg)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3500)
  }

  const patch = useCallback((key: number, p: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))
  }, [])

  /* ---------- транспорт ---------- */

  // Зеркала для rAF-цикла: он живёт между рендерами и обязан видеть свежие
  // строку/переключатели, иначе клик по другой строке отбросит звук назад
  const lineRef = useRef<{ start: number; end: number } | null>(null)
  const loopLineRef = useRef(false)
  const tapRef = useRef<{ key: number; idx: number } | null>(null)
  const stepRef = useRef<{ key: number; idx: number } | null>(null)
  useEffect(() => {
    lineRef.current = line ? { start: line.start, end: line.end } : null
    loopLineRef.current = loopLine
    tapRef.current = tap
    stepRef.current = step
  })

  const loop = useCallback(() => {
    const a = audioRef.current
    if (!a) return
    const t = a.currentTime
    setTime((p) => (Math.abs(t - p) < 0.05 ? p : t))
    // минус держим в синхроне (дрейф двух элементов)
    const m = minusRef.current
    if (m && m.src && !a.paused && !m.paused) {
      const drift = m.currentTime - t
      if (Math.abs(drift) > 0.08) {
        try {
          m.currentTime = t
        } catch {
          /* seek in progress — попробуем следующим кадром */
        }
      }
    }
    const stop = stopRef.current
    if (stop && stop.seq === seqRef.current && t >= stop.t) {
      stopRef.current = null
      a.pause()
      setPlaying(false)
    } else {
      const L = lineRef.current
      if (L && loopLineRef.current && tapRef.current === null && stepRef.current === null && t > L.end + 0.25) {
        a.currentTime = Math.max(0, L.start - 0.1)
      }
    }
    raf.current = requestAnimationFrame(loop)
  }, [])

  const startLoop = useCallback(() => {
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(loop)
  }, [loop])

  /** запустить воспроизведение; колбэки чужих поколений игнорятся */
  const playAudio = useCallback(() => {
    const a = audioRef.current
    if (!a || !a.src) return -1 // звук ещё грузится в память
    const s = ++seqRef.current
    const m = minusRef.current
    const jobs: Promise<void>[] = [a.play()]
    // минус стартует с той же позиции — дальше loop держит синхрон
    if (m && m.src) {
      try {
        m.currentTime = a.currentTime
      } catch {
        /* ignore */
      }
      jobs.push(m.play().catch(() => undefined))
    }
    void Promise.all(jobs).then(() => {
      if (seqRef.current !== s) return // пока грузилось — пользователь уже переключил
      setPlaying(true)
      startLoop()
    }, () => setPlaying(false)) // отклонено (нет звука / прервано паузой) — тихо гасим
    return s
  }, [startLoop])

  const armStop = useCallback((t: number | null) => {
    stopRef.current = t === null ? null : { t, seq: seqRef.current }
  }, [])

  interface PlayRange {
    from: number
    stopAt: number | null
    selKey?: number | null
    selWord?: number | null
  }

  /** ЕДИНСТВЕННЫЙ способ запустить звук с позиции: выбор — сразу, звук — если готов */
  const startPlayback = useCallback((p: PlayRange) => {
    if (p.selKey !== undefined) {
      setSelKey(p.selKey)
      setSelWord(p.selWord ?? null)
    }
    const a = audioRef.current
    if (!a || !a.src) {
      flash('Звук ещё грузится в память…')
      return
    }
    a.currentTime = Math.max(0, p.from)
    setTime(Math.max(0, p.from))
    playAudio()
    armStop(p.stopAt)
  }, [armStop, playAudio])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])
  useEffect(() => {
    const v = audioRef.current
    if (v) {
      v.playbackRate = rate
      v.volume = volume * vocalLevel
      v.preservesPitch = true
    }
    const m = minusRef.current
    if (m) {
      m.playbackRate = rate
      m.volume = volume
      m.muted = mixMode === 'vocals'
      m.preservesPitch = true
    }
  }, [rate, volume, vocalLevel, mixMode])

  const play = useCallback(() => {
    armStop(null)
    playAudio()
  }, [armStop, playAudio])

  const pause = useCallback(() => {
    seqRef.current++ // гасим висящие play()-промисы и чужие стопы
    stopRef.current = null
    audioRef.current?.pause()
    minusRef.current?.pause()
    setPlaying(false)
    cancelAnimationFrame(raf.current)
  }, [])

  const seek = useCallback((t: number) => {
    const a = audioRef.current
    // без данных seek молча не сработает и рассинхронит UI — отбиваем сразу
    if (!a || !a.src || a.readyState < 1) {
      flash('Звук ещё грузится в память…')
      return
    }
    stopRef.current = null
    const tt = Math.max(0, t)
    a.currentTime = tt
    const m = minusRef.current
    if (m && m.src) {
      try {
        m.currentTime = tt
      } catch {
        /* догонит в loop */
      }
    }
    setTime(tt)
  }, [])

  // отмена таппинга — сюда, до playKey: переключение строк откатывает его
  const cancelTap = useCallback(() => {
    if (!tap) return
    const r = rows.find((x) => x.key === tap.key)
    if (r) patch(r.key, { words: tapBackup.current })
    setTap(null)
  }, [rows, tap, patch])

  /** выбрать строку и играть её: выбор и звук меняются атомарно */
  const playKey = useCallback((key: number) => {
    const r = rows.find((x) => x.key === key)
    if (!r) return
    cancelTap() // откатить незавершённый таппинг другой строки
    setStep(null)
    startPlayback({
      from: r.start - 0.2,
      stopAt: loopLine ? null : r.end + 0.3,
      selKey: key,
      selWord: null,
    })
  }, [rows, loopLine, startPlayback, cancelTap])

  const previewWord = useCallback((key: number, wi: number) => {
    const r = rows.find((x) => x.key === key)
    const w = r?.words[wi]
    if (!w) return
    startPlayback({ from: w.s - 0.03, stopAt: w.e + 0.05, selKey: key, selWord: wi })
  }, [rows, startPlayback])

  // Пока палец на волне (скраб/таскание слов) — автоподхват выбора молчит,
  // иначе выбор прыгает между строкой под пальцем и отстающим звуком
  const scrubbingRef = useRef(false)
  const setScrubbing = useCallback((v: boolean) => {
    scrubbingRef.current = v
  }, [])

  // автоподхват строки за курсором во время игры (только в режиме следования)
  const { seg: heardSeg } = useMemo(() => locate(rows, time), [rows, time])
  useEffect(() => {
    if (playing && follow && !scrubbingRef.current && tap === null && step === null && heardSeg >= 0) {
      const key = rows[heardSeg]?.key
      if (key !== undefined && key !== selKey) {
        setSelKey(key)
        setSelWord(null)
      }
    }
  }, [playing, follow, tap, step, heardSeg, rows, selKey])

  // страховка пошагового режима от удаления слова из-под него
  useEffect(() => {
    if (step !== null && (!line || line.key !== step.key || !line.words[step.idx])) setStep(null)
  }, [step, line])

  /* ---------- правки слов ---------- */

  const changeWords = useCallback((ls: number, le: number, words: Word[]) => {
    if (!line) return
    patch(line.key, { start: ls, end: le, words })
  }, [line, patch])

  /** привести слова к тексту, если число токенов разъехалось (с учётом склеенных) */
  const syncCounts = (r: Row): Row => {
    const tokens = r.text.split(/\s+/).filter(Boolean)
    const total = tokenSpans(r.words).reduce((a, b) => a + b, 0)
    if (tokens.length === 0 || tokens.length === total) return r
    return { ...r, words: evenWords(r.text, r.start, r.end) }
  }

  const abortModesOnLine = (key: number) => {
    if (tap?.key === key) setTap(null)
    if (step?.key === key) setStep(null)
  }

  const deleteWord = useCallback((idx: number) => {
    if (!line || idx < 0) return
    abortModesOnLine(line.key)
    const r = syncCounts(line)
    if (r.words.length <= 1) {
      flash('Последнее слово не удаляю — удалите строку целиком')
      return
    }
    if (idx >= r.words.length) return
    const spans = tokenSpans(r.words)
    const tokens = r.text.split(/\s+/).filter(Boolean)
    tokens.splice(tokenStart(spans, idx), spans[idx])
    patch(line.key, { text: tokens.join(' '), words: r.words.filter((_, i) => i !== idx) })
    setSelWord(null)
  }, [line, patch, tap, step])

  const addWord = useCallback(() => {
    if (!line) return
    abortModesOnLine(line.key)
    const r = syncCounts(line)
    const tokens = r.text.split(/\s+/).filter(Boolean)
    const at = selWord === null ? r.words.length - 1 : Math.min(selWord, r.words.length - 1)
    const prevE = at >= 0 ? r.words[at].e : r.start
    const nextS = at + 1 < r.words.length ? r.words[at + 1].s : r.end
    const s = Math.round(Math.min(Math.max(prevE, r.start), Math.max(r.start, nextS - 0.15)) * 100) / 100
    const e = Math.round(Math.min(s + 0.4, nextS) * 100) / 100
    const words = [...r.words]
    words.splice(at + 1, 0, { w: '…', s, e })
    const spans = tokenSpans(r.words)
    tokens.splice(at >= 0 ? tokenStart(spans, at) + spans[at] : 0, 0, '…')
    patch(line.key, { text: tokens.join(' '), words, end: Math.max(r.end, e) })
    setSelWord(at + 1)
    flash('Новое слово «…» — замените его текстом в строке выше')
  }, [line, selWord, patch, tap, step])

  const nudge = useCallback((edge: 's' | 'e', delta: number, replay = true) => {
    if (!line || selWord === null) return
    const ws = line.words.map((w) => ({ ...w }))
    const w = ws[selWord]
    if (!w) return
    if (edge === 's') {
      const lo = selWord > 0 ? ws[selWord - 1].e : 0
      w.s = Math.round(Math.max(lo, Math.min(w.s + delta, w.e - 0.06)) * 100) / 100
    } else {
      const hi = selWord < ws.length - 1 ? ws[selWord + 1].s : line.end + pad + 1
      w.e = Math.round(Math.min(hi, Math.max(w.e + delta, w.s + 0.06)) * 100) / 100
    }
    patch(line.key, {
      words: ws,
      start: selWord === 0 ? Math.min(line.start, ws[0].s) : line.start,
      end: selWord === ws.length - 1 ? Math.max(line.end, ws[ws.length - 1].e) : line.end,
    })
    if (replay) previewWord(line.key, selWord)
  }, [line, selWord, pad, patch, previewWord])

  /** склеить выбранное слово со следующим */
  const mergeWord = useCallback(() => {
    if (!line || selWord === null || selWord >= line.words.length - 1) return
    abortModesOnLine(line.key)
    const r = syncCounts(line)
    const ws = r.words.map((w) => ({ ...w }))
    const merged = { w: `${ws[selWord].w} ${ws[selWord + 1].w}`, s: ws[selWord].s, e: ws[selWord + 1].e }
    ws.splice(selWord, 2, merged)
    const spans = tokenSpans(r.words)
    const tokens = r.text.split(/\s+/).filter(Boolean)
    tokens.splice(tokenStart(spans, selWord), spans[selWord] + spans[selWord + 1], merged.w)
    patch(line.key, { text: tokens.join(' '), words: ws })
    flash('Слова склеены')
  }, [line, selWord, patch, tap, step])

  /** разрезать выбранное слово в позиции курсора (иначе посередине) */
  const splitWord = useCallback(() => {
    if (!line || selWord === null) return
    abortModesOnLine(line.key)
    const r = syncCounts(line)
    const w = r.words[selWord]
    if (!w) return
    const at = time > w.s + 0.1 && time < w.e - 0.1
      ? Math.round(time * 100) / 100
      : Math.round(((w.s + w.e) / 2) * 100) / 100
    const words = [...r.words]
    words.splice(selWord, 1, { ...w, e: at }, { w: '…', s: at, e: w.e })
    const spans = tokenSpans(r.words)
    const tokens = r.text.split(/\s+/).filter(Boolean)
    tokens.splice(tokenStart(spans, selWord) + spans[selWord], 0, '…')
    patch(line.key, { text: tokens.join(' '), words })
    setSelWord(selWord + 1)
    flash('Слово разрезано — вторую часть переименуйте в строке')
  }, [line, selWord, time, patch, tap, step])

  /* ---------- пошаговый режим: слушаем по одному слову ---------- */

  const playStepWord = useCallback((key: number, wi: number) => {
    const r = rows.find((x) => x.key === key)
    const w = r?.words[wi]
    if (!w) return
    startPlayback({ from: w.s - 0.15, stopAt: w.e + 0.12, selWord: wi })
  }, [rows, startPlayback])

  const startStep = useCallback(() => {
    if (!line || !line.words.length) {
      flash('В строке нет слов')
      return
    }
    if (!audioRef.current?.src) {
      flash('Звук ещё грузится в память…')
      return
    }
    setTap(null)
    setStep({ key: line.key, idx: 0 })
    playStepWord(line.key, 0)
  }, [line, playStepWord])

  const confirmStep = useCallback(() => {
    if (!line || step === null || line.key !== step.key) return
    if (step.idx >= line.words.length - 1) {
      setStep(null)
      pause()
      flash('Строка готова — проверьте её целиком')
      return
    }
    const n = step.idx + 1
    setStep({ key: line.key, idx: n })
    playStepWord(line.key, n)
  }, [line, step, playStepWord, pause])

  const cancelStep = useCallback(() => {
    setStep(null)
    pause()
  }, [pause])

  /* ---------- таппинг ---------- */

  const startTap = useCallback(() => {
    if (!line) return
    if (!audioRef.current?.src) {
      flash('Звук ещё грузится в память…')
      return
    }
    setStep(null)
    const tokens = line.text.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) {
      flash('В строке нет слов')
      return
    }
    tapBackup.current = line.words.map((w) => ({ ...w }))
    const fresh = evenWords(line.text, line.start, line.end)
    patch(line.key, { words: fresh })
    setSelWord(null)
    setTap({ key: line.key, idx: 0 })
    if (audioRef.current) audioRef.current.playbackRate = rate
    startPlayback({ from: line.start - 0.4, stopAt: null })
    flash(`Тапайте в ритме слов — их ${tokens.length}, последний тап закроет строку`)
  }, [line, rate, patch, startPlayback])

  const doTap = useCallback(() => {
    if (!tap) return
    const a = audioRef.current
    if (!a) return
    const r = rows.find((x) => x.key === tap.key)
    if (!r) {
      setTap(null) // строку удалили посреди таппинга — выходим
      return
    }
    const raw = Math.round(a.currentTime * 100) / 100
    const t = magnet ? snapToOnset(raw, onsets) : raw
    const ws = r.words.map((w) => ({ ...w }))
    const idx = tap.idx
    if (idx < ws.length) {
      ws[idx].s = t
      if (idx > 0) ws[idx - 1].e = t
      patch(r.key, { words: ws, start: idx === 0 ? Math.min(r.start, t) : r.start })
      if (r.key === line?.key) setSelWord(idx)
      setTap({ key: r.key, idx: idx + 1 })
    } else {
      ws[ws.length - 1].e = t
      patch(r.key, { words: ws, end: Math.max(r.end, t) })
      setTap(null)
      flash('Готово! Проверьте строку кнопкой проигрывания')
    }
  }, [rows, tap, magnet, onsets, patch, line])

  /* ---------- клавиатура ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      // фокус на кнопке + Enter/Space сработал бы дважды (клик + наш хендлер)
      if (tag === 'BUTTON') (e.target as HTMLElement).blur()
      if (e.code === 'Space' || (e.code === 'Enter' && step !== null)) {
        e.preventDefault()
        if (step !== null) confirmStep()
        else if (tap !== null) doTap()
        else if (playing) pause()
        else play()
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        if (selWord === null) return
        e.preventDefault()
        const d = (e.code === 'ArrowLeft' ? -0.05 : 0.05) * (e.shiftKey ? 4 : 1)
        nudge(e.altKey ? 'e' : 's', d, !e.repeat)
      } else if ((e.code === 'Delete' || e.code === 'Backspace') && selWord !== null) {
        e.preventDefault()
        deleteWord(selWord)
      } else if (e.code === 'Escape') {
        if (step !== null) cancelStep()
        else if (tap !== null) cancelTap()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tap, step, playing, selWord, doTap, play, pause, nudge, cancelTap, deleteWord, confirmStep, cancelStep])

  // «Сбросить» при открытом редакторе: перечитать song.segments, выйти из режимов.
  // Через ref-метку, чтобы сохранение (тоже меняющее song) ничего не трогало.
  const resetSeen = useRef(resetSignal)
  useEffect(() => {
    if (resetSeen.current === resetSignal) return
    resetSeen.current = resetSignal
    pause()
    const fresh = toRows(song.segments)
    setRows(fresh)
    setSelKey(fresh[0]?.key ?? null)
    setSelWord(null)
    setTap(null)
    setStep(null)
    flash('Сброшено к версии из каталога')
  })

  /* ---------- строки ---------- */

  const removeRow = useCallback((key: number) => {
    const i = rows.findIndex((r) => r.key === key)
    if (i < 0) return
    const next = rows.filter((r) => r.key !== key)
    setRows(next)
    if (key === selKey) {
      const nb = next[Math.min(i, next.length - 1)]
      setSelKey(nb ? nb.key : null)
    }
    setSelWord(null)
  }, [rows, selKey])

  const insertBelow = useCallback((key: number) => {
    setRows((rs) => {
      const i = rs.findIndex((r) => r.key === key)
      if (i < 0) return rs
      const base = rs[i]
      const s = Math.round((base.end + 0.3) * 100) / 100
      const row: Row = { start: s, end: Math.round((s + 2.5) * 100) / 100, text: 'Новая строка', words: [], key: nextKey++ }
      return [...rs.slice(0, i + 1), row, ...rs.slice(i + 1)]
    })
  }, [])

  const selectRow = useCallback((key: number, start: number) => {
    setSelWord(null)
    if (hasOriginal) playKey(key)
    else {
      setSelKey(key)
      onSeek(start)
    }
  }, [hasOriginal, playKey, onSeek])

  // Сборка сегментов + честный отчёт: где число слов разъехалось с текстом,
  // тайминги кладутся заново — пользователь должен об этом знать
  const collect = (): { segs: Segment[]; retimed: number } => {
    let retimed = 0
    const segs = rows
      .map((r) => ({
        ...r,
        start: Math.max(0, Math.round(Number(r.start) * 100) / 100 || 0),
        end: Math.max(0.1, Math.round(Number(r.end) * 100) / 100 || 0.1),
        text: r.text.trim(),
      }))
      .filter((r) => r.text.length > 0)
      .sort((a, b) => a.start - b.start)
      .map((r) => (r.end <= r.start ? { ...r, end: Math.round((r.start + 1) * 100) / 100 } : r))
      .map((r) => {
        const tokens = r.text.split(/\s+/).filter(Boolean)
        const total = tokenSpans(r.words).reduce((a, b) => a + b, 0)
        if (tokens.length > 0 && tokens.length !== total) retimed++
        return syncWords(r)
      })
    return { segs, retimed }
  }

  const pluralLines = (n: number) =>
    n % 10 === 1 && n % 100 !== 11 ? 'строка' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'строки' : 'строк'

  const save = () => {
    const { segs, retimed } = collect()
    if (segs.length === 0) {
      flash('Нет ни одной строки')
      return
    }
    saveLocalLyrics(song.id, song.language, segs)
    onSave(segs)
    flash(
      retimed > 0
        ? `Сохранено; в ${retimed} ${pluralLines(retimed)} слова легли заново — изменилось число слов, проверьте их`
        : `Сохранено: ${segs.length} строк`,
    )
  }

  const applyImport = () => {
    if (!importText.trim()) return
    const base: Segment[] = rows.map(syncWords)
    const res = applyTextToSegments(base, importText)
    const fresh = toRows(res.segments)
    setRows(fresh)
    setSelKey(fresh[0]?.key ?? null)
    setSelWord(null)
    flash(
      res.kept > 0
        ? `Заменены первые ${res.replaced} строк, остальные ${res.kept} оставлены`
        : res.appended > 0
          ? `Текст наложен, дописано строк: ${res.appended}`
          : 'Текст наложен на тайминги',
    )
  }

  const loadFromUrl = async () => {
    const url = importUrl.trim()
    if (!url) return
    setUrlBusy(true)
    try {
      const lines = await fetchLyricsFromUrl(url)
      setImportText(lines.join('\n'))
      flash(`Загружено строк: ${lines.length} — нажмите «Наложить»`)
    } catch {
      flash('Не удалось загрузить — скопируйте текст вручную')
    } finally {
      setUrlBusy(false)
    }
  }

  // Строка таппинга — именно та, куда тапаем (может отличаться от выбранной)
  const tapRow = tap ? (rows.find((x) => x.key === tap.key) ?? null) : null

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-black/70 backdrop-blur-sm">
      <div className="mx-auto flex min-h-0 w-full flex-1 flex-col p-3 sm:p-4">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#141417]">
          {song.vocals && (
            <audio
              ref={audioRef}
              preload="auto"
              onError={() => flash('Не удалось загрузить звук песни')}
            />
          )}
          <audio ref={minusRef} preload="auto" />

          {/* шапка */}
          <div className="flex items-center gap-3 border-b border-white/8 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-zinc-50">Редактор тайминга</div>
              <div className="truncate text-xs text-zinc-500">
                {song.title} · {mixMode === 'vocals' ? 'только вокал' : 'оригинал (микс)'}
              </div>
            </div>
            {notice && (
              <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-emerald-400/10 px-3 py-1.5 text-xs text-emerald-300 sm:flex">
                <Check className="h-3.5 w-3.5" /> {notice}
              </span>
            )}
            <button onClick={() => { pause(); onClose() }} aria-label="Закрыть"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/6 text-zinc-300 transition hover:bg-white/12">
              <X className="h-4 w-4" />
            </button>
          </div>

          {!hasOriginal && (
            <div className="border-b border-amber-300/20 bg-amber-300/8 px-5 py-2.5 text-[13px] text-amber-200/90">
              Нет оригинала вокала для этой песни — запустите{' '}
              <code>python web/scripts/export_songs.py</code> заново. Правка текста работает и без него.
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {hasOriginal && song.waveform && (
              <div className="border-b border-white/8 px-5 py-3">
                <p className="mb-2.5 rounded-xl bg-white/[0.03] px-3 py-2 text-[12.5px] leading-relaxed text-zinc-400">
                  Не получается попадать в ритме? Жмите «По словам»: слушайте по одному слову,
                  подгоняйте края и подтверждайте пробелом. Магнит сам тянет границы к началам звуков.
                </p>
                {/* транспорт */}
                {!audioReady && (
                  <div className="mb-2.5 flex items-center gap-2.5 rounded-xl bg-white/[0.03] px-3 py-2.5">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-300" />
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full rounded-full bg-amber-300 transition-[width]" style={{ width: `${loadPct}%` }} />
                    </div>
                    <span className="shrink-0 text-xs text-zinc-400 tabular-nums">Звук в память… {loadPct}%</span>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => (playing ? pause() : play())} aria-label="Играть/пауза" disabled={!audioReady}
                    className="grid h-11 w-11 place-items-center rounded-full bg-zinc-100 text-zinc-950 transition hover:bg-white disabled:opacity-40">
                    {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
                  </button>
                  <button onClick={() => line && playKey(line.key)} disabled={!audioReady}
                    className="rounded-full bg-white/8 px-4 py-2.5 text-[13px] font-medium text-zinc-100 transition hover:bg-white/14 disabled:opacity-40">
                    Строку с начала
                  </button>
                  <button onClick={() => setLoopLine((v) => !v)} title="Зациклить текущую строку"
                    className={`grid h-10 w-10 place-items-center rounded-full transition ${loopLine ? 'bg-amber-300 text-zinc-950' : 'bg-white/6 text-zinc-400 hover:bg-white/12'}`}>
                    <Repeat className="h-4 w-4" />
                  </button>
                  <button onClick={() => setFollow((v) => !v)}
                    title={follow ? 'Следование включено: панель сама переходит к играющей строке. Нажмите, чтобы закрепить выбор.' : 'Выбор закреплён. Нажмите, чтобы панель снова следовала за звуком.'}
                    className={`grid h-10 w-10 place-items-center rounded-full transition ${follow ? 'bg-amber-300 text-zinc-950' : 'bg-white/6 text-zinc-400 hover:bg-white/12'}`}>
                    <LocateFixed className="h-4 w-4" />
                  </button>
                  <div className="flex overflow-hidden rounded-full bg-white/6">
                    {RATES.map((r) => (
                      <button key={r} onClick={() => setRate(r)}
                        className={`px-3 py-2 text-xs tabular-nums transition ${rate === r ? 'bg-amber-300 font-semibold text-zinc-950' : 'text-zinc-400 hover:text-zinc-100'}`}>
                        {r}×
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Volume2 className="h-4 w-4 text-zinc-500" />
                    <input type="range" min={0} max={1} step={0.01} value={volume}
                      onChange={(e) => setVolume(Number(e.target.value))}
                      className="w-20 accent-zinc-300" aria-label="Громкость" />
                  </div>
                  <div className="flex items-center gap-1.5" title="Что слушаем: изолированный вокал или оригинал (микс)">
                    <div className="flex overflow-hidden rounded-full bg-white/6" role="group" aria-label="Что слушаем">
                      <button onClick={() => setMixMode('vocals')}
                        className={`px-3 py-2 text-xs transition ${mixMode === 'vocals' ? 'bg-amber-300 font-semibold text-zinc-950' : 'text-zinc-400 hover:text-zinc-100'}`}>
                        Вокал
                      </button>
                      <button onClick={() => minusOk && setMixMode('full')} disabled={!minusOk}
                        title={minusOk ? 'Оригинал: вокал + минус вместе' : 'Минус не загрузился'}
                        className={`px-3 py-2 text-xs transition disabled:opacity-40 ${mixMode === 'full' ? 'bg-amber-300 font-semibold text-zinc-950' : 'text-zinc-400 hover:text-zinc-100'}`}>
                        Микс
                      </button>
                    </div>
                    <Mic className="h-4 w-4 shrink-0 text-zinc-500" />
                    <input type="range" min={0} max={1} step={0.01} value={vocalLevel}
                      onChange={(e) => setVocalLevel(Number(e.target.value))}
                      className="w-16 accent-amber-300" aria-label="Громкость вокала-подсказки"
                      title="Громкость вокала-подсказки" />
                  </div>
                  <span className="ml-auto text-[13px] text-zinc-400 tabular-nums">
                    {formatTime(time)} / {formatTime(song.waveform.duration)}
                  </span>
                </div>

                {/* обзор */}
                <div className="mt-2.5">
                  <Waveform
                    wave={song.waveform}
                    segments={rows}
                    activeSeg={lineIdx}
                    time={time}
                    disabled={!audioReady}
                    onScrub={setScrubbing}
                    onSeek={(t) => {
                      seek(t)
                      // клик всегда выбирает БЛИЖАЙШУЮ строку — без допусков locate
                      const i = nearestSegment(rows, t)
                      const key = i >= 0 ? rows[i]?.key : undefined
                      if (key !== undefined && key !== selKey) {
                        setSelKey(key)
                        setSelWord(null)
                      }
                    }}
                  />
                </div>

                {/* текущая строка */}
                {line && (
                  <div className="mt-2.5 rounded-2xl border border-white/8 bg-white/[0.02] p-3.5">
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => { const p = rows[lineIdx - 1]; if (p) playKey(p.key) }} aria-label="Строка назад"
                        className="grid h-8 w-8 place-items-center rounded-full bg-white/6 text-zinc-300 hover:bg-white/12">
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <input value={line.text} onChange={(e) => patch(line.key, { text: e.target.value })}
                        placeholder="Текст строки"
                        className="min-w-0 flex-1 rounded-xl border border-transparent bg-transparent px-2 py-1.5 text-[16px] font-medium text-zinc-50 outline-none focus:border-white/20 focus:bg-white/5" />
                      <button onClick={() => { const p = rows[lineIdx + 1]; if (p) playKey(p.key) }} aria-label="Строка вперёд"
                        className="grid h-8 w-8 place-items-center rounded-full bg-white/6 text-zinc-300 hover:bg-white/12">
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>

                    <div className="mt-2">
                      <WordTimeline
                        wave={song.waveform}
                        line={line}
                        time={time}
                        selected={selWord}
                        tapIndex={tap && tap.key === line.key ? tap.idx : null}
                        pad={pad}
                        snapT={magnet ? (t) => snapToOnset(t, onsets) : null}
                        onSelectWord={setSelWord}
                        onChange={(ls, le, words) => changeWords(ls, le, words)}
                        onSeek={seek}
                        onPreview={(wi) => line && previewWord(line.key, wi)}
                        onScrub={setScrubbing}
                      />
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-600">
                      <span>тяните края слов · клик — послушать место · даблклик — слово целиком · ×/Delete — удалить · «+ слово» — добавить</span>
                      <span className="ml-auto flex items-center gap-1">
                        <button onClick={() => setMagnet((v) => !v)} title="Притягивать границы слов к началам звуков"
                          className={`mr-1 flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition ${magnet ? 'bg-amber-300/20 text-amber-200' : 'bg-white/8 text-zinc-500 hover:text-zinc-300'}`}>
                          <Magnet className="h-3 w-3" /> Магнит
                        </button>
                        масштаб
                        <button onClick={() => setPad((p) => Math.min(6, p + 0.5))} className="rounded bg-white/8 px-2 py-0.5 text-zinc-300">−</button>
                        <button onClick={() => setPad((p) => Math.max(0.6, p - 0.5))} className="rounded bg-white/8 px-2 py-0.5 text-zinc-300">+</button>
                      </span>
                    </div>

                    {/* слова чипами */}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {line.words.map((w, i) => (
                        <span key={i}
                          onClick={() => { setSelWord(i); seek(Math.max(0, w.s - 0.03)) }}
                          onDoubleClick={() => line && previewWord(line.key, i)}
                          title="Клик — выбрать · даблклик — прослушать · Delete — удалить"
                          className={`flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-xs tabular-nums transition ${i === selWord ? 'bg-amber-300 font-semibold text-zinc-950' : tap && tap.key === line.key && i === tap.idx ? 'bg-amber-300/25 text-amber-200' : 'bg-white/6 text-zinc-300 hover:bg-white/12'}`}>
                          {w.w} <span className="opacity-60">{w.s.toFixed(1)}</span>
                          <span
                            role="button"
                            aria-label={`Удалить слово ${w.w}`}
                            title="Удалить слово"
                            onClick={(e) => { e.stopPropagation(); deleteWord(i) }}
                            className={`grid h-4 w-4 place-items-center rounded-full text-[11px] leading-none transition ${i === selWord ? 'text-zinc-700 hover:bg-black/15' : 'text-zinc-500 hover:bg-white/15 hover:text-zinc-100'}`}
                          >
                            ×
                          </span>
                        </span>
                      ))}
                      <button onClick={addWord} title="Добавить слово после выбранного (или в конец)"
                        className="rounded-lg border border-dashed border-white/20 px-2 py-1 text-xs text-zinc-400 transition hover:border-amber-300/60 hover:text-amber-200">
                        + слово
                      </button>
                      <button onClick={mergeWord} disabled={selWord === null || selWord >= line.words.length - 1}
                        title="Склеить выбранное слово со следующим"
                        className="rounded-lg px-2 py-1 text-xs text-zinc-400 transition hover:bg-white/8 hover:text-zinc-100 disabled:opacity-30">
                        Объединить
                      </button>
                      <button onClick={splitWord} disabled={selWord === null}
                        title="Разрезать выбранное слово в позиции курсора (или посередине)"
                        className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-zinc-400 transition hover:bg-white/8 hover:text-zinc-100 disabled:opacity-30">
                        <Scissors className="h-3 w-3" /> Разрезать
                      </button>
                    </div>

                    {/* пошаговая панель */}
                    {step !== null && line && line.key === step.key && line.words[step.idx] && (
                      <div className="mt-2.5 rounded-xl bg-amber-300/8 p-3">
                        <div className="flex items-center gap-3">
                          <span className="min-w-0 flex-1 truncate text-2xl font-bold text-amber-200">
                            {line.words[step.idx].w}
                          </span>
                          <span className="shrink-0 text-xs text-zinc-400 tabular-nums">
                            слово {step.idx + 1} из {line.words.length}
                          </span>
                          <div className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-white/10">
                            <div className="h-full rounded-full bg-amber-300 transition-[width]"
                              style={{ width: `${((step.idx + 1) / line.words.length) * 100}%` }} />
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <button onClick={() => playStepWord(step.key, step.idx)}
                            className="rounded-xl bg-white/8 px-4 py-2 text-[13px] font-medium text-zinc-100 transition hover:bg-white/14">
                            Слушать ещё раз
                          </button>
                          <button onClick={confirmStep}
                            className="rounded-xl bg-amber-300 px-5 py-2 text-[13px] font-bold text-zinc-950 transition hover:bg-amber-200">
                            {step.idx >= line.words.length - 1 ? 'Готово ✓' : 'Дальше ✓ · пробел'}
                          </button>
                          <button onClick={cancelStep}
                            className="rounded-xl px-3 py-2 text-[13px] text-zinc-500 transition hover:text-zinc-200">
                            Выйти
                          </button>
                        </div>
                      </div>
                    )}

                    {/* точная подгонка + режимы */}
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <div className="flex items-center gap-1 rounded-xl bg-white/5 px-2 py-1.5">
                        <span className="px-1 text-[11px] text-zinc-500">начало</span>
                        <button onClick={() => nudge('s', -0.05)} className="rounded-md bg-white/8 px-2 py-1 text-xs text-zinc-200 hover:bg-white/14">−50</button>
                        <button onClick={() => nudge('s', 0.05)} className="rounded-md bg-white/8 px-2 py-1 text-xs text-zinc-200 hover:bg-white/14">+50</button>
                      </div>
                      <div className="flex items-center gap-1 rounded-xl bg-white/5 px-2 py-1.5">
                        <span className="px-1 text-[11px] text-zinc-500">конец</span>
                        <button onClick={() => nudge('e', -0.05)} className="rounded-md bg-white/8 px-2 py-1 text-xs text-zinc-200 hover:bg-white/14">−50</button>
                        <button onClick={() => nudge('e', 0.05)} className="rounded-md bg-white/8 px-2 py-1 text-xs text-zinc-200 hover:bg-white/14">+50</button>
                      </div>
                      <span className="hidden text-[11px] text-zinc-600 xl:block">←/→ край · Shift ×4 · Alt — конец</span>
                      <div className="ml-auto flex items-center gap-2">
                        {step === null && tap === null && (
                          <>
                            <button onClick={startStep} title="Слушать по одному слову и подтверждать пробелом" disabled={!audioReady}
                              className="flex items-center gap-1.5 rounded-xl bg-white/8 px-4 py-2 text-[13px] font-medium text-zinc-100 transition hover:bg-white/14 disabled:opacity-40">
                              <SkipForward className="h-4 w-4" /> По словам
                            </button>
                            <button onClick={startTap} disabled={!audioReady}
                              className="flex items-center gap-1.5 rounded-xl bg-amber-300 px-4 py-2 text-[13px] font-semibold text-zinc-950 transition hover:bg-amber-200 disabled:opacity-40">
                              <MousePointerClick className="h-4 w-4" /> Таппинг
                            </button>
                          </>
                        )}
                        {tap !== null && tapRow && (
                          <>
                            <span className="text-xs text-zinc-400 tabular-nums">
                              {Math.min(tap.idx + 1, tapRow.words.length + 1)}/{tapRow.words.length + 1}
                            </span>
                            <button onClick={doTap}
                              className="animate-pulse rounded-xl bg-amber-300 px-6 py-2 text-[13px] font-bold text-zinc-950 transition hover:bg-amber-200">
                              ТАП{tap.idx >= tapRow.words.length ? ' (конец)' : `: ${tapRow.words[Math.min(tap.idx, tapRow.words.length - 1)]?.w}`}
                            </button>
                            <button onClick={cancelTap} className="rounded-xl bg-white/8 px-3 py-2 text-[13px] text-zinc-300 hover:bg-white/14">
                              Отмена
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* строки под редактором */}
            {/* список строк */}
            <div className="px-4 py-3 sm:px-5">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
                Строки · клик — выбрать и слушать
              </div>
              {rows.map((r, i) => (
                <LineRow key={r.key} r={r} num={i + 1} selected={r.key === line?.key}
                  onSelect={selectRow} onPatch={patch} onInsert={insertBelow} onRemove={removeRow} />
              ))}
            </div>

            {/* импорт */}
            <div className="border-t border-white/8 px-5 py-3">
              <button onClick={() => setShowImport((v) => !v)}
                className="flex items-center gap-2 text-[13px] font-medium text-amber-200/90 hover:text-amber-200">
                <Link2 className="h-3.5 w-3.5" />
                {showImport ? 'Скрыть импорт' : 'Вставить текст / загрузить с Genius'}
              </button>
              {showImport && (
                <div className="mt-3">
                  <div className="flex gap-2">
                    <input value={importUrl} onChange={(e) => setImportUrl(e.target.value)}
                      placeholder="https://genius.com/…-lyrics"
                      className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-white/25" />
                    <button onClick={() => void loadFromUrl()} disabled={urlBusy || !importUrl.trim()}
                      className="flex shrink-0 items-center gap-1.5 rounded-xl bg-white/8 px-3.5 py-2 text-[13px] font-medium text-zinc-100 transition hover:bg-white/14 disabled:opacity-40">
                      {urlBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Загрузить'}
                    </button>
                  </div>
                  <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={5}
                    placeholder="…или вставьте текст песни построчно (строки в [скобках] пропускаются)"
                    className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[13px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-white/25" />
                  <button onClick={applyImport} disabled={!importText.trim()}
                    className="mt-2 rounded-xl bg-amber-300 px-4 py-2 text-[13px] font-semibold text-zinc-950 transition hover:bg-amber-200 disabled:opacity-40">
                    Наложить на текущие тайминги
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* подвал */}
          <div className="flex flex-wrap items-center gap-2 border-t border-white/8 px-5 py-3.5">
            <button onClick={save}
              className="rounded-xl bg-amber-300 px-5 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-amber-200">
              Сохранить
            </button>
            <button onClick={() => downloadLyrics(song.id, song.language, collect().segs)}
              title="Скачать lyrics.json — положите его в web/public/songs/<id>/ и в output/... чтобы сохранить навсегда"
              className="flex items-center gap-1.5 rounded-xl bg-white/8 px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/14">
              <Download className="h-4 w-4" /> Скачать .json
            </button>
            <button onClick={onReset}
              className="flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-sm text-zinc-500 transition hover:text-zinc-200">
              <RotateCcw className="h-3.5 w-3.5" /> Сбросить
            </button>
            <span className="ml-auto hidden text-xs text-zinc-600 lg:block">
              пробел — играть/тап/дальше · клик по волне — перемотка
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
