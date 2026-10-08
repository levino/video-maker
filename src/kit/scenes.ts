import type { EaseFn } from './easing.js'
import { progress } from './range.js'

/** A time span in frames (or any unit, as long as it is used consistently). */
export interface Span {
  start: number
  duration: number
}

export interface SceneState {
  /** start <= t < start + duration */
  active: boolean
  /** Time since scene start (may be negative or beyond duration). */
  local: number
  /** local / duration, clamped to 0..1 */
  progress: number
}

export function sceneAt(t: number, span: Span): SceneState {
  const local = t - span.start
  return {
    active: local >= 0 && local < span.duration,
    local,
    progress: span.duration > 0 ? Math.min(1, Math.max(0, local / span.duration)) : 1,
  }
}

/**
 * Lay out items back to back. With `overlap`, every item after the first starts
 * `overlap` units before the previous one ends (for cross-fades).
 */
export function sequence<T extends { duration: number }>(items: readonly T[], options: { start?: number; overlap?: number } = {}): (T & Span)[] {
  const overlap = options.overlap ?? 0
  let start = options.start ?? 0
  return items.map((item, i) => {
    if (i > 0) start -= overlap
    const placed = { ...item, start }
    start += item.duration
    return placed
  })
}

/** End of the last span in a list. */
export const totalLength = (spans: readonly Span[]) => spans.reduce((end, s) => Math.max(end, s.start + s.duration), 0)

/** All spans active at t, in list order (later = on top). */
export const activeAt = <T extends Span>(t: number, spans: readonly T[]) => spans.filter((s) => sceneAt(t, s).active)

/**
 * Opacity envelope for a span: ramps up over `fadeIn` at the start and down over `fadeOut`
 * at the end. Returns 0 outside the span.
 */
export function fade(t: number, span: Span, options: { fadeIn?: number; fadeOut?: number; ease?: EaseFn } = {}): number {
  const { fadeIn = 0, fadeOut = 0, ease } = options
  const s = sceneAt(t, span)
  if (!s.active) return 0
  const up = fadeIn > 0 ? progress(s.local, 0, fadeIn, ease) : 1
  const down = fadeOut > 0 ? progress(span.duration - s.local, 0, fadeOut, ease) : 1
  return Math.min(up, down)
}

/**
 * Cross-fade starting at `at` and lasting `length`. Returns [outgoing, incoming] opacities.
 */
export function crossfade(t: number, at: number, length: number, ease?: EaseFn): [number, number] {
  const p = progress(t, at, at + length, ease)
  return [1 - p, p]
}
