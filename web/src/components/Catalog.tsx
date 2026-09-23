import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Clock, Disc3, Heart, LayoutGrid, ListMusic, MicVocal, Plus, Search, Loader2, Sparkles, X } from 'lucide-react'
import { apiAvailable } from '../lib/api'
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
  const hue = hueOf(song.id)
  const fav = favorites.includes(song.id)
  const edited = hasLocalLyrics(song.id)

  const sing = async () => {
    if (busy || loadingSong) return
    setBusy(true)
    setLoadingSong(true)
    try {
      pushRecent(song.id)
      openSong(await loadSong(song))
    } catch (e) {
      console.error(e)
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
      className="group flex items-center gap-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4 transition hover:border-white/20 hover:bg-white/[0.06]"
    >
      <button onClick={sing} aria-label={`Петь: ${song.title}`}
        className="grid h-14 w-14 shrink-0 place-items-center rounded-xl"
        style={{ background: `linear-gradient(135deg, hsl(${hue} 45% 32%), hsl(${(hue + 40) % 360} 50% 20%))` }}
      >
        {busy ? <Loader2 className="h-6 w-6 animate-spin text-white/80" /> : <Disc3 className="h-6 w-6 text-white/80" />}
      </button>
      <button onClick={sing} className="min-w-0 flex-1 text-left">
        <div className="truncate text-[15px] font-medium text-zinc-100">{song.title}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[13px] text-zinc-500">
          <span>{song.lines} строк · {formatTime(song.duration)}</span>
          {song.language && <span>· {song.language.toUpperCase()}</span>}
          {edited && (
            <span className="rounded-full bg-amber-300/12 px-2 py-0.5 text-[11px] font-medium text-amber-200">
              свой текст
            </span>
          )}
        </div>
      </button>
      <button onClick={() => toggleFavorite(song.id)} title={fav ? 'Убрать из избранного' : 'В избранное'}
        aria-label={fav ? 'Убрать из избранного' : 'В избранное'}
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-full transition ${fav ? 'text-rose-300' : 'text-zinc-600 hover:bg-white/8 hover:text-zinc-300'}`}>
        <Heart className={`h-4.5 w-4.5 ${fav ? 'fill-current' : ''}`} />
      </button>
      <button onClick={sing}
        className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/8 px-3.5 py-2.5 text-[13px] font-medium text-zinc-200 transition group-hover:bg-amber-300 group-hover:text-zinc-950">
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
  const [canUpload, setCanUpload] = useState(false)
  const [hintOpen, setHintOpen] = useState(false)

  useEffect(() => {
    apiAvailable().then(setCanUpload).catch(() => setCanUpload(false))
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
    if (tab === 'fav') return songs.filter((s) => favorites.includes(s.id))
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
    try {
      const all = await loadManifest()
      setSongs(all)
      const meta = all.find((s) => s.id === songId) ?? all[all.length - 1]
      if (meta) {
        pushRecent(meta.id)
        openSong(await loadSong(meta))
      }
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-16">
      {hintOpen && songs.length > 0 && (
        <div className="relative mt-2 rounded-2xl border border-amber-300/20 bg-amber-300/[0.06] p-4">
          <button onClick={dismissHint} aria-label="Закрыть подсказку"
            className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-full text-zinc-500 hover:bg-white/8 hover:text-zinc-200">
            <X className="h-3.5 w-3.5" />
          </button>
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-200">
            <Sparkles className="h-4 w-4" /> Как тут всё устроено
          </div>
          <ol className="mt-2 space-y-1 text-[13px] leading-relaxed text-zinc-300">
            <li><b className="text-zinc-100">1.</b> Выберите песню и нажмите «Петь» — будет обратный отсчёт и минус.</li>
            <li><b className="text-zinc-100">2.</b> Пойте в микрофон — в конце получите оценку попадания в ноты.</li>
            <li><b className="text-zinc-100">3.</b> Текст правится карандашом «Текст» в плеере, песни грузятся кнопкой «Загрузить».</li>
          </ol>
        </div>
      )}

      <div className="mt-2 flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Найти песню…"
            aria-label="Найти песню"
            className="w-full rounded-2xl border border-white/8 bg-white/[0.03] py-3 pl-11 pr-4 text-[15px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-white/25"
          />
        </div>
        {canUpload && (
          <button onClick={() => setUploadOpen(true)} title="Загрузить свою песню (аудио или клип)"
            className="flex shrink-0 items-center gap-1.5 rounded-2xl bg-amber-300 px-4 text-sm font-semibold text-zinc-950 transition hover:bg-amber-200">
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Загрузить</span>
          </button>
        )}
      </div>

      <div className="mt-3 flex gap-1.5" role="tablist" aria-label="Разделы каталога">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium transition ${tab === t.id ? 'bg-zinc-100 text-zinc-950' : 'bg-white/6 text-zinc-400 hover:bg-white/10 hover:text-zinc-200'}`}>
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {songs.length === 0 ? (
        <div className="mt-16 flex flex-col items-center text-center">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-white/5">
            <ListMusic className="h-7 w-7 text-zinc-500" />
          </div>
          <h2 className="mt-5 text-lg font-medium text-zinc-200">Пока нет песен</h2>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-zinc-500">
            {canUpload
              ? 'Нажмите «Загрузить» и добавьте первую песню — вокал отделится сам.'
              : 'Запустите бэкенд и загрузите песню через интерфейс, либо соберите пайплайном:'}
          </p>
          {!canUpload && (
            <code className="mt-4 rounded-xl bg-white/5 px-4 py-3 text-left text-[12.5px] leading-relaxed text-zinc-400">
              python src/make_karaoke.py music/трек.mp3
              <br />
              python web/scripts/export_songs.py
            </code>
          )}
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-2.5">
          {filtered.map((s, i) => (
            <SongCard key={s.id} song={s} index={i} />
          ))}
          {filtered.length === 0 && (
            <p className="mt-10 text-center text-sm text-zinc-500">
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
