/**
 * Дата-тест конвейера эталона на реальных песнях (скрим, мелодия, длинный поп):
 * сырой pyin озвучивает инструментальный bleed — проверяем, что после
 * display + гейта по сегментам фантомов нет, а пение покрыто целиком.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { displayPitchTrack, gatePitchToSegments, quantizePitchTrack } from './pitch'

// Данные читаем с диска (а не импортом): песни живут в data/songs за
// корнем web — vite не резолвит модули наружу. Всегда живые данные стора.
const DATA = join(process.cwd(), '..', 'data', 'songs')
const load = (sid: string, name: string) =>
  JSON.parse(readFileSync(join(DATA, sid, name), 'utf-8'))
const vikPitch = load('igor-vikhorkov-ty-shljukha-ne-moja', 'pitch.json')
const vikLyrics = load('igor-vikhorkov-ty-shljukha-ne-moja', 'lyrics.json')
const evrPitch = load('icegergert-evrodensru', 'pitch.json')
const evrLyrics = load('icegergert-evrodensru', 'lyrics.json')
const vayPitch = load('serega-pirat-vaybmen', 'pitch.json')
const vayLyrics = load('serega-pirat-vaybmen', 'lyrics.json')

interface RawPitch {
  t: number[]
  midi: (number | null)[]
}
interface Word {
  w: string
  s: number
  e: number
}
interface Seg {
  start: number
  end: number
  words: Word[]
}

const SONGS: { name: string; pitch: RawPitch; lyrics: { segments: Seg[] } }[] = [
  { name: 'skrim', pitch: vikPitch as RawPitch, lyrics: vikLyrics as { segments: Seg[] } },
  { name: 'melodiya', pitch: evrPitch as RawPitch, lyrics: evrLyrics as { segments: Seg[] } },
  { name: 'longpop', pitch: vayPitch as RawPitch, lyrics: vayLyrics as { segments: Seg[] } },
]

function voicedIn(track: RawPitch, a: number, b: number): number {
  return voicedTotal(track, a, b)[0]
}

function voicedTotal(track: RawPitch, a: number, b: number): [number, number] {
  let c = 0
  let n = 0
  for (let k = 0; k < track.t.length; k++) {
    if (track.t[k] >= a && track.t[k] <= b) {
      n++
      if (track.midi[k] !== null) c++
    }
  }
  return [c, n]
}

describe('etalon na realnyh pesnyah', () => {
  for (const s of SONGS) {
    it(`${s.name}: bleed vne segmentov est v syryh dannyh`, () => {
      // Констатируем проблему: void, который должен вырезать гейт.
      // Информационный замер (не гейт): если bleed исчезнет из данных —
      // тем лучше, тест не упадёт.
      const raw = s.pitch
      const segs = s.lyrics.segments
      const out = voicedIn(raw, 0, segs[0].start - 0.5)
      console.log(`${s.name}: intro voiced=${out} (do pervogo slova)`)
      expect(segs.length).toBeGreaterThan(5)
    })

    it(`${s.name}: gejt ubiraet vse fantomy vne peniya`, () => {
      const segs = s.lyrics.segments.map((x) => ({ start: x.start, end: x.end }))
      for (const q of [displayPitchTrack(s.pitch), quantizePitchTrack(s.pitch)]) {
        const g = gatePitchToSegments(q, segs)!
        // интро до первой маржи
        expect(voicedIn(g, 0, segs[0].start - 0.5)).toBe(0)
        // аутро после последней маржи
        const last = segs[segs.length - 1]
        expect(voicedIn(g, last.end + 0.5, g.t[g.t.length - 1])).toBe(0)
        // длинные разрывы между сегментами (>2с — соло/проигрыш, не дыхание)
        for (let i = 0; i + 1 < segs.length; i++) {
          if (segs[i + 1].start - segs[i].end > 2) {
            expect(voicedIn(g, segs[i].end + 0.5, segs[i + 1].start - 0.5)).toBe(0)
          }
        }
      }
    })

    it(`${s.name}: gladkiy trek ne teryaet uverenno-ozvuchennye slova`, () => {
      // Инвариант «не навреди»: уверенно озвученное слово (>=4 сэмплов
      // и >=15% покрытия — ниже только переходные дребезги и гроул,
      // у которого опорной высоты нет) обязано сохранить хоть что-то
      // в окне слова ±50мс (допуск неточности границ транскрибера).
      // Иммунен к качеству текста (галлюцинации на инструментале —
      // там и в сырье пусто, это не потеря).
      const segs = s.lyrics.segments.map((x) => ({ start: x.start, end: x.end }))
      const g = gatePitchToSegments(displayPitchTrack(s.pitch), segs)!
      const words = s.lyrics.segments.flatMap((x) => x.words)
      let lost = 0
      let had = 0
      let exempt = 0
      for (const w of words) {
        const [rawN, rawT] = voicedTotal(s.pitch, w.s, w.e)
        if (rawN >= 4 && rawN / Math.max(1, rawT) >= 0.15) {
          had++
          if (voicedIn(g, w.s - 0.05, w.e + 0.05) === 0) {
            lost++
            console.log(`  LOST ${w.w} ${w.s.toFixed(2)}-${w.e.toFixed(2)} (raw ${rawN})`)
          }
        } else if (rawN > 0) {
          exempt++
        }
      }
      console.log(`${s.name}: uverennyh ${had}/${words.length}, poteryano ${lost}, transientov ${exempt}`)
      expect(lost).toBe(0)
    })
  }
})
