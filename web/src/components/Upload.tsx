import { CheckCircle2, CloudUpload, FileMusic, FileVideo, Link2, Loader2, X, XCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchGeniusLines, getJob, uploadSong, type JobStatus, type UploadOptions } from '../lib/api'

interface Props {
  onClose: () => void
  onDone: (songId: string | null) => void
}

type Phase = 'pick' | 'working' | 'done' | 'error'

const ACCEPT = '.mp3,.wav,.flac,.m4a,.ogg,.mp4,.mov,.mkv,.webm,audio/*,video/*'

export default function Upload({ onClose, onDone }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [drag, setDrag] = useState(false)
  const [model, setModel] = useState<UploadOptions['model']>('htdemucs')
  const [whisper, setWhisper] = useState<UploadOptions['whisper']>('large-v3')
  const [lang, setLang] = useState('ru')
  const [phase, setPhase] = useState<Phase>('pick')
  const [job, setJob] = useState<JobStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showLyrics, setShowLyrics] = useState(false)
  const [lyricsText, setLyricsText] = useState('')
  const [lyricsUrl, setLyricsUrl] = useState('')
  const [lyricsBusy, setLyricsBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const timerRef = useRef(0)

  const stopPoll = () => window.clearInterval(timerRef.current)
  useEffect(() => stopPoll, [])

  const pick = useCallback((f: File | undefined) => {
    if (f) {
      setFile(f)
      setError(null)
    }
  }, [])

  const start = async () => {
    if (!file) return
    setPhase('working')
    setError(null)
    try {
      const jobId = await uploadSong(file, { model, whisper, lang }, { lyricsText, lyricsUrl })
      timerRef.current = window.setInterval(async () => {
        try {
          const st = await getJob(jobId)
          setJob(st)
          if (st.state === 'done') {
            stopPoll()
            setPhase('done')
          } else if (st.state === 'error') {
            stopPoll()
            setPhase('error')
            setError(st.error ?? 'Неизвестная ошибка')
          }
        } catch (e) {
          stopPoll()
          setPhase('error')
          setError(e instanceof Error ? e.message : 'Потеряна связь с сервером')
        }
      }, 1200)
    } catch (e) {
      setPhase('error')
      setError(e instanceof Error ? e.message : 'Не удалось загрузить файл')
    }
  }

  const loadLyricsUrl = async () => {
    const url = lyricsUrl.trim()
    if (!url) return
    setLyricsBusy(true)
    try {
      const lines = await fetchGeniusLines(url)
      setLyricsText(lines.join('\n'))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить текст')
    } finally {
      setLyricsBusy(false)
    }
  }

  const mb = file ? (file.size / 1048576).toFixed(1) : '0'
  const isVideo = file && (file.type.startsWith('video') || /\.(mp4|mov|mkv|webm)$/i.test(file.name))

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#141417] p-6">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-amber-300">
            <CloudUpload className="h-4.5 w-4.5 text-zinc-950" />
          </div>
          <div className="flex-1 text-[16px] font-semibold text-zinc-50">Новая песня</div>
          <button onClick={onClose} aria-label="Закрыть"
            className="grid h-9 w-9 place-items-center rounded-full bg-white/6 text-zinc-300 transition hover:bg-white/12">
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
              className={`mt-4 flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition ${drag ? 'border-amber-300/70 bg-amber-300/5' : 'border-white/12 hover:border-white/25 hover:bg-white/[0.03]'}`}
            >
              <input ref={inputRef} type="file" accept={ACCEPT} className="hidden"
                onChange={(e) => pick(e.target.files?.[0])} />
              {file ? (
                <>
                  {isVideo ? <FileVideo className="h-8 w-8 text-amber-300" /> : <FileMusic className="h-8 w-8 text-amber-300" />}
                  <div className="max-w-full truncate text-sm font-medium text-zinc-100">{file.name}</div>
                  <div className="text-xs text-zinc-500">
                    {mb} МБ{isVideo ? ' · клип: возьму аудиодорожку' : ''} · нажмите, чтобы выбрать другой
                  </div>
                </>
              ) : (
                <>
                  <CloudUpload className="h-8 w-8 text-zinc-500" />
                  <div className="text-sm text-zinc-300">Перетащите аудио или клип сюда или нажмите</div>
                  <div className="text-xs text-zinc-600">mp3 · wav · flac · m4a · mp4 · mov · mkv</div>
                </>
              )}
            </button>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-xs text-zinc-500">Разделение</span>
                <select value={model} onChange={(e) => setModel(e.target.value as UploadOptions['model'])}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-[13px] text-zinc-100 outline-none">
                  <option value="htdemucs">Быстрое</option>
                  <option value="htdemucs_ft">Качественное</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-zinc-500">Текст</span>
                <select value={whisper} onChange={(e) => setWhisper(e.target.value as UploadOptions['whisper'])}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-[13px] text-zinc-100 outline-none">
                  <option value="large-v3">Точный (large)</option>
                  <option value="medium">Средний</option>
                  <option value="small">Быстрый (small)</option>
                </select>
              </label>
            </div>
            <label className="mt-2 block">
              <span className="mb-1 block text-xs text-zinc-500">Язык песни</span>
              <select value={lang} onChange={(e) => setLang(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-[13px] text-zinc-100 outline-none">
                <option value="ru">Русский</option>
                <option value="en">Английский</option>
                <option value="">Авто</option>
              </select>
            </label>

            <button onClick={() => setShowLyrics((v) => !v)}
              className="mt-3 flex items-center gap-2 text-[13px] font-medium text-amber-200/90 hover:text-amber-200">
              <Link2 className="h-3.5 w-3.5" />
              {showLyrics ? 'Скрыть текст песни' : 'Приложить текст песни (необязательно)'}
            </button>
            {showLyrics && (
              <div className="mt-2">
                <div className="flex gap-2">
                  <input value={lyricsUrl} onChange={(e) => setLyricsUrl(e.target.value)}
                    placeholder="https://genius.com/…-lyrics"
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-white/25" />
                  <button onClick={() => void loadLyricsUrl()} disabled={lyricsBusy || !lyricsUrl.trim()}
                    className="flex shrink-0 items-center gap-1.5 rounded-xl bg-white/8 px-3.5 py-2 text-[13px] font-medium text-zinc-100 transition hover:bg-white/14 disabled:opacity-40">
                    {lyricsBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Загрузить'}
                  </button>
                </div>
                <textarea value={lyricsText} onChange={(e) => setLyricsText(e.target.value)} rows={5}
                  placeholder="…или вставьте правильный текст построчно — наложу его на тайминги вместо распознанного"
                  className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[13px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-white/25" />
              </div>
            )}

            {error && <p className="mt-3 text-[13px] text-rose-300">{error}</p>}
            <button onClick={() => void start()} disabled={!file}
              className="mt-4 w-full rounded-2xl bg-amber-300 py-3.5 text-[15px] font-semibold text-zinc-950 transition hover:bg-amber-200 disabled:opacity-40">
              Сделать караоке
            </button>
            <p className="mt-2.5 text-center text-xs leading-relaxed text-zinc-600">
              Вокал отделится на видеокарте, текст распознается автоматически
            </p>
          </>
        )}

        {phase === 'working' && (
          <div className="mt-5">
            <div className="flex items-center gap-2 text-sm text-zinc-200">
              <Loader2 className="h-4 w-4 animate-spin text-amber-300" />
              {job?.stageLabel ?? 'Загрузка…'}
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8">
              <div className="h-full rounded-full bg-amber-300 transition-[width] duration-700"
                style={{ width: `${job?.progress ?? 1}%` }} />
            </div>
            <div className="mt-2 flex justify-between text-xs text-zinc-500">
              <span className="truncate">{job?.title ?? file?.name}</span>
              <span className="tabular-nums">{Math.round(job?.progress ?? 0)}%</span>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-zinc-600">
              Обработка идёт на GPU и занимает 1–3 минуты. Окно можно не закрывать — песня появится в каталоге.
            </p>
          </div>
        )}

        {phase === 'done' && (
          <div className="mt-5 flex flex-col items-center text-center">
            <CheckCircle2 className="h-12 w-12 text-emerald-300" />
            <div className="mt-3 font-medium text-zinc-100">Готово — можно петь!</div>
            <div className="mt-1 max-w-full truncate text-sm text-zinc-500">{job?.title}</div>
            <button onClick={() => onDone(job?.songId ?? null)}
              className="mt-4 w-full rounded-2xl bg-amber-300 py-3 text-[15px] font-semibold text-zinc-950 transition hover:bg-amber-200">
              Открыть песню
            </button>
          </div>
        )}

        {phase === 'error' && (
          <div className="mt-5 flex flex-col items-center text-center">
            <XCircle className="h-12 w-12 text-rose-300" />
            <div className="mt-3 font-medium text-zinc-100">Что-то пошло не так</div>
            <div className="mt-1 text-sm text-zinc-500">{error ?? 'Неизвестная ошибка'}</div>
            <button onClick={() => { setPhase('pick'); setError(null) }}
              className="mt-4 w-full rounded-2xl bg-white/8 py-3 text-[15px] font-medium text-zinc-100 transition hover:bg-white/14">
              Попробовать ещё раз
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
