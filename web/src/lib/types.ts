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

export interface PitchTrack {
  t: number[]
  /** MIDI-ноты, null = пауза */
  midi: (number | null)[]
}

export interface SongMeta {
  id: string
  title: string
  audio: string
  /** оригинал вокала (для редактора тайминга), может отсутствовать */
  vocals?: string | null
  language?: string
  lines: number
  duration: number
}

export interface SongData extends SongMeta {
  segments: Segment[]
  pitch: PitchTrack | null
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
  total: number
  medianError: number
}
