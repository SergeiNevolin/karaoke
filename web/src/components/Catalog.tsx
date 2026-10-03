import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Clock, Disc3, Heart, LayoutGrid, ListMusic, MicVocal, Plus, Search, Loader2, Sparkles, X } from 'lucide-react'
import { apiAvailable, hasAuthToken } from '../lib/api'
import { loadSong } from '../lib/songs'
import { formatTime } from '../lib/songs'
import { hasLocalLyrics, loadManifest } from '../lib/songs'
import { useKaraoke } from '../store'
import type { SongMeta } from '../lib/types'
import Upload from './Upload'

type Tab = 'all' | 'fav' | 'recent'

const HINT_KEY = 'karaoke:hintSeen'

function hueOf(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

function SongCard({ song, index }: { song: SongMeta; index: number }) {
  const openSong = useKaraoke((s) => s.openSong)
  const setLoadingSong = useKaraoke((s) => s.setLoadingSong)
  const loadingSong = useKaraoke((s) => s.loadingSong)
  const favorites = useKaraoke((s) => s.favorites)
  const toggleFavorite = useKaraoke((s) => s.toggleFavorite)
  const pushRecent = useKaraoke((s) => s.pushRecent)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const hue = hueOf(song.id)
  const fav = favorites.includes(song.id)
  const edited = hasLocalLyrics(song.id)

  const sing = async () => {
    if (busy || loadingSong) return
    setBusy(true)
    setLoadingSong(true)
    setLoadError(null)
    try {
      const data = await loadSong(song)
      pushRecent(song.id)
      openSong(data)
    } catch (e) {
      console.error(e)
      setLoadError('Не открылась — проверьте файлы песни')
    } finally {
      setBusy(false)
      setLoadingSong(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.05, 0.4), duration: 0.4 }}
      className="group flex items-center gap-4 rounded-2xl border border-border bg-surface p-4 transition hover:border-muted/60 hover:bg-surface-hover"
    >
      <button onClick={sing} aria-label={`Петь: ${song.title}`}
        className="grid h-14 w-14 shrink-0 place-items-center rounded-xl"
        style={{ background: `linear-gradient(135deg, hsl(${hue} 45% 32%), hsl(${(hue + 40) % 360} 50% 20%))` }}
      >
        {busy ? <Loader2 className="h-6 w-6 animate-spin text-muted" /> : <Disc3 className="h-6 w-6 text-muted" />}
      </button>
      <button onClick={sing} className="min-w-0 flex-1 text-left">
        <div className="truncate text-[15px] font-medium text-text">{song.title}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[13px] text-muted">
          <span>{song.lines} строк · {formatTime(song.duration)}</span>
          {song.language && <span>· {song.language.toUpperCase()}</span>}
          {edited && (
            <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary">
              свой текст
            </span>
          )}
        </div>
        {loadError && <span className="mt-0.5 block text-xs text-danger">{loadError}</span>}
      </button>
      <button onClick={() => toggleFavorite(song.id)} title={fav ? 'Убрать из избранного' : 'В избранное'}
        aria-label={fav ? 'Убрать из избранного' : 'В избранное'}
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-full transition ${fav ? 'text-danger' : 'text-muted/70 hover:bg-surface-hover hover:text-text'}`}>
        <Heart className={`h-4.5 w-4.5 ${fav ? 'fill-current' : ''}`} />
      </button>
      <button onClick={sing}
        className="flex shrink-0 items-center gap-1.5 rounded-full bg-surface-hover px-3.5 py-2.5 text-[13px] font-medium text-text transition group-hover:bg-primary group-hover:text-white">
        <MicVocal className="h-4 w-4" />
        Петь
      </button>
    </motion.div>
  )
}

const TABS: { id: Tab; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'all', label: 'Все песни', icon: LayoutGrid },
  { id: 'fav', label: 'Избранное', icon: Heart },
  { id: 'recent', label: 'Недавние', icon: Clock },
]

export default function Catalog() {
  const songs = useKaraoke((s) => s.songs)
  const setSongs = useKaraoke((s) => s.setSongs)
  const openSong = useKaraoke((s) => s.openSong)
  const favorites = useKaraoke((s) => s.favorites)
  const recent = useKaraoke((s) => s.recent)
  const pushRecent = useKaraoke((s) => s.pushRecent)
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<Tab>('all')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [apiUp, setApiUp] = useState(false)
  const [hintOpen, setHintOpen] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const setLoadingSong = useKaraoke((s) => s.setLoadingSong)

  // загрузка — только для вошедших: бэкенд жив + токен (или standalone без входа)
  const canUpload = apiUp && hasAuthToken()

  useEffect(() => {
    apiAvailable().then(setApiUp).catch(() => setApiUp(false))
    try {
      if (!localStorage.getItem(HINT_KEY)) setHintOpen(true)
    } catch {
      /* ignore */
    }
  }, [])

  const dismissHint = () => {
    setHintOpen(false)
    try {
      localStorage.setItem(HINT_KEY, '1')
    } catch {
      /* ignore */
    }
  }

  const byTab = useMemo(() => {
    if (tab === 'fav') {
      const favIds = new Set(favorites)
      return songs.filter((s) => favIds.has(s.id))
    }
    if (tab === 'recent') {
      const order = new Map(recent.map((id, i) => [id, i]))
      return songs
        .filter((s) => order.has(s.id))
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    }
    return songs
  }, [songs, tab, favorites, recent])

  const filtered = useMemo(
    () => byTab.filter((s) => s.title.toLowerCase().includes(q.trim().toLowerCase())),
    [byTab, q],
  )

  const refreshAndOpen = async (songId: string | null) => {
    setUploadOpen(false)
    setRefreshError(null)
    if (!songId) {
      setRefreshError('Сервер не вернул песню — выберите её в каталоге')
      return
    }
    setLoadingSong(true)
    try {
      const all = await loadManifest()
      setSongs(all)
      const meta = all.find((s) => s.id === songId)
      if (!meta) {
        setRefreshError('Песни нет в каталоге — обновите страницу')
        return
      }
      pushRecent(meta.id)
      openSong(await loadSong(meta))
    } catch (e) {
      console.error(e)
      setRefreshError('Не удалось открыть песню')
    } finally {
      setLoadingSong(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-16">
      {hintOpen && songs.length > 0 && (
        <div className="relative mt-2 rounded-2xl border border-primary/20 bg-primary/[0.06] p-4">
          <button onClick={dismissHint} aria-label="Закрыть подсказку"
            className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-full text-muted hover:bg-surface-hover hover:text-text">
            <X className="h-3.5 w-3.5" />
          </button>
          <div className="flex items-center gap-2 text-sm font-semibold text-primary">
            <Sparkles className="h-4 w-4" /> Как тут всё устроено
          </div>
          <ol className="mt-2 space-y-1 text-[13px] leading-relaxed text-text">
            <li><b className="text-text">1.</b> Выберите песню и нажмите «Петь» — будет обратный отсчёт и минус.</li>
            <li><b className="text-text">2.</b> Пойте в микрофон — в конце получите оценку попадания в ноты.</li>
            <li><b className="text-text">3.</b> Текст правится карандашом «Текст» в плеере, песни грузятся кнопкой «Загрузить».</li>
          </ol>
        </div>
      )}

      <div className="mt-2 flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted/70" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Найти песню…"
            aria-label="Найти песню"
            className="w-full rounded-2xl border border-border bg-surface py-3 pl-11 pr-4 text-[15px] text-text placeholder:text-muted/70 outline-none focus:border-primary"
          />
        </div>
        {canUpload && (
          <button onClick={() => setUploadOpen(true)} title="Загрузить свою песню (аудио или клип)"
            className="flex shrink-0 items-center gap-1.5 rounded-2xl bg-primary px-4 text-sm font-semibold text-white transition hover:bg-primary-hover">
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Загрузить</span>
          </button>
        )}
      </div>

      <div className="mt-3 flex gap-1.5" role="tablist" aria-label="Разделы каталога">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}            className={`flex items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium transition ${tab === t.id ? 'bg-primary text-white' : 'bg-surface-hover text-muted hover:bg-border hover:text-text'}`}>
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {refreshError && (
        <p className="mt-2 rounded-xl border border-danger/20 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          {refreshError}
        </p>
      )}

      {songs.length === 0 ? (
        <div className="mt-16 flex flex-col items-center text-center">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-surface-hover">
            <ListMusic className="h-7 w-7 text-muted" />
          </div>
          <h2 className="mt-5 text-lg font-medium text-text">Пока нет песен</h2>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">
            {canUpload
              ? 'Нажмите «Загрузить» и добавьте первую песню — вокал отделится сам.'
              : apiUp
                ? 'Загрузка песен — только для вошедших: войдите в bebradio, и кнопка появится.'
                : 'Запустите бэкенд и загрузите песню через интерфейс, либо соберите пайплайном:'}
          </p>
          {!apiUp && (
            <code className="mt-4 rounded-xl bg-surface-hover px-4 py-3 text-left text-[12.5px] leading-relaxed text-muted">
              python -m uvicorn karaoke_api.app:app --port 8000
              <br />
              # дальше — кнопка «Загрузить» в интерфейсе
            </code>
          )}
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-2.5">
          {filtered.map((s, i) => (
            <SongCard key={s.id} song={s} index={i} />
          ))}
          {filtered.length === 0 && (
            <p className="mt-10 text-center text-sm text-muted">
              {tab === 'fav' && !q ? 'Нажмите сердечко на песне — она появится здесь' : tab === 'recent' && !q ? 'Вы ещё ничего не пели' : 'Ничего не найдено'}
            </p>
          )}
        </div>
      )}
      {uploadOpen && (
        <Upload onClose={() => setUploadOpen(false)} onDone={(id) => void refreshAndOpen(id)} />
      )}
    </div>
  )
}
