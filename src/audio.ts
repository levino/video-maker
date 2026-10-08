export interface AudioTrack {
  file: string
  /** Start in the video, seconds (default 0). */
  start?: number
  /** Linear gain, 1 = unchanged (default 1). */
  volume?: number
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

/**
 * Build the ffmpeg filter graph that delays, scales and mixes all tracks and pads/cuts the
 * result to the video duration. `firstInput` is the ffmpeg input index of the first track.
 */
export function planAudioMix(tracks: readonly AudioTrack[], duration: number, firstInput = 1): AudioMixPlan | undefined {
  if (tracks.length === 0) return undefined
  const parts: string[] = []
  const labels: string[] = []
  tracks.forEach((track, i) => {
    const start = track.start ?? 0
    const volume = track.volume ?? 1
    if (start < 0) throw new Error(`Audio ${track.file}: start must be >= 0`)
    if (!(volume >= 0)) throw new Error(`Audio ${track.file}: volume must be >= 0`)
    const ms = Math.round(start * 1000)
    parts.push(`[${firstInput + i}:a]aresample=48000,adelay=${ms}:all=1,volume=${volume}[a${i}]`)
    labels.push(`[a${i}]`)
  })
  const mixed = tracks.length > 1 ? `${labels.join('')}amix=inputs=${tracks.length}:duration=longest:normalize=0,` : labels[0]
  parts.push(`${mixed}apad,atrim=0:${duration}[aout]`)
  return { inputs: tracks.map((t) => t.file), filter: parts.join(';') }
}
