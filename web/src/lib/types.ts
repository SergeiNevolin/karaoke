export interface Word {
  w: string
  s: number
  e: number
}

export interface Segment {
  start: number
  end: number
  text: string
  words: Word[]
  part?: string
}

/** пропуск: момент, который петь не надо (брейк, кричалка, чужой кусок).
 * Вокал оригинала там оставляем слышным, очки не судим. */
export interface SkipRange {
  s: number
  e: number
}

export interface PitchTrack {
  t: number[]
  /** MIDI-ноты, null = пауза */
  midi: (number | null)[]
  /** уверенность трекера 0..1 (CREPE periodicity), null = нет данных */
  conf?: (number | null)[]
}

export interface SongMeta {
  id: string
  title: string
  audio: string
  /** полная версия песни — играется в редакторе, может отсутствовать */
  original?: string | null
  /** изолированный вокал (запасной трек редактора), может отсутствовать */
  vocals?: string | null
  language?: string
  lines: number
  duration: number
}

export interface SongData extends SongMeta {
  segments: Segment[]
  /** строгий эталон для скоринга: только уверенные места */
  pitch: PitchTrack | null
  /** гладкий контур для показа: без дыр там, где есть пение */
  pitchSmooth?: PitchTrack | null
  /** пропуски «не поём»: вокал оригинала слышно, очки не судим */
  skips?: SkipRange[]
  waveform: WaveformData | null
}

export interface WaveformData {
  peaks: number[]
  duration: number
}

export interface Manifest {
  songs: SongMeta[]
}

export interface ScoreResult {
  score: number
  hits: number
  /** идеально (<=полтона) */
  perfect: number
  /** мимо: мимо ноты + молчание под ноты */
  misses: number
  total: number
  medianError: number
  /** ритм: вступление вовремя — отдельно от высоты */
  timing?: TimingResult
  /** слова: попадание в высоту по словам */
  words?: WordScore
}

/** итог по словам: попал / всего (без эталона слово вне зачёта) */
export interface WordScore {
  hit: number
  total: number
}

/** итог ритма: судят только спетые ноты (молчание — не опоздание) */
export interface TimingResult {
  /** 0..100, взвешено по длительностям спетых нот */
  score: number
  /** медиана |смещения вступления| в мс */
  medianMs: number
  /** спетых нот */
  sung: number
  /** всего нот */
  total: number
}
