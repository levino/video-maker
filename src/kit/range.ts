import type { EaseFn } from './easing.js'

export interface MapOptions {
  /** Applied to the progress within each segment. */
  ease?: EaseFn
  /** Hold the end values outside the input range (default true). false extrapolates linearly. */
  clamp?: boolean
}

/** Linear blend between a and b. */
export const mix = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * Piecewise mapping: `mapRange(frame, [0, 30, 60], [0, 1, 0])`.
 * The input stops must be strictly increasing; both arrays need the same length (>= 2).
 */
export function mapRange(value: number, input: readonly number[], output: readonly number[], options: MapOptions = {}): number {
  if (input.length < 2 || input.length !== output.length) throw new Error('mapRange: input and output need the same length (>= 2)')
  for (let i = 1; i < input.length; i++) {
    if (!(input[i] > input[i - 1])) throw new Error('mapRange: input stops must be strictly increasing')
  }
  const clamp = options.clamp ?? true
  const last = input.length - 1
  if (clamp && value <= input[0]) return output[0]
  if (clamp && value >= input[last]) return output[last]
  let i = 0
  while (i < last - 1 && value > input[i + 1]) i++
  let p = (value - input[i]) / (input[i + 1] - input[i])
  if (options.ease && p >= 0 && p <= 1) p = options.ease(p)
  return mix(output[i], output[i + 1], p)
}

/** Progress 0..1 of value between start and end, clamped, optionally eased. */
export function progress(value: number, start: number, end: number, ease?: EaseFn): number {
  const p = Math.min(1, Math.max(0, (value - start) / (end - start)))
  return ease ? ease(p) : p
}

/** Blend two #rrggbb colors. */
export function mixColor(a: string, b: string, t: number): string {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const [ca, cb] = [rgb(a), rgb(b)]
  return '#' + ca.map((v, i) => Math.round(mix(v, cb[i], t)).toString(16).padStart(2, '0')).join('')
}

/** Deterministic pseudo-random number in [0, 1) for a seed (number or string). */
export function random(seed: number | string): number {
  let h = 2166136261
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  h = Math.imul(h ^ (h >>> 15), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
