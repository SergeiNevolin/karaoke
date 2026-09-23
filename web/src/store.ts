import { create } from 'zustand'
import type { SongData, SongMeta } from './lib/types'

type Screen = 'catalog' | 'player'

function readJSON(key: string, fallback: string[]): string[] {
  try {
    const raw = localStorage.getItem(key)
    const v = raw ? (JSON.parse(raw) as unknown) : fallback
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : fallback
  } catch {
    return fallback
  }
}

const FAV_KEY = 'karaoke:favorites'
const RECENT_KEY = 'karaoke:recent'

function persist(favorites: string[], recent: string[]) {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(favorites))
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
  } catch {
    /* приватный режим — просто не запоминаем */
  }
}

interface KaraokeState {
  screen: Screen
  songs: SongMeta[]
  song: SongData | null
  loadingSong: boolean
  favorites: string[]
  recent: string[]
  setSongs: (s: SongMeta[]) => void
  openSong: (s: SongData) => void
  back: () => void
  setLoadingSong: (v: boolean) => void
  toggleFavorite: (id: string) => void
  pushRecent: (id: string) => void
}

export const useKaraoke = create<KaraokeState>((set, get) => ({
  screen: 'catalog',
  songs: [],
  song: null,
  loadingSong: false,
  favorites: readJSON(FAV_KEY, []),
  recent: readJSON(RECENT_KEY, []),
  setSongs: (songs) => set({ songs }),
  openSong: (song) => set({ song, screen: 'player' }),
  back: () => set({ screen: 'catalog', song: null }),
  setLoadingSong: (v) => set({ loadingSong: v }),
  toggleFavorite: (id) => {
    const has = get().favorites.includes(id)
    const favorites = has ? get().favorites.filter((f) => f !== id) : [...get().favorites, id]
    persist(favorites, get().recent)
    set({ favorites })
  },
  pushRecent: (id) => {
    const recent = [id, ...get().recent.filter((r) => r !== id)].slice(0, 20)
    persist(get().favorites, recent)
    set({ recent })
  },
}))
