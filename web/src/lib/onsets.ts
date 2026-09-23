/** Начала звуков (onsets) по пикам waveform — для магнита границ слов. */
export function computeOnsets(peaks: number[], duration: number): number[] {
  const n = peaks.length
  if (!n || !duration) return []
  // лёгкое сглаживание против дрожания
  const sm: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const a = peaks[Math.max(0, i - 1)]
    const b = peaks[i]
    const c = peaks[Math.min(n - 1, i + 1)]
    sm[i] = (a + b + c) / 3
  }
  const bd = duration / n
  const out: number[] = []
  for (let i = 1; i < n; i++) {
    if (sm[i] - sm[i - 1] >= 0.1 && sm[i] >= 0.08) {
      const t = Math.round(i * bd * 100) / 100
      if (!out.length || t - out[out.length - 1] > 0.15) out.push(t)
    }
  }
  return out
}

/** притянуть время к ближайшему началу звука в окне win (сек) */
export function snapToOnset(t: number, onsets: number[], win = 0.18): number {
  let best = t
  let bd = win
  for (const o of onsets) {
    const d = Math.abs(o - t)
    if (d < bd) {
      bd = d
      best = o
    }
  }
  return Math.round(best * 100) / 100
}
