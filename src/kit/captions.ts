export interface Cue {
  start: number
  end: number
  text: string
}

/** A speech pause: middle of the silence and, if known, its length (seconds). */
export interface Pause {
  at: number
  length?: number
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

/**
 * Split text into sentences: after . ! ? (optionally followed by a closing quote) when the next
 * word starts with an uppercase letter, a digit or an opening quote.
 */
export function splitSentences(text: string): string[] {
  const parts = text
    .trim()
    .split(/(?<=[.!?…][“”"»«']?)\s+(?=[„“"»«A-ZÄÖÜ0-9])/u)
    .map((s) => s.trim())
    .filter(Boolean)
  // no sentence end after an abbreviation ("2,5 Mio. Euro", "z. B. Kassel") or an ordinal ("am 3. Mai")
  const out: string[] = []
  for (const part of parts) {
    const previous = out.at(-1)
    if (previous && (abbreviation.test(previous) || /(^|\s)\d{1,2}\.$/.test(previous))) out[out.length - 1] = `${previous} ${part}`
    else out.push(part)
  }
  return out
}

const abbreviation = /(^|[\s(])(Mio|Mrd|Tsd|Nr|Dr|Prof|St|ca|bzw|vgl|z\. ?B|u\. ?a|d\. ?h|Abs|Art|Anm|etc|inkl|evtl|ggf|max|min|Mr|Mrs|Ms|vs|e\. ?g|i\. ?e)\.$/i

/** Halve a too long piece at a punctuation mark near the middle, else at the space nearest to it. */
function balance(piece: string, maxLength: number): string[] {
  if (piece.length <= maxLength) return [piece]
  const middle = piece.length / 2
  const nearest = (re: RegExp, lo: number, hi: number) => {
    let best = -1
    for (const m of piece.matchAll(re)) {
      const at = m.index + m[0].length - 1
      if (at > piece.length * lo && at < piece.length * hi && (best < 0 || Math.abs(at - middle) < Math.abs(best - middle))) best = at
    }
    return best
  }
  let cut = nearest(/[,;:–—] /g, 0.25, 0.8)
  if (cut < 0) cut = nearest(/ /g, 0, 1)
  if (cut < 0) cut = maxLength
  return [...balance(piece.slice(0, cut).trim(), maxLength), ...balance(piece.slice(cut).trim(), maxLength)]
}

/** Split text into caption-sized pieces: sentences, long ones halved at punctuation or spaces. */
export function splitText(text: string, maxLength = 60): string[] {
  return splitSentences(text).flatMap((s) => balance(s, maxLength))
}

/**
 * Time caption pieces over a spoken passage of `duration` seconds: proportional to their length,
 * each boundary moved to the nearest measured pause (seconds) within `snap` seconds.
 */
export function timeCues(pieces: readonly string[], duration: number, pauses: readonly (number | Pause)[] = [], snap = 1.5): Cue[] {
  const weights = pieces.map((p) => p.length + 10)
  const total = weights.reduce((a, b) => a + b, 0)
  // estimated boundaries between pieces
  const estimates: number[] = []
  let sum = 0
  for (let i = 0; i < pieces.length - 1; i++) estimates.push(((sum += weights[i]) / total) * duration)
  // A sentence end needs a real pause (≥ 0.3 s when the length is known); pauses after commas or
  // colons are shorter. Each pause belongs to the closest eligible boundary; a boundary prefers the
  // candidate with the best score (distance minus pause length, so longer pauses win).
  const sentenceEnd = pieces.map((p) => /[.!?…]["“”»«']?$/.test(p.trim()))
  const score = (p: Pause, i: number) => Math.abs(p.at - estimates[i]) - (p.length ?? 0)
  const chosen: (Pause | undefined)[] = estimates.map(() => undefined)
  for (const raw of pauses) {
    const p: Pause = typeof raw === 'number' ? { at: raw } : raw
    if (p.at <= 0.3 || p.at >= duration - 0.3) continue
    let nearest = -1
    estimates.forEach((e, i) => {
      if (sentenceEnd[i] && p.length !== undefined && p.length < 0.3) return
      if (Math.abs(p.at - e) <= snap && (nearest < 0 || Math.abs(p.at - e) < Math.abs(p.at - estimates[nearest]))) nearest = i
    })
    if (nearest >= 0 && (chosen[nearest] === undefined || score(p, nearest) < score(chosen[nearest]!, nearest))) chosen[nearest] = p
  }
  const bounds = [0]
  estimates.forEach((e, i) => bounds.push(Math.min(Math.max(chosen[i]?.at ?? e, bounds[i] + 0.4), duration)))
  bounds.push(duration)
  return pieces.map((text, i) => ({ start: bounds[i], end: bounds[i + 1], text }))
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
