export interface Cue {
  start: number
  end: number
  text: string
}

/** The cue visible at time t (start <= t < end), or undefined. Cues may be unsorted. */
export function captionAt(cues: readonly Cue[], t: number): Cue | undefined {
  let hit: Cue | undefined
  for (const cue of cues) if (t >= cue.start && t < cue.end && (!hit || cue.start >= hit.start)) hit = cue
  return hit
}

/**
 * Distribute text pieces over [start, end] in proportion to their length.
 * Handy when only the total speaking time of a passage is known.
 */
export function spreadCues(pieces: readonly string[], start: number, end: number): Cue[] {
  const total = pieces.reduce((n, p) => n + p.length, 0)
  let t = start
  return pieces.map((text, i) => {
    const from = t
    t = i === pieces.length - 1 ? end : t + ((end - start) * text.length) / total
    return { start: from, end: t, text }
  })
}

/** Split text into caption-sized pieces at sentence ends, then at commas or spaces if too long. */
export function splitText(text: string, maxLength = 60): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? []
  const pieces: string[] = []
  for (const sentence of sentences) {
    let rest = sentence
    while (rest.length > maxLength) {
      const window = rest.slice(0, maxLength + 1)
      let cut = window.lastIndexOf(', ')
      cut = cut > maxLength / 3 ? cut + 1 : window.lastIndexOf(' ')
      if (cut <= 0) cut = maxLength
      pieces.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) pieces.push(rest)
  }
  return pieces
}

/** Parse SRT or WebVTT into cues with times in seconds. */
export function parseSubtitles(source: string): Cue[] {
  const time = (s: string) => {
    const parts = s.trim().replace(',', '.').split(':').map(Number)
    return parts.reduce((acc, n) => acc * 60 + n, 0)
  }
  const cues: Cue[] = []
  for (const block of source.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n')
    const i = lines.findIndex((l) => l.includes('-->'))
    if (i < 0) continue
    const [from, to] = lines[i].split('-->')
    cues.push({ start: time(from), end: time(to.trim().split(/\s+/)[0]), text: lines.slice(i + 1).join('\n').trim() })
  }
  return cues
}
