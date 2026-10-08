export interface AudioTrack {
  file: string
  /** Start in the video, seconds (default 0). */
  start?: number
  /**
   * Linear gain (default 1), or an envelope of [videoSeconds, gain] points,
   * interpolated linearly and held before the first and after the last point.
   */
  volume?: number | [number, number][]
  /** Skip this many seconds at the beginning of the file. */
  offset?: number
  /** Play at most this many seconds of the file. */
  duration?: number
  /** Fade in/out in seconds. fadeOut needs `duration`. */
  fadeIn?: number
  fadeOut?: number
}

export interface AudioMixPlan {
  /** Files to pass as additional ffmpeg inputs, in order. */
  inputs: string[]
  /** -filter_complex graph producing the label [aout]. */
  filter: string
}

/**
 * Parse a CLI spec: `file.mp3`, `file.mp3@1.5s`, `file.mp3@250ms`, `file.mp3@2s,vol=0.8`.
 * A bare number after @ means seconds.
 */
export function parseAudioSpec(spec: string): AudioTrack {
  const m = /^(.+?)(?:@(\d+(?:\.\d+)?)(ms|s)?)?(?:,vol(?:ume)?=(\d+(?:\.\d+)?))?$/.exec(spec)
  if (!m) throw new Error(`Invalid audio spec: ${spec}`)
  const [, file, at, unit, vol] = m
  const track: AudioTrack = { file }
  if (at !== undefined) track.start = unit === 'ms' ? Number(at) / 1000 : Number(at)
  if (vol !== undefined) track.volume = Number(vol)
  return track
}

const num = (n: number) => String(Math.round(n * 1e6) / 1e6)

/** ffmpeg expression for a piecewise linear envelope over t. */
export function envelopeExpression(points: readonly [number, number][]): string {
  const sorted = [...points].sort((a, b) => a[0] - b[0])
  let expr = num(sorted[sorted.length - 1][1])
  for (let i = sorted.length - 2; i >= 0; i--) {
    const [t0, v0] = sorted[i]
    const [t1, v1] = sorted[i + 1]
    const segment = t1 > t0 ? `${num(v0)}+(${num(v1 - v0)})*(t-${num(t0)})/${num(t1 - t0)}` : num(v1)
    expr = `if(lt(t,${num(t1)}),${segment},${expr})`
  }
  return `if(lt(t,${num(sorted[0][0])}),${num(sorted[0][1])},${expr})`
}

/**
 * Build the ffmpeg filter graph that trims, fades, delays, scales and mixes all tracks and
 * pads/cuts the result to the video duration. `firstInput` is the ffmpeg input index of the first track.
 */
export function planAudioMix(tracks: readonly AudioTrack[], duration: number, firstInput = 1): AudioMixPlan | undefined {
  if (tracks.length === 0) return undefined
  const parts: string[] = []
  const labels: string[] = []
  tracks.forEach((track, i) => {
    const start = track.start ?? 0
    const volume = track.volume ?? 1
    if (start < 0) throw new Error(`Audio ${track.file}: start must be >= 0`)
    if (typeof volume === 'number' ? !(volume >= 0) : volume.length === 0 || volume.some(([, v]) => !(v >= 0)))
      throw new Error(`Audio ${track.file}: volume must be >= 0`)
    if (track.fadeOut && track.duration === undefined) throw new Error(`Audio ${track.file}: fadeOut needs duration`)
    const chain = ['aresample=48000']
    if (track.offset || track.duration !== undefined) {
      const from = track.offset ?? 0
      chain.push(`atrim=start=${num(from)}${track.duration !== undefined ? `:end=${num(from + track.duration)}` : ''}`, 'asetpts=PTS-STARTPTS')
    }
    if (track.fadeIn) chain.push(`afade=t=in:st=0:d=${num(track.fadeIn)}`)
    if (track.fadeOut) chain.push(`afade=t=out:st=${num(Math.max(0, track.duration! - track.fadeOut))}:d=${num(track.fadeOut)}`)
    chain.push(`adelay=${Math.round(start * 1000)}:all=1`)
    chain.push(typeof volume === 'number' ? `volume=${num(volume)}` : `volume='${envelopeExpression(volume)}':eval=frame`)
    parts.push(`[${firstInput + i}:a]${chain.join(',')}[a${i}]`)
    labels.push(`[a${i}]`)
  })
  const mixed = tracks.length > 1 ? `${labels.join('')}amix=inputs=${tracks.length}:duration=longest:normalize=0,` : labels[0]
  parts.push(`${mixed}apad,atrim=0:${num(duration)}[aout]`)
  return { inputs: tracks.map((t) => t.file), filter: parts.join(';') }
}
