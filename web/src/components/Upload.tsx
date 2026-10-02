import { CheckCircle2, CloudUpload, FileMusic, FileVideo, Link2, Loader2, X, XCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchGeniusLines, getJob, uploadSong, type JobStatus } from '../lib/api'

interface Props {
  onClose: () => void
  onDone: (songId: string | null) => void
}

type Phase = 'pick' | 'working' | 'done' | 'error'
/** почему мы в error-фазе: от этого зависит заголовок и что делает «повторить» */
type ErrorKind = 'upload' | 'job' | 'net' | 'gone'

const ERROR_TITLES: Record<ErrorKind, string> = {
  upload: 'Не удалось загрузить файл',
  job: 'Песня не обработалась',
  net: 'Что-то пошло не так',
  gone: 'Задача не найдена',
}

const ACCEPT = '.mp3,.wav,.flac,.m4a,.ogg,.mp4,.mov,.mkv,.webm,audio/*,video/*'
const ACCEPT_EXT = ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.mp4', '.mov', '.mkv', '.webm']
const POLL_MS = 1200
/** сколько сетевых сбоев подряд терпим, пока job жив */
const POLL_RETRIES = 5
const RESUME_KEY = 'karaoke:uploadJob'

export default function Upload({ onClose, onDone }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [drag, setDrag] = useState(false)
  const [lang, setLang] = useState('ru')
  const [phase, setPhase] = useState<Phase>('pick')
  const [job, setJob] = useState<JobStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorKind, setErrorKind] = useState<ErrorKind>('upload')
  const [showLyrics, setShowLyrics] = useState(false)
  const [lyricsText, setLyricsText] = useState('')
  const [lyricsUrl, setLyricsUrl] = useState('')
  const [lyricsBusy, setLyricsBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const timerRef = useRef(0)
  /** поколение опроса: отставшие ответы игнорируются, дабл-старт невозможен */
  const pollSeq = useRef(0)

  const stopPoll = useCallback(() => {
    pollSeq.current++
    window.clearInterval(timerRef.current)
    timerRef.current = 0
  }, [])

  /** задача завершилась (ошибка/успех/потеряна) — подвешивать ключ уже нельзя */
  const clearResume = useCallback(() => {
    try {
      sessionStorage.removeItem(RESUME_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => stopPoll, [stopPoll])

  /** продолжить висящую задачу (например, после закрытия окна) */
  const resume = useCallback((jobId: string) => {
    stopPoll()
    const seq = ++pollSeq.current
    let fails = 0
    setPhase('working')
    setError(null)
    const tick = () => {
      void (async () => {
        if (seq !== pollSeq.current) return
        let st: JobStatus | null
        try {
          st = await getJob(jobId)
        } catch (e) {
          // транзиентный сбой сети — терпим несколько раз подряд
          fails++
          if (fails >= POLL_RETRIES && seq === pollSeq.current) {
            stopPoll()
            setErrorKind('net')
            setPhase('error')
            setError(e instanceof Error ? e.message : 'Потеряна связь с сервером')
          }
          return
        }
        if (seq !== pollSeq.current) return
        fails = 0
        if (st === null) {
          // бэкенд перезапустили — задачи больше нет (404, не сетевой сбой)
          stopPoll()
          clearResume()
          setErrorKind('gone')
          setPhase('error')
          setError('Задача не найдена на сервере — загрузите файл заново')
          return
        }
        setJob(st)
        if (st.state === 'done') {
          stopPoll()
          clearResume()
          setPhase('done')
        } else if (st.state === 'error') {
          stopPoll()
          clearResume()
          setErrorKind('job')
          setPhase('error')
          setError(st.error ?? 'Неизвестная ошибка')
        }
      })()
    }
    tick()
    timerRef.current = window.setInterval(tick, POLL_MS)
  }, [stopPoll, clearResume])

  // при открытии подхватываем недожатую задачу
  useEffect(() => {
    try {
      const pending = sessionStorage.getItem(RESUME_KEY)
      if (pending) resume(pending)
    } catch {
      /* ignore */
    }
  }, [resume])

  const pick = useCallback((f: File | undefined) => {
    if (!f) return
    const ext = f.name.includes('.') ? f.name.slice(f.name.lastIndexOf('.')).toLowerCase() : ''
    if (ext && !ACCEPT_EXT.includes(ext) && !f.type.startsWith('audio') && !f.type.startsWith('video')) {
      setErrorKind('upload')
      setError(`Не похоже на аудио/видео: ${ext || 'без расширения'}`)
      return
    }
    setFile(f)
    setError(null)
    // иначе повторный выбор того же файла не триггерит onChange
    if (inputRef.current) inputRef.current.value = ''
  }, [])

  const start = async () => {
    if (!file) return
    setPhase('working')
    setError(null)
    setErrorKind('upload')
    try {
      const jobId = await uploadSong(file, { lang }, { lyricsText, lyricsUrl })
      try {
        sessionStorage.setItem(RESUME_KEY, jobId)
      } catch {
        /* ignore */
      }
      resume(jobId)
    } catch (e) {
      setPhase('error')
      setErrorKind('upload')
      setError(e instanceof Error ? e.message : 'Не удалось загрузить файл')
    }
  }

  const lyricsSeq = useRef(0)
  const loadLyricsUrl = async () => {
    const url = lyricsUrl.trim()
    if (!url) return
    const seq = ++lyricsSeq.current
    setLyricsBusy(true)
    try {
      const lines = await fetchGeniusLines(url)
      if (seq !== lyricsSeq.current) return // устаревший ответ
      setLyricsText(lines.join('\n'))
      setError(null)
    } catch (e) {
      if (seq !== lyricsSeq.current) return
      setError(e instanceof Error ? e.message : 'Не удалось загрузить текст')
    } finally {
      if (seq === lyricsSeq.current) setLyricsBusy(false)
    }
  }

  const mb = file ? (file.size / 1048576).toFixed(1) : '0'
  const isVideo = file && (file.type.startsWith('video') || /\.(mp4|mov|mkv|webm)$/i.test(file.name))

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-3xl border border-border bg-surface p-6">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary">
            <CloudUpload className="h-4.5 w-4.5 text-white" />
          </div>
          <div className="flex-1 text-[16px] font-semibold text-text">Новая песня</div>
          <button onClick={onClose} aria-label="Закрыть"
            className="grid h-9 w-9 place-items-center rounded-full bg-surface-hover text-text transition hover:bg-border">
            <X className="h-4 w-4" />
          </button>
        </div>

        {phase === 'pick' && (
          <>
            <button
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]) }}
              className={`mt-4 flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition ${drag ? 'border-primary/70 bg-primary/5' : 'border-border hover:border-muted/60 hover:bg-border'}`}
            >
              <input ref={inputRef} type="file" accept={ACCEPT} className="hidden"
                onChange={(e) => pick(e.target.files?.[0])} />
              {file ? (
                <>
                  {isVideo ? <FileVideo className="h-8 w-8 text-primary" /> : <FileMusic className="h-8 w-8 text-primary" />}
                  <div className="max-w-full truncate text-sm font-medium text-text">{file.name}</div>
                  <div className="text-xs text-muted">
                    {mb} МБ{isVideo ? ' · клип: возьму аудиодорожку' : ''} · нажмите, чтобы выбрать другой
                  </div>
                </>
              ) : (
                <>
                  <CloudUpload className="h-8 w-8 text-muted" />
                  <div className="text-sm text-text">Перетащите аудио или клип сюда или нажмите</div>
                  <div className="text-xs text-muted/70">mp3 · wav · flac · m4a · ogg · mp4 · mov · mkv · webm</div>
                </>
              )}
            </button>

            <label className="mt-4 block">
              <span className="mb-1 block text-xs text-muted">Язык песни</span>
              <select value={lang} onChange={(e) => setLang(e.target.value)}
                className="w-full rounded-xl border border-border bg-surface-hover px-2.5 py-2 text-[13px] text-text outline-none">
                <option value="ru">Русский</option>
                <option value="en">Английский</option>
                <option value="">Авто</option>
              </select>
            </label>

            <button onClick={() => setShowLyrics((v) => !v)}
              className="mt-3 flex items-center gap-2 text-[13px] font-medium text-primary/90 hover:text-primary">
              <Link2 className="h-3.5 w-3.5" />
              {showLyrics ? 'Скрыть текст песни' : 'Приложить текст песни (необязательно)'}
            </button>
            {showLyrics && (
              <div className="mt-2">
                <div className="flex gap-2">
                  <input value={lyricsUrl} onChange={(e) => setLyricsUrl(e.target.value)}
                    placeholder="https://genius.com/…-lyrics"
                    className="min-w-0 flex-1 rounded-xl border border-border bg-surface-hover px-3 py-2 text-[13px] text-text placeholder:text-muted/70 outline-none focus:border-primary" />
                  <button onClick={() => void loadLyricsUrl()} disabled={lyricsBusy || !lyricsUrl.trim()}
                    className="flex shrink-0 items-center gap-1.5 rounded-xl bg-surface-hover px-3.5 py-2 text-[13px] font-medium text-text transition hover:bg-border disabled:opacity-40">
                    {lyricsBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Загрузить'}
                  </button>
                </div>
                <textarea value={lyricsText} onChange={(e) => setLyricsText(e.target.value)} rows={5}
                  placeholder="…или вставьте правильный текст построчно — наложу его на тайминги вместо распознанного"
                  className="mt-2 w-full resize-y rounded-xl border border-border bg-surface-hover px-3 py-2 text-[13px] leading-relaxed text-text placeholder:text-muted/70 outline-none focus:border-primary" />
              </div>
            )}

            {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
            <button onClick={() => void start()} disabled={!file}
              className="mt-4 w-full rounded-2xl bg-primary py-3.5 text-[15px] font-semibold text-white transition hover:bg-primary-hover disabled:opacity-40">
              Сделать караоке
            </button>
            <p className="mt-2.5 text-center text-xs leading-relaxed text-muted/70">
              Вокал отделится на видеокарте, текст распознается автоматически
            </p>
          </>
        )}

        {phase === 'working' && (
          <div className="mt-5">
            <div className="flex items-center gap-2 text-sm text-text">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              {job?.stageLabel ?? 'Загрузка…'}
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-hover">
              <div className="h-full rounded-full bg-primary transition-[width] duration-700"
                style={{ width: `${job?.progress ?? 1}%` }} />
            </div>
            <div className="mt-2 flex justify-between text-xs text-muted">
              <span className="truncate">{job?.title ?? file?.name}</span>
              <span className="tabular-nums">{Math.round(job?.progress ?? 0)}%</span>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted/70">
              Обработка идёт на GPU и занимает 1–3 минуты. Окно можно не закрывать — песня появится в каталоге.
            </p>
          </div>
        )}

        {phase === 'done' && (
          <div className="mt-5 flex flex-col items-center text-center">
            <CheckCircle2 className="h-12 w-12 text-primary" />
            <div className="mt-3 font-medium text-text">Готово — можно петь!</div>
            <div className="mt-1 max-w-full truncate text-sm text-muted">{job?.title}</div>
            <button onClick={() => onDone(job?.songId ?? null)}
              className="mt-4 w-full rounded-2xl bg-primary py-3 text-[15px] font-semibold text-white transition hover:bg-primary-hover">
              Открыть песню
            </button>
          </div>
        )}

        {phase === 'error' && (
          <div className="mt-5 flex flex-col items-center text-center">
            <XCircle className="h-12 w-12 text-danger" />
            <div className="mt-3 font-medium text-text">{ERROR_TITLES[errorKind]}</div>
            <div className="mt-1 text-sm text-muted">{error ?? 'Неизвестная ошибка'}</div>
            <button
              onClick={() => {
                if (file) void start()
                else {
                  setPhase('pick')
                  setError(null)
                }
              }}
              className="mt-4 w-full rounded-2xl bg-primary py-3 text-[15px] font-semibold text-white transition hover:bg-primary-hover">
              Повторить загрузку
            </button>
            <button
              onClick={() => {
                setPhase('pick')
                setError(null)
              }}
              className="mt-2 w-full rounded-2xl bg-surface-hover py-3 text-[15px] font-medium text-text transition hover:bg-border">
              Выбрать другой файл
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
