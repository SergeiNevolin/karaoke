import { AnimatePresence, motion } from 'framer-motion'
import { MicVocal } from 'lucide-react'
import { useEffect, useState } from 'react'
import Catalog from './components/Catalog'
import Player from './components/Player'
import { loadManifest, plural } from './lib/songs'
import { useKaraoke } from './store'

export default function App() {
  const screen = useKaraoke((s) => s.screen)
  const songs = useKaraoke((s) => s.songs)
  const setSongs = useKaraoke((s) => s.setSongs)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    loadManifest().then(setSongs).catch(() => setLoadError(true))
  }, [setSongs])

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="mx-auto flex w-full max-w-3xl items-center gap-2.5 px-5 py-4">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary">
          <MicVocal className="h-4.5 w-4.5 text-white" />
        </div>
        <h1 className="text-[17px] font-semibold tracking-tight text-text">Караоке</h1>
        {songs.length > 0 && (
          <span className="ml-auto rounded-full bg-surface-hover px-3 py-1 text-xs text-muted">
            {songs.length} {plural(songs.length, 'песня', 'песни', 'песен')}
          </span>
        )}
      </header>

      {loadError && songs.length === 0 && (
        <p className="mx-auto w-full max-w-3xl px-5 pb-2 text-[13px] text-danger">
          Не удалось загрузить каталог — проверьте сеть или запустите бэкенд
        </p>
      )}

      <main className="min-h-0 flex-1">
        <AnimatePresence mode="wait">
          <motion.div
            key={screen}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
            className="h-full"
          >
            {screen === 'catalog' ? <Catalog /> : <Player />}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  )
}
