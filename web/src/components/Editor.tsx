import {
  ArrowDownWideNarrow, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, Link2, Loader2, LocateFixed, Magnet, MousePointerClick,
  Pause, Play, Plus, Redo2, Repeat, RotateCcw, Scissors, SkipForward, Trash2, Undo2, Volume2, X,
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AuthRequiredError } from '../lib/api'
import { EditorAudioEngine } from '../lib/audioEngine'
import { computeOnsets, snapToOnset } from '../lib/onsets'
import { mp3UrlToWavBlobUrl } from '../lib/wav'
import {
  applyTextToSegments,
  downloadLyrics,
  evenWords,
  fetchLyricsFromUrl,
  formatTimeMs,
  locate,
  nearestSegment,
  plural,
  saveSongLyrics,
  sortRowsByStart,
  validSkips,
} from '../lib/songs'
import type { Segment, SkipRange, SongData, Word } from '../lib/types'
import Waveform from './editor/Waveform'
import WordTimeline from './editor/WordTimeline'

interface Props {
  song: SongData
  onClose: () => void
  onSave: (segments: Segment[], skips: SkipRange[]) => void
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

import { normalizeWords, syncWords, tokenSpans, tokenStart } from '../lib/wordModel'

interface LineWordsProps {
  r: Row
  num: number
  selected: boolean
  selWordIdx: number | null
  tapIdx: number | null
  onGoto: (key: number, wi: number) => void
  onDelete: (key: number, wi: number) => void
  onPreview: (key: number, wi: number) => void
}

/** слова одной строки: мемоизировано, не дёргается от тиков времени */
const LineWords = memo(function LineWords({ r, num, selected, selWordIdx, tapIdx, onGoto, onDelete, onPreview }: LineWordsProps) {
  return (
    <div className={`mb-1 rounded-xl px-2 py-1.5 ${selected ? 'bg-primary/[0.07]' : ''}`}>
      <div className="mb-1 flex items-baseline gap-2">
        <span className={`shrink-0 text-[11px] font-semibold tabular-nums ${selected ? 'text-primary' : 'text-muted/70'}`}>
          {num}
        </span>
        {r.part && <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted/70">{r.part}</span>}
        <span className="truncate text-[11px] text-muted">{r.text}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {r.words.map((w, i) => (
          <span key={i}
            onClick={() => onGoto(r.key, i)}
            onDoubleClick={() => onPreview(r.key, i)}
            title="Клик — выбрать · даблклик — прослушать · Delete — удалить"
            className={`flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-xs tabular-nums transition ${i === selWordIdx ? 'bg-primary font-semibold text-white' : i === tapIdx ? 'bg-primary/25 text-primary' : 'bg-surface-hover text-text hover:bg-border'}`}>
            {w.w} <span className="opacity-60">{w.s.toFixed(2)}</span>
            <span
              role="button"
              aria-label={`Удалить слово ${w.w}`}
              title="Удалить слово"
              onClick={(e) => { e.stopPropagation(); onDelete(r.key, i) }}
              className={`grid h-4 w-4 place-items-center rounded-full text-[11px] leading-none transition ${i === selWordIdx ? 'text-zinc-700 hover:bg-border' : 'text-muted hover:bg-border hover:text-text'}`}
            >
              ×
            </span>
          </span>
        ))}
        {r.words.length === 0 && <span className="text-[11px] text-muted/70">нет слов</span>}
      </div>
    </div>
  )
})

export default function Editor({ song, onClose, onSave, onReset, onSeek, resetSignal }: Props) {
  const [rows, setRows] = useState<Row[]>(() => toRows(song.segments))
  // Пропуски «не поём»: в плеере там слышно оригинал, очки не судятся
  const [skips, setSkips] = useState<SkipRange[]>(() => validSkips(song.skips))
  // режим выделения пропуска прямо на волне: таскание рисует диапазон
  const [selectSkip, setSelectSkip] = useState(false)
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

  // транспорт оригинала — живёт в движке, здесь только UI-состояние
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [rate, setRate] = useState(1)
  const [loopLine, setLoopLine] = useState(false)
  const [volume, setVolume] = useState(1)
  const [pad, setPad] = useState(1.5)

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
  // идёт декодирование mp3 -> WAV для посемпловой точности
  const [decoding, setDecoding] = useState(false)

  // Играем полную песню одной дорожкой; без original — запасной вокал.
  // Waveform/onsets всегда по вокалу (waveform.json), это независимо от трека.
  const playUrl = song.original ?? song.vocals ?? null

  // Движок живёт в ref: создаём заново на каждую песню, UI только подписывается
  const engineRef = useRef<EditorAudioEngine | null>(null)

  useEffect(() => {
    // через WAV-режим: шкала делится пополам (загрузка/декод | заливка в движок)
    let wavMode = false
    const eng = new EditorAudioEngine({
      onPlayingChange: (v) => setPlaying(v),
      onTime: (t) => setTime(t),
      onProgress: (p) => setLoadPct(wavMode ? 50 + Math.round(p / 2) : p),
      onReady: () => setAudioReady(true),
      onStuck: () => flash('Звук завис — нажмите play ещё раз'),
      onError: (m) => {
        if (m === 'loading') flash('Звук ещё грузится в память…')
        else if (m === 'blocked') flash('Браузер не дал звук — нажмите play ещё раз')
        else flash(m)
      },
    })
    engineRef.current = eng
    setAudioReady(false)
    setLoadPct(0)
    setDecoding(false)
    let dead = false
    let wavUrl: string | null = null
    void (async () => {
      try {
        let srcUrl = playUrl
        if (playUrl && /\.mp3(\?|#|$)/i.test(playUrl)) {
          // точный звук: MP3 мотается по кадрам (~26мс), WAV — посемплово.
          // Декодируем при входе; не вышло — играем mp3 как раньше.
          setDecoding(true)
          try {
            wavUrl = await mp3UrlToWavBlobUrl(playUrl, (p) => {
              if (!dead) setLoadPct(Math.round(p / 2))
            })
            if (!dead) setLoadPct(50)
          } catch {
            wavUrl = null
          } finally {
            if (!dead) setDecoding(false)
          }
          if (wavUrl) {
            srcUrl = wavUrl
            wavMode = true
          }
        }
        if (dead) return
        await eng.load(srcUrl, null)
      } catch {
        if (!dead) await eng.load(playUrl, null).catch(() => undefined)
      } finally {
        if (dead && wavUrl) URL.revokeObjectURL(wavUrl)
      }
    })()
    return () => {
      dead = true
      eng.destroy()
      if (engineRef.current === eng) engineRef.current = null
      if (wavUrl) URL.revokeObjectURL(wavUrl)
    }
  }, [song.id, playUrl])

  const hasOriginal = Boolean(playUrl && song.waveform && song.waveform.peaks.length > 0)
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

  // история правок для отмены: прошлое/будущее + метка последнего снимка (против спама)
  const hist = useRef<{ past: Row[][]; future: Row[][]; lastPush: number }>({ past: [], future: [], lastPush: 0 })
  const rowsRef = useRef<Row[]>([])
  rowsRef.current = rows
  // есть несохранённые правки
  const [dirty, setDirty] = useState(false)

  /** снимок строк в историю; force — точный (перед удалением/склейкой), иначе не чаще 1.2с */
  const pushUndo = useCallback((force = false) => {
    const h = hist.current
    const now = Date.now()
    if (!force && now - h.lastPush < 1200) return
    h.lastPush = now
    h.past.push(structuredClone(rowsRef.current))
    if (h.past.length > 60) h.past.shift()
    h.future = []
  }, [])

  const undo = useCallback(() => {
    const h = hist.current
    const prev = h.past.pop()
    if (!prev) {
      flash('Нечего отменять')
      return
    }
    h.future.push(structuredClone(rowsRef.current))
    setTap(null)
    setStep(null)
    setSelWord(null)
    setRows(prev)
  }, [])

  const redo = useCallback(() => {
    const h = hist.current
    const next = h.future.pop()
    if (!next) {
      flash('Нечего возвращать')
      return
    }
    h.past.push(structuredClone(rowsRef.current))
    setTap(null)
    setStep(null)
    setSelWord(null)
    setRows(next)
  }, [])

  const patch = useCallback((key: number, p: Partial<Row>) => {
    pushUndo(false)
    setDirty(true)
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))
  }, [pushUndo])

  /* ---------- транспорт: вся механика — в EditorAudioEngine ---------- */

  /** запустить с позиции + выбрать строку/слово; промахи движка он сообщает сам */
  const playRange = useCallback(
    (
      from: number,
      stopAt: number | null,
      selKey?: number | null,
      selWord?: number | null,
    ) => {
      if (selKey !== undefined) {
        setSelKey(selKey)
        setSelWord(selWord ?? null)
      }
      engineRef.current?.playFrom(from, { stopAt })
    },
    [],
  )

  // настройки движка следуют за UI
  useEffect(() => {
    const e = engineRef.current
    if (!e) return
    e.setRate(rate)
    e.setVolume(volume, 1)
  }, [rate, volume])

  // повтор строки — регионом движка; в ручных режимах выключен
  useEffect(() => {
    engineRef.current?.setLoop(
      loopLine && !tap && !step && line
        ? { start: line.start - 0.1, end: line.end + 0.25 }
        : null,
    )
  }, [loopLine, tap, step, line])

  const play = useCallback(() => {
    engineRef.current?.resume()
  }, [])

  const pause = useCallback(() => {
    engineRef.current?.pause()
  }, [])

  const seek = useCallback((t: number) => {
    engineRef.current?.seek(t)
  }, [])

  /** клик по обзору: выбрать ближайшую строку и ЗАИГРАТЬ с позиции (а не молча мотать) */
  const seekAndPlay = useCallback((t: number) => {
    const i = nearestSegment(rows, t)
    const k = i >= 0 ? rows[i]?.key : undefined
    if (k !== undefined) {
      setSelKey(k)
      setSelWord(null)
    }
    // не готов — хотя бы двигаем курсор, playFrom сам скажет причину
    if (engineRef.current?.playFrom(t, { stopAt: null }) === false) {
      engineRef.current?.seek(t)
    }
  }, [rows])

  /** тап по ленте слов: слово уже выбрано хит-тестом, просто играем с позиции */
  const playAt = useCallback((t: number) => {
    if (engineRef.current?.playFrom(t, { stopAt: null }) === false) {
      engineRef.current?.seek(t)
    }
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
    playRange(r.start - 0.2, loopLine ? null : r.end + 0.3, key, null)
  }, [rows, loopLine, playRange, cancelTap])

  const previewWord = useCallback((key: number, wi: number) => {
    const r = rows.find((x) => x.key === key)
    const w = r?.words[wi]
    if (!w) return
    playRange(w.s - 0.03, w.e + 0.05, key, wi)
  }, [rows, playRange])

  // Пока палец на волне (скраб/таскание слов) — автоподхват выбора молчит,
  // иначе выбор прыгает между строкой под пальцем и отстающим звуком
  const scrubbingRef = useRef(false)
  const setScrubbing = useCallback((v: boolean) => {
    scrubbingRef.current = v
  }, [])
  // автоскролл панели слов к выбранной строке
  const groupRefs = useRef(new Map<number, HTMLDivElement>())
  useEffect(() => {
    if (selKey == null) return
    groupRefs.current.get(selKey)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selKey])

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

  const changeWordsByKey = useCallback((key: number, ls: number, le: number, words: Word[]) => {
    patch(key, { start: ls, end: le, words })
  }, [patch])

  // Лента: текущая ярко + соседи для контекста
  const tlBlocks = useMemo(() => {
    if (!line || lineIdx < 0) return []
    const out: { key: number; words: Word[]; active: boolean; start: number; end: number }[] = []
    const prev = rows[lineIdx - 1]
    if (prev) out.push({ key: prev.key, words: prev.words, active: false, start: prev.start, end: prev.end })
    out.push({ key: line.key, words: line.words, active: true, start: line.start, end: line.end })
    const next = rows[lineIdx + 1]
    if (next) out.push({ key: next.key, words: next.words, active: false, start: next.start, end: next.end })
    return out
  }, [rows, line, lineIdx])

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

  /** удалить слово конкретной строки (для общей панели слов) */
  const deleteWordIn = useCallback((key: number, idx: number) => {
    const target = rows.find((x) => x.key === key)
    if (!target || idx < 0) return
    pushUndo(true)
    abortModesOnLine(key)
    const r = syncCounts(target)
    if (r.words.length <= 1) {
      flash('Последнее слово не удаляю — удалите строку целиком')
      return
    }
    if (idx >= r.words.length) return
    const spans = tokenSpans(r.words)
    const tokens = r.text.split(/\s+/).filter(Boolean)
    tokens.splice(tokenStart(spans, idx), spans[idx])
    patch(key, { text: tokens.join(' '), words: r.words.filter((_, i) => i !== idx) })
    if (key === line?.key) setSelWord(null)
  }, [rows, line, patch, tap, step, pushUndo])

  const deleteWord = useCallback((idx: number) => {
    if (!line) return
    deleteWordIn(line.key, idx)
  }, [line, deleteWordIn])

  /** ручной выбор слова (клик по ленте/списку): закрепляем — следование за звуком больше не дёргает */
  const manualSelect = useCallback((key: number, wi: number | null) => {
    setSelKey(key)
    setSelWord(wi)
    if (playing && follow) {
      setFollow(false)
      flash('Выбор закреплён — следование за звуком выключено')
    }
  }, [playing, follow])

  /** перейти к слову любой строки: выбрать строку + слово, поставить курсор */
  const gotoWord = useCallback((key: number, wi: number) => {
    const r = rows.find((x) => x.key === key)
    const w = r?.words[wi]
    if (!r || !w) return
    manualSelect(key, wi)
    seek(Math.max(0, w.s - 0.03))
  }, [rows, seek, manualSelect])

  const addWord = useCallback(() => {
    if (!line) return
    pushUndo(true)
    abortModesOnLine(line.key)
    const r = syncCounts(line)
    const tokens = r.text.split(/\s+/).filter(Boolean)
    const at = selWord === null ? r.words.length - 1 : Math.min(selWord, r.words.length - 1)
    const prevE = at >= 0 ? r.words[at].e : r.start
    const nextS = at + 1 < r.words.length ? r.words[at + 1].s : r.end
    const s = Math.round(Math.min(Math.max(prevE, r.start), Math.max(r.start, nextS - 0.15)) * 1000) / 1000
    const e = Math.round(Math.min(s + 0.4, nextS) * 1000) / 1000
    const words = [...r.words]
    words.splice(at + 1, 0, { w: '…', s, e })
    const spans = tokenSpans(r.words)
    tokens.splice(at >= 0 ? tokenStart(spans, at) + spans[at] : 0, 0, '…')
    patch(line.key, { text: tokens.join(' '), words, end: Math.max(r.end, e) })
    setSelWord(at + 1)
    flash('Новое слово «…» — замените его текстом в строке выше')
  }, [line, selWord, patch, tap, step, pushUndo])

  const nudge = useCallback((edge: 's' | 'e', delta: number, replay = true) => {
    if (!line || selWord === null) return
    const ws = line.words.map((w) => ({ ...w }))
    const w = ws[selWord]
    if (!w) return
    if (edge === 's') {
      const lo = selWord > 0 ? ws[selWord - 1].e : 0
      w.s = Math.round(Math.max(lo, Math.min(w.s + delta, w.e - 0.06)) * 1000) / 1000
    } else {
      const hi = selWord < ws.length - 1 ? ws[selWord + 1].s : line.end + pad + 1
      w.e = Math.round(Math.min(hi, Math.max(w.e + delta, w.s + 0.06)) * 1000) / 1000
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
    pushUndo(true)
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
  }, [line, selWord, patch, tap, step, pushUndo])

  /** разрезать выбранное слово в позиции курсора (иначе посередине) */
  const splitWord = useCallback(() => {
    if (!line || selWord === null) return
    pushUndo(true)
    abortModesOnLine(line.key)
    const r = syncCounts(line)
    const w = r.words[selWord]
    if (!w) return
    const at = time > w.s + 0.1 && time < w.e - 0.1
      ? Math.round(time * 1000) / 1000
      : Math.round(((w.s + w.e) / 2) * 1000) / 1000
    const words = [...r.words]
    words.splice(selWord, 1, { ...w, e: at }, { w: '…', s: at, e: w.e })
    const spans = tokenSpans(r.words)
    const tokens = r.text.split(/\s+/).filter(Boolean)
    tokens.splice(tokenStart(spans, selWord) + spans[selWord], 0, '…')
    patch(line.key, { text: tokens.join(' '), words })
    setSelWord(selWord + 1)
    flash('Слово разрезано — вторую часть переименуйте в строке')
  }, [line, selWord, time, patch, tap, step, pushUndo])

  /* ---------- правка выбранного слова: текст и границы явно ---------- */

  /** переименовать выбранное слово (токены строки правим вместе, иначе тайминги слетят) */
  const editWordText = useCallback((text: string) => {
    if (!line || selWord === null) return
    const w = line.words[selWord]
    if (!w) return
    abortModesOnLine(line.key)
    const spans = tokenSpans(line.words)
    const tokens = line.text.split(/\s+/).filter(Boolean)
    const next = text.split(/\s+/).filter(Boolean)
    tokens.splice(tokenStart(spans, selWord), spans[selWord], ...(next.length > 0 ? next : ['…']))
    patch(line.key, {
      text: tokens.join(' '),
      words: line.words.map((x, i) => (i === selWord ? { ...x, w: next.join(' ') || '…' } : x)),
    })
  }, [line, selWord, patch, tap, step])

  /** выставить границу выбранного слова числом (мс), с упорами в соседей */
  const setWordTime = useCallback((edge: 's' | 'e', v: number) => {
    if (!line || selWord === null || !Number.isFinite(v)) return
    const ws = line.words.map((w) => ({ ...w }))
    const w = ws[selWord]
    if (!w) return
    if (edge === 's') {
      const lo = selWord > 0 ? ws[selWord - 1].e : 0
      w.s = Math.round(Math.max(lo, Math.min(v, w.e - 0.06)) * 1000) / 1000
    } else {
      const hi = selWord < ws.length - 1 ? ws[selWord + 1].s : line.end + pad + 1
      w.e = Math.round(Math.min(hi, Math.max(v, w.s + 0.06)) * 1000) / 1000
    }
    patch(line.key, {
      words: ws,
      start: selWord === 0 ? Math.min(line.start, ws[0].s) : line.start,
      end: selWord === ws.length - 1 ? Math.max(line.end, ws[ws.length - 1].e) : line.end,
    })
  }, [line, selWord, pad, patch])

  /* ---------- пошаговый режим: слушаем по одному слову ---------- */

  const playStepWord = useCallback((key: number, wi: number) => {
    const r = rows.find((x) => x.key === key)
    const w = r?.words[wi]
    if (!w) return
    playRange(w.s - 0.15, w.e + 0.12, undefined, wi)
  }, [rows, playRange])

  const startStep = useCallback(() => {
    if (!line || !line.words.length) {
      flash('В строке нет слов')
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
    playRange(line.start - 0.4, null)
    flash(`Тапайте в ритме слов — их ${tokens.length}, последний тап закроет строку`)
  }, [line, patch, playRange])

  const doTap = useCallback(() => {
    if (!tap) return
    const eng = engineRef.current
    if (!eng) return
    const r = rows.find((x) => x.key === tap.key)
    if (!r) {
      setTap(null) // строку удалили посреди таппинга — выходим
      return
    }
    const raw = Math.round(eng.getTime() * 1000) / 1000
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

  /** закрыть (крестик/Esc): несохранённое спросить, иначе молча */
  const closeMaybe = useCallback(() => {
    if (dirty && !window.confirm('Есть несохранённые правки — закрыть без сохранения?')) return
    pause()
    onClose()
  }, [dirty, pause, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      // фокус на кнопке + Enter/Space сработал бы дважды (клик + наш хендлер)
      if (tag === 'BUTTON') (e.target as HTMLElement).blur()
      // отмена/возврат — раньше нативных, но не в полях ввода (там своя)
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
        e.preventDefault()
        redo()
        return
      }
      if (e.code === 'Space' || (e.code === 'Enter' && step !== null)) {
        e.preventDefault()
        if (step !== null) confirmStep()
        else if (tap !== null) doTap()
        else if (playing) pause()
        else play()
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        if (selWord === null) return
        e.preventDefault()
        const d = (e.code === 'ArrowLeft' ? -0.01 : 0.01) * (e.shiftKey ? 4 : 1)
        nudge(e.altKey ? 'e' : 's', d, !e.repeat)
      } else if ((e.code === 'Delete' || e.code === 'Backspace') && selWord !== null) {
        e.preventDefault()
        deleteWord(selWord)
      } else if (e.code === 'Escape') {
        if (step !== null) cancelStep()
        else if (tap !== null) cancelTap()
        else closeMaybe()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tap, step, playing, selWord, doTap, play, pause, nudge, cancelTap, deleteWord, confirmStep, cancelStep, undo, redo, closeMaybe])

  // «Сбросить» при открытом редакторе: перечитать song.segments, выйти из режимов.
  // Через ref-метку, чтобы сохранение (тоже меняющее song) ничего не трогало.
  const resetSeen = useRef(resetSignal)
  useEffect(() => {
    if (resetSeen.current === resetSignal) return
    resetSeen.current = resetSignal
    pause()
    const fresh = toRows(song.segments)
    setRows(fresh)
    setSkips(validSkips(song.skips))
    setSelectSkip(false)
    setSelKey(fresh[0]?.key ?? null)
    setSelWord(null)
    setTap(null)
    setStep(null)
    hist.current = { past: [], future: [], lastPush: 0 }
    setDirty(false)
    flash('Сброшено к версии из каталога')
  })

  /* ---------- строки ---------- */

  const removeRow = useCallback((key: number) => {
    const i = rows.findIndex((r) => r.key === key)
    if (i < 0) return
    pushUndo(true)
    setDirty(true)
    const next = rows.filter((r) => r.key !== key)
    setRows(next)
    if (key === selKey) {
      const nb = next[Math.min(i, next.length - 1)]
      setSelKey(nb ? nb.key : null)
    }
    setSelWord(null)
  }, [rows, selKey, pushUndo])

  const insertBelow = useCallback((key: number) => {
    pushUndo(true)
    setDirty(true)
    setRows((rs) => {
      const i = rs.findIndex((r) => r.key === key)
      if (i < 0) return rs
      const base = rs[i]
        const s = Math.round((base.end + 0.3) * 1000) / 1000
        const row: Row = { start: s, end: Math.round((s + 2.5) * 1000) / 1000, text: 'Новая строка', words: [], key: nextKey++ }
      return [...rs.slice(0, i + 1), row, ...rs.slice(i + 1)]
    })
  }, [pushUndo])

  /** поменять строку местами с соседней: только порядок, время не трогаем */
  const moveLine = useCallback((dir: -1 | 1) => {
    if (!line) return
    const i = rows.findIndex((r) => r.key === line.key)
    const j = i + dir
    if (i < 0 || j < 0 || j >= rows.length) return
    const a = rows[i]
    const b = rows[j]
    if (!a || !b) return
    pushUndo(true)
    setDirty(true)
    const next = [...rows]
    next[i] = b
    next[j] = a
    setRows(next)
    flash('Строки поменялись местами')
  }, [line, rows, pushUndo])

  /** разложить строки по времени одной кнопкой (вместо автосортировки) */
  const sortByTime = useCallback(() => {
    pushUndo(true)
    setDirty(true)
    setRows((rs) => sortRowsByStart(rs))
    flash('Строки упорядочены по времени')
  }, [pushUndo])
  /** шаг на соседнюю строку: со звуком — играть её, без звука — выбрать + двинуть минус */
  const goLine = useCallback((dir: -1 | 1) => {
    const nb = rows[lineIdx + dir]
    if (!nb) return
    setSelWord(null)
    if (hasOriginal) playKey(nb.key)
    else {
      setSelKey(nb.key)
      onSeek(nb.start)
    }
  }, [rows, lineIdx, hasOriginal, playKey, onSeek])

  /** шапка текущей строки: выбор стрелками, текст, тайминги, раздел, +/удалить */
  const renderLineHead = () => {
    if (!line) return null
    return (
      <>
        <div className="flex items-center gap-1.5">
          <button onClick={() => goLine(-1)} aria-label="Строка назад"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-hover text-text hover:bg-border">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="shrink-0 text-[11px] text-muted tabular-nums">{lineIdx + 1}/{rows.length}</span>
          <input value={line.text} onChange={(e) => patch(line.key, { text: e.target.value })}
            placeholder="Текст строки"
            className="min-w-0 flex-1 rounded-xl border border-transparent bg-transparent px-2 py-1 text-[16px] font-medium text-text outline-none focus:border-border focus:bg-surface-hover" />
          <button onClick={() => goLine(1)} aria-label="Строка вперёд"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-hover text-text hover:bg-border">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <input type="number" step={0.001} min={0} value={line.start} title="Начало строки, сек"
            onChange={(e) => patch(line.key, { start: Number(e.target.value) })}
            className="w-[76px] shrink-0 rounded-lg border border-border bg-surface-hover px-1 py-1.5 text-center text-xs text-text tabular-nums outline-none focus:border-primary" />
          <input type="number" step={0.001} min={0} value={line.end} title="Конец строки, сек"
            onChange={(e) => patch(line.key, { end: Number(e.target.value) })}
            className="w-[76px] shrink-0 rounded-lg border border-border bg-surface-hover px-1 py-1.5 text-center text-xs text-text tabular-nums outline-none focus:border-primary" />
          <select value={line.part ?? ''} onChange={(e) => patch(line.key, { part: e.target.value || undefined })}
            title="Раздел песни"
            className="w-[110px] shrink-0 rounded-lg border border-border bg-surface-hover px-1 py-1.5 text-xs text-text outline-none">
            {PARTS.map((p) => (
              <option key={p} value={p}>{p || '—'}</option>
            ))}
          </select>
          <span className="text-[11px] text-muted/70 tabular-nums">
            длит. {Math.max(0, line.end - line.start).toFixed(2)}с
          </span>
                  <button onClick={() => moveLine(-1)} disabled={lineIdx <= 0} title="Строку выше (только порядок, время не трогаем)"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface-hover hover:text-text disabled:opacity-30">
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => moveLine(1)} disabled={lineIdx >= rows.length - 1} title="Строку ниже (только порядок, время не трогаем)"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface-hover hover:text-text disabled:opacity-30">
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={sortByTime} title="Упорядочить все строки по времени"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface-hover hover:text-text">
                    <ArrowDownWideNarrow className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => insertBelow(line.key)} title="Добавить строку ниже"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface-hover hover:text-text">
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => removeRow(line.key)} title="Удалить строку"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-danger/15 hover:text-danger">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </>
    )
  }

  // Сборка сегментов + честный отчёт: где число слов разъехалось с текстом,
  // тайминги кладутся заново — пользователь должен об этом знать.
  // Границы слов нормализуем: clamp в строку, монотонность, мс.
  const collect = (): { segs: Segment[]; retimed: number } => {
    let retimed = 0
    const segs = rows
      .map((r) => ({
        ...r,
        start: Math.max(0, Math.round(Number(r.start) * 1000) / 1000 || 0),
        end: Math.max(0.1, Math.round(Number(r.end) * 1000) / 1000 || 0.1),
        text: r.text.trim(),
      }))
      .filter((r) => r.text.length > 0)
      // порядок — как расставил редактор (без автосортировки); караоке играет по времени само
      .map((r) => (r.end <= r.start ? { ...r, end: Math.round((r.start + 1) * 1000) / 1000 } : r))
      .map((r) => {
        const tokens = r.text.split(/\s+/).filter(Boolean)
        const total = tokenSpans(r.words).reduce((a, b) => a + b, 0)
        if (tokens.length > 0 && tokens.length !== total) retimed++
        const synced = syncWords(r)
        return { ...synced, words: normalizeWords(synced.words, synced.start, synced.end) }
      })
    return { segs, retimed }
  }

  const pluralLines = (n: number) => plural(n, 'строка', 'строки', 'строк')

  const save = () => {
    const { segs, retimed } = collect()
    if (segs.length === 0) {
      flash('Нет ни одной строки')
      return
    }
    const snapSkips = [...skips]
    void saveSongLyrics(song.id, song.language, segs, snapSkips)
      .then((where) => {
        onSave(segs, snapSkips)
        setDirty(false)
        const tail = where === 'server' ? 'на сервер' : 'локально (сервер недоступен)'
        flash(
          retimed > 0
            ? `Сохранено ${tail}; в ${retimed} ${pluralLines(retimed)} слова легли заново — изменилось число слов, проверьте их`
            : `Сохранено ${tail}: ${segs.length} строк`,
        )
      })
      .catch((e: unknown) => {
        flash(e instanceof AuthRequiredError ? e.message : 'Не удалось сохранить — попробуйте снова')
      })
  }

  const applyImport = () => {
    if (!importText.trim()) return
    pushUndo(true)
    setDirty(true)
    const base: Segment[] = rows.map(syncWords)
    const res = applyTextToSegments(base, importText)
    const fresh = toRows(res.segments)
    setRows(fresh)
    setSelKey(fresh[0]?.key ?? null)
    setSelWord(null)
    const parts: string[] = []
    if (res.matched > 0) parts.push(`совпало ${res.matched}`)
    if (res.inserted > 0) parts.push(`вставлено в паузы ${res.inserted}`)
    if (res.appended > 0) parts.push(`дописано ${res.appended}`)
    flash(
      parts.length > 0
        ? `Текст наложен: ${parts.join(', ')}`
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
  // слово для панели правки: есть только если индекс живой
  const selW = line && selWord !== null ? (line.words[selWord] ?? null) : null

  // Портал на body: fixed-оверлей обязан мериться от вьюпорта, а не от
  // framer-motion-предков (их transform/filter схлопывают inset-0 до пол-экрана)
  return createPortal(
    <div className="fixed inset-0 z-30 flex flex-col bg-black/70 backdrop-blur-sm">
      <div className="mx-auto flex min-h-0 w-full flex-1 flex-col p-2 sm:p-3">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl border border-border bg-surface">
          {/* звук создают элементы движка — в DOM их нет */}

          {/* шапка */}
          <div className="flex items-center gap-3 border-b border-border px-5 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-text">Редактор тайминга</div>
              <div className="truncate text-xs text-muted">
                {song.title} · оригинал
              </div>
            </div>
            {notice && (
              <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-xs text-primary sm:flex">
                <Check className="h-3.5 w-3.5" /> {notice}
              </span>
            )}
            <button onClick={closeMaybe} aria-label="Закрыть"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-hover text-text transition hover:bg-border">
              <X className="h-4 w-4" />
            </button>
          </div>

          {!hasOriginal && (
            <div className="border-b border-primary/20 bg-primary/8 px-5 py-2.5 text-[13px] text-primary/90">
              Нет звука или waveform для этой песни — запустите{' '}
              <code>python web/scripts/export_songs.py</code> заново. Правка текста работает и без него.
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {hasOriginal && song.waveform && (
              <div className="shrink-0 px-5 py-2">
                <p className="mb-2 rounded-xl bg-surface-hover px-3 py-2 text-[12.5px] leading-relaxed text-muted">
                  Не получается попадать в ритме? Жмите «По словам»: слушайте по одному слову,
                  подгоняйте края и подтверждайте пробелом. Магнит сам тянет границы к началам звуков.
                </p>
                {/* транспорт */}
                {!audioReady && (
                  <div className="mb-2.5 flex items-center gap-2.5 rounded-xl bg-surface-hover px-3 py-2.5">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${loadPct}%` }} />
                    </div>
                    <span className="shrink-0 text-xs text-muted tabular-nums">
                      {decoding ? `Точный звук (WAV)… ${loadPct}%` : `Звук в память… ${loadPct}%`}
                    </span>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => (playing ? pause() : play())} aria-label="Играть/пауза" disabled={!audioReady}
                    className="grid h-11 w-11 place-items-center rounded-full bg-primary text-white transition hover:bg-primary-hover disabled:opacity-40">
                    {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
                  </button>
                  <button onClick={() => line && playKey(line.key)} disabled={!audioReady}
                    className="rounded-full bg-surface-hover px-4 py-2.5 text-[13px] font-medium text-text transition hover:bg-border disabled:opacity-40">
                    Строку с начала
                  </button>
                  <button onClick={() => setLoopLine((v) => !v)} title="Зациклить текущую строку"
                    className={`grid h-10 w-10 place-items-center rounded-full transition ${loopLine ? 'bg-primary text-white' : 'bg-surface-hover text-muted hover:bg-border'}`}>
                    <Repeat className="h-4 w-4" />
                  </button>
                  <button onClick={() => setFollow((v) => !v)}
                    title={follow ? 'Следование включено: панель сама переходит к играющей строке. Нажмите, чтобы закрепить выбор.' : 'Выбор закреплён. Нажмите, чтобы панель снова следовала за звуком.'}
                    className={`grid h-10 w-10 place-items-center rounded-full transition ${follow ? 'bg-primary text-white' : 'bg-surface-hover text-muted hover:bg-border'}`}>
                    <LocateFixed className="h-4 w-4" />
                  </button>
                  <div className="flex overflow-hidden rounded-full bg-surface-hover">
                    {RATES.map((r) => (
                      <button key={r} onClick={() => setRate(r)}
                        className={`px-3 py-2 text-xs tabular-nums transition ${rate === r ? 'bg-primary font-semibold text-white' : 'text-muted hover:text-text'}`}>
                        {r}×
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Volume2 className="h-4 w-4 text-muted" />
                    <input type="range" min={0} max={1} step={0.01} value={volume}
                      onChange={(e) => setVolume(Number(e.target.value))}
                      className="w-20 accent-primary" aria-label="Громкость" />
                  </div>
                  <span className="ml-auto text-right text-[13px] text-muted tabular-nums">
                    {formatTimeMs(time)} / {formatTimeMs(song.waveform.duration)}
                  </span>
                </div>

                {/* обзор */}
                <div className="mt-2">
                  <Waveform
                    wave={song.waveform}
                    segments={rows}
                    activeSeg={lineIdx}
                    time={time}
                    disabled={!audioReady}
                    skips={skips}
                    selectMode={selectSkip}
                    onSelectRange={(s, e) => {
                      setSkips(validSkips([...skips, { s: Math.round(s * 1000) / 1000, e: Math.round(e * 1000) / 1000 }]))
                      setSelectSkip(false)
                      setDirty(true)
                      flash(`Пропуск ${formatTimeMs(s)}–${formatTimeMs(e)} — не забудьте сохранить`)
                    }}
                    onScrub={setScrubbing}
                    onTap={seekAndPlay}
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
                {/* пропуски «не поём»: выделяются прямо на волне; в плеере там слышно оригинал, очки не судятся */}
                <div className="mt-2 rounded-xl border border-border bg-surface-hover px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
                    <span className="font-medium text-text">Пропуски «не поём»</span>
                    <button
                      onClick={() => setSelectSkip((v) => !v)}
                      className={`rounded px-2 py-0.5 font-medium transition ${selectSkip ? 'bg-primary font-semibold text-white' : 'bg-surface-hover text-text hover:bg-border'}`}
                      title="Тащите по дорожке, чтобы выделить кусок"
                    >
                      {selectSkip ? '▪ рисуйте по дорожке…' : '▦ выделить на дорожке'}
                    </button>
                    {!song.original && (
                      <span className="text-[11px] text-muted/70">нет original.mp3 — вокал оставить не выйдет, только пропуск очков</span>
                    )}
                  </div>
                  {skips.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {skips.map((r, i) => (
                        <span
                          key={i}
                          className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-2 py-0.5 text-[11px] tabular-nums text-primary"
                        >
                          {formatTimeMs(r.s)}–{formatTimeMs(r.e)}
                          <button
                            onClick={() => {
                              setSkips(skips.filter((_, k) => k !== i))
                              setDirty(true)
                            }}
                            className="text-primary/60 transition hover:text-primary-hover"
                            aria-label={`Удалить пропуск ${formatTimeMs(r.s)}–${formatTimeMs(r.e)}`}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            {/* редактор слов — секция как импорт: border-t во всю ширину, без карточки */}
            {line && hasOriginal && song.waveform && (
              <div className="flex min-h-0 flex-1 flex-col border-t border-border px-5 py-2">
                {renderLineHead()}
                <div className="mt-1.5 shrink-0">
                  <WordTimeline
                        wave={song.waveform}
                        blocks={tlBlocks}
                        time={time}
                        selected={line && selWord !== null ? { key: line.key, wi: selWord } : null}
                        tapPos={tap ? { key: tap.key, wi: tap.idx } : null}
                        pad={pad}
                        snapT={magnet ? (t) => snapToOnset(t, onsets) : null}
                        onSelectWord={manualSelect}
                        onChangeWords={changeWordsByKey}
                        onSeek={playAt}
                        onPreview={previewWord}
                        onScrub={setScrubbing}
                      />
                    </div>
                    <div className="mt-1 flex shrink-0 items-center gap-2 text-[11px] text-muted/70">
                      <span>клик — выбрать · Ctrl — несколько · тяните слово / края / пустое (строку) · клик ниже — играть · даблклик — целиком</span>
                      <span className="ml-auto flex items-center gap-1">
                        <button onClick={() => setMagnet((v) => !v)} title="Притягивать границы слов к началам звуков"
                          className={`mr-1 flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition ${magnet ? 'bg-primary/20 text-primary' : 'bg-surface-hover text-muted hover:text-text'}`}>
                          <Magnet className="h-3 w-3" /> Магнит
                        </button>
                        масштаб
                        <button onClick={() => setPad((p) => Math.min(6, p + 0.5))} className="rounded bg-surface-hover px-2 py-0.5 text-text">−</button>
                        <button onClick={() => setPad((p) => Math.max(0.6, p - 0.5))} className="rounded bg-surface-hover px-2 py-0.5 text-text">+</button>
                      </span>
                    </div>

                    {/* слова всех строк */}
                    <div className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-surface-hover p-2">
                      {rows.map((r, i) => (
                        <div
                          key={r.key}
                          ref={(el) => {
                            if (el) groupRefs.current.set(r.key, el)
                            else groupRefs.current.delete(r.key)
                          }}
                        >
                          <LineWords
                            r={r}
                            num={i + 1}
                            selected={r.key === line?.key}
                            selWordIdx={r.key === line?.key ? selWord : null}
                            tapIdx={tap && tap.key === r.key ? tap.idx : null}
                            onGoto={gotoWord}
                            onDelete={deleteWordIn}
                            onPreview={previewWord}
                          />
                        </div>
                      ))}
                    </div>
                    {/* правка выбранного слова: текст и границы явно */}
                    {selW && line && selWord !== null && (
                      <div className="mt-2 rounded-xl border border-primary/25 bg-primary/[0.06] p-2.5">
                        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary/80">
                          Слово {selWord + 1} из {line.words.length} · длит. {Math.max(0, selW.e - selW.s).toFixed(3)}с
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <input value={selW.w} onChange={(e) => editWordText(e.target.value)} title="Текст слова"
                            placeholder="Слово"
                            className="min-w-0 flex-1 rounded-lg border border-border bg-surface-hover px-2 py-1.5 text-[13px] text-text outline-none focus:border-primary/50" />
                          <input type="number" step={0.001} min={0} value={selW.s} title="Начало слова, сек"
                            onChange={(e) => setWordTime('s', Number(e.target.value))}
                            className="w-[76px] shrink-0 rounded-lg border border-border bg-surface-hover px-1 py-1.5 text-center text-xs text-text tabular-nums outline-none focus:border-primary/50" />
                          <input type="number" step={0.001} min={0} value={selW.e} title="Конец слова, сек"
                            onChange={(e) => setWordTime('e', Number(e.target.value))}
                            className="w-[76px] shrink-0 rounded-lg border border-border bg-surface-hover px-1 py-1.5 text-center text-xs text-text tabular-nums outline-none focus:border-primary/50" />
                          <button onClick={() => previewWord(line.key, selWord)} title="Прослушать слово"
                            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-hover text-text transition hover:bg-border">
                            <Play className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => deleteWordIn(line.key, selWord)} title="Удалить слово"
                            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-danger/15 hover:text-danger">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="mt-1.5 flex shrink-0 flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-muted/70">Выбранное слово:</span>
                      <button onClick={addWord} title="Добавить слово после выбранного (или в конец выбранной строки)"
                        className="rounded-lg border border-dashed border-border px-2 py-1 text-xs text-muted transition hover:border-primary/60 hover:text-primary">
                        + слово
                      </button>
                      <button onClick={mergeWord} disabled={!line || selWord === null || selWord >= line.words.length - 1}
                        title="Склеить выбранное слово со следующим"
                        className="rounded-lg px-2 py-1 text-xs text-muted transition hover:bg-surface-hover hover:text-text disabled:opacity-30">
                        Объединить
                      </button>
                      <button onClick={splitWord} disabled={selWord === null}
                        title="Разрезать выбранное слово в позиции курсора (или посередине)"
                        className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted transition hover:bg-surface-hover hover:text-text disabled:opacity-30">
                        <Scissors className="h-3 w-3" /> Разрезать
                      </button>
                    </div>

                    {/* пошаговая панель */}
                    {step !== null && line && line.key === step.key && line.words[step.idx] && (
                      <div className="mt-2.5 rounded-xl bg-primary/8 p-3">
                        <div className="flex items-center gap-3">
                          <span className="min-w-0 flex-1 truncate text-2xl font-bold text-primary">
                            {line.words[step.idx].w}
                          </span>
                          <span className="shrink-0 text-xs text-muted tabular-nums">
                            слово {step.idx + 1} из {line.words.length}
                          </span>
                          <div className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-border">
                            <div className="h-full rounded-full bg-primary transition-[width]"
                              style={{ width: `${((step.idx + 1) / line.words.length) * 100}%` }} />
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <button onClick={() => playStepWord(step.key, step.idx)}
                            className="rounded-xl bg-surface-hover px-4 py-2 text-[13px] font-medium text-text transition hover:bg-border">
                            Слушать ещё раз
                          </button>
                          <button onClick={confirmStep}
                            className="rounded-xl bg-primary px-5 py-2 text-[13px] font-bold text-white transition hover:bg-primary-hover">
                            {step.idx >= line.words.length - 1 ? 'Готово ✓' : 'Дальше ✓ · пробел'}
                          </button>
                          <button onClick={cancelStep}
                            className="rounded-xl px-3 py-2 text-[13px] text-muted transition hover:text-text">
                            Выйти
                          </button>
                        </div>
                      </div>
                    )}

                    {/* точная подгонка + режимы */}
                    <div className="mt-2 flex shrink-0 flex-wrap items-center gap-2">
                      <div className="flex items-center gap-1 rounded-xl bg-surface-hover px-2 py-1.5">
                        <span className="px-1 text-[11px] text-muted">начало</span>
                        <button onClick={() => nudge('s', -0.01)} className="rounded-md bg-surface-hover px-2 py-1 text-xs text-text hover:bg-border">−10</button>
                        <button onClick={() => nudge('s', -0.001)} className="rounded-md bg-surface-hover px-2 py-1 text-xs text-text hover:bg-border">−1</button>
                        <button onClick={() => nudge('s', 0.001)} className="rounded-md bg-surface-hover px-2 py-1 text-xs text-text hover:bg-border">+1</button>
                        <button onClick={() => nudge('s', 0.01)} className="rounded-md bg-surface-hover px-2 py-1 text-xs text-text hover:bg-border">+10</button>
                      </div>
                      <div className="flex items-center gap-1 rounded-xl bg-surface-hover px-2 py-1.5">
                        <span className="px-1 text-[11px] text-muted">конец</span>
                        <button onClick={() => nudge('e', -0.01)} className="rounded-md bg-surface-hover px-2 py-1 text-xs text-text hover:bg-border">−10</button>
                        <button onClick={() => nudge('e', -0.001)} className="rounded-md bg-surface-hover px-2 py-1 text-xs text-text hover:bg-border">−1</button>
                        <button onClick={() => nudge('e', 0.001)} className="rounded-md bg-surface-hover px-2 py-1 text-xs text-text hover:bg-border">+1</button>
                        <button onClick={() => nudge('e', 0.01)} className="rounded-md bg-surface-hover px-2 py-1 text-xs text-text hover:bg-border">+10</button>
                      </div>
                      <span className="hidden text-[11px] text-muted/70 xl:block">←/→ край · Shift ×4 · Alt — конец</span>
                      <div className="ml-auto flex items-center gap-2">
                        {step === null && tap === null && (
                          <>
                            <button onClick={startStep} title="Слушать по одному слову и подтверждать пробелом" disabled={!audioReady}
                              className="flex items-center gap-1.5 rounded-xl bg-surface-hover px-4 py-2 text-[13px] font-medium text-text transition hover:bg-border disabled:opacity-40">
                              <SkipForward className="h-4 w-4" /> По словам
                            </button>
                            <button onClick={startTap} disabled={!audioReady}
                              className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-primary-hover disabled:opacity-40">
                              <MousePointerClick className="h-4 w-4" /> Таппинг
                            </button>
                          </>
                        )}
                        {tap !== null && tapRow && (
                          <>
                            <span className="text-xs text-muted tabular-nums">
                              {Math.min(tap.idx + 1, tapRow.words.length + 1)}/{tapRow.words.length + 1}
                            </span>
                            <button onClick={doTap}
                              className="animate-pulse rounded-xl bg-primary px-6 py-2 text-[13px] font-bold text-white transition hover:bg-primary-hover">
                              ТАП{tap.idx >= tapRow.words.length ? ' (конец)' : `: ${tapRow.words[Math.min(tap.idx, tapRow.words.length - 1)]?.w}`}
                            </button>
                            <button onClick={cancelTap} className="rounded-xl bg-surface-hover px-3 py-2 text-[13px] text-text hover:bg-border">
                              Отмена
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}

            {/* без звука: только шапка строки (текст/тайминги/раздел) */}
            {!hasOriginal && line && (
              <div className="border-b border-border px-4 py-3 sm:px-5">
                {renderLineHead()}
              </div>
            )}

            {/* импорт */}
            <div className="shrink-0 border-t border-border px-5 py-2">
              <button onClick={() => setShowImport((v) => !v)}
                className="flex items-center gap-2 text-[13px] font-medium text-primary/90 hover:text-primary">
                <Link2 className="h-3.5 w-3.5" />
                {showImport ? 'Скрыть импорт' : 'Вставить текст / загрузить с Genius'}
              </button>
              {showImport && (
                <div className="mt-3">
                  <div className="flex gap-2">
                    <input value={importUrl} onChange={(e) => setImportUrl(e.target.value)}
                      placeholder="https://genius.com/…-lyrics"
                      className="min-w-0 flex-1 rounded-xl border border-border bg-surface-hover px-3 py-2 text-[13px] text-text placeholder:text-muted/70 outline-none focus:border-primary" />
                    <button onClick={() => void loadFromUrl()} disabled={urlBusy || !importUrl.trim()}
                      className="flex shrink-0 items-center gap-1.5 rounded-xl bg-surface-hover px-3.5 py-2 text-[13px] font-medium text-text transition hover:bg-border disabled:opacity-40">
                      {urlBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Загрузить'}
                    </button>
                  </div>
                  <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={5}
                    placeholder="…или вставьте текст песни построчно (строки в [скобках] пропускаются)"
                    className="mt-2 w-full resize-y rounded-xl border border-border bg-surface-hover px-3 py-2 text-[13px] leading-relaxed text-text placeholder:text-muted/70 outline-none focus:border-primary" />
                  <button onClick={applyImport} disabled={!importText.trim()}
                    className="mt-2 rounded-xl bg-primary px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-primary-hover disabled:opacity-40">
                    Наложить на текущие тайминги
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* подвал */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-5 py-2.5">
            <button onClick={undo} title="Отменить (Ctrl+Z)" aria-label="Отменить"
              className="grid h-9 w-9 place-items-center rounded-full text-muted transition hover:bg-surface-hover hover:text-text">
              <Undo2 className="h-4 w-4" />
            </button>
            <button onClick={redo} title="Вернуть (Ctrl+Shift+Z)" aria-label="Вернуть"
              className="grid h-9 w-9 place-items-center rounded-full text-muted transition hover:bg-surface-hover hover:text-text">
              <Redo2 className="h-4 w-4" />
            </button>
            <button onClick={save} title={dirty ? 'Есть несохранённые правки' : 'Всё сохранено'}
              className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-hover">
              Сохранить{dirty ? ' •' : ''}
            </button>
            <button onClick={() => downloadLyrics(song.id, song.language, collect().segs)}
              title="Скачать lyrics.json — положите его в web/public/songs/<id>/ и в output/... чтобы сохранить навсегда"
              className="flex items-center gap-1.5 rounded-xl bg-surface-hover px-4 py-2.5 text-sm font-medium text-text transition hover:bg-border">
              <Download className="h-4 w-4" /> Скачать .json
            </button>
            <button onClick={() => { if (!dirty || window.confirm('Есть несохранённые правки — сбросить к версии из каталога?')) onReset() }}
              className="flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-sm text-muted transition hover:text-text">
              <RotateCcw className="h-3.5 w-3.5" /> Сбросить
            </button>
            <span className="ml-auto hidden text-xs text-muted/70 lg:block">
              пробел — играть/тап/дальше · клик по волне — перемотка · Ctrl+Z — отмена
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
