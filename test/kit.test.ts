import { describe, expect, it } from 'vitest'
import {
  activeAt,
  captionAt,
  crossfade,
  cubicBezier,
  ease,
  fade,
  mapRange,
  mixColor,
  parseSubtitles,
  progress,
  random,
  sceneAt,
  sequence,
  splitText,
  spreadCues,
  steps,
  totalLength,
} from '../src/kit/index.js'

describe('easing', () => {
  const all = Object.entries(ease).filter(([name]) => name !== 'out' && name !== 'inOut') as [string, (p: number) => number][]

  it.each(all)('%s starts at 0 and ends at 1', (_, fn) => {
    expect(fn(0)).toBeCloseTo(0, 6)
    expect(fn(1)).toBeCloseTo(1, 6)
  })

  it('in-out easings are symmetric around the middle', () => {
    for (const fn of [ease.inOutQuad, ease.inOutCubic, ease.inOutSine]) {
      expect(fn(0.5)).toBeCloseTo(0.5, 6)
      expect(fn(0.2) + fn(0.8)).toBeCloseTo(1, 6)
    }
  })

  it('quad and cubic follow their power curves', () => {
    expect(ease.inQuad(0.5)).toBe(0.25)
    expect(ease.outQuad(0.5)).toBe(0.75)
    expect(ease.inCubic(0.5)).toBe(0.125)
  })

  it('outBack overshoots', () => {
    expect(Math.max(...[0.6, 0.7, 0.8, 0.9].map(ease.outBack))).toBeGreaterThan(1)
  })

  it('cubicBezier matches linear and known CSS ease values', () => {
    const linear = cubicBezier(0, 0, 1, 1)
    for (const p of [0.1, 0.33, 0.9]) expect(linear(p)).toBeCloseTo(p, 4)
    const cssEase = cubicBezier(0.25, 0.1, 0.25, 1)
    expect(cssEase(0.5)).toBeCloseTo(0.8024, 3)
    expect(cssEase(0)).toBe(0)
    expect(cssEase(1)).toBe(1)
  })

  it('steps jumps at the end of each step', () => {
    const s = steps(4)
    expect([0, 0.24, 0.25, 0.6, 0.99, 1].map(s)).toEqual([0, 0, 0.25, 0.5, 0.75, 1])
  })
})

describe('mapRange', () => {
  it('maps linearly inside the range', () => {
    expect(mapRange(15, [10, 20], [0, 100])).toBe(50)
    expect(mapRange(15, [10, 20], [100, 0])).toBe(50)
  })

  it('clamps by default and extrapolates on request', () => {
    expect(mapRange(-5, [0, 10], [0, 1])).toBe(0)
    expect(mapRange(25, [0, 10], [0, 1])).toBe(1)
    expect(mapRange(20, [0, 10], [0, 1], { clamp: false })).toBe(2)
    expect(mapRange(-10, [0, 10], [0, 1], { clamp: false })).toBe(-1)
  })

  it('handles several segments', () => {
    const f = (t: number) => mapRange(t, [0, 10, 30], [0, 1, 0])
    expect([0, 5, 10, 20, 30, 40].map(f)).toEqual([0, 0.5, 1, 0.5, 0, 0])
  })

  it('applies easing per segment', () => {
    expect(mapRange(5, [0, 10], [0, 100], { ease: ease.inQuad })).toBe(25)
    expect(mapRange(15, [0, 10, 20], [0, 100, 200], { ease: ease.inQuad })).toBe(125)
  })

  it('rejects bad stops', () => {
    expect(() => mapRange(0, [0], [1])).toThrow()
    expect(() => mapRange(0, [0, 1], [1, 2, 3])).toThrow()
    expect(() => mapRange(0, [0, 0], [1, 2])).toThrow()
  })

  it('progress is clamped and optionally eased', () => {
    expect(progress(5, 0, 10)).toBe(0.5)
    expect(progress(-1, 0, 10)).toBe(0)
    expect(progress(11, 0, 10)).toBe(1)
    expect(progress(5, 0, 10, ease.inQuad)).toBe(0.25)
  })

  it('mixColor blends hex colors', () => {
    expect(mixColor('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixColor('#ff0000', '#0000ff', 0)).toBe('#ff0000')
    expect(mixColor('#ff0000', '#0000ff', 1)).toBe('#0000ff')
  })

  it('random is deterministic and in [0, 1)', () => {
    expect(random('a')).toBe(random('a'))
    expect(random(1)).not.toBe(random(2))
    for (let i = 0; i < 100; i++) {
      const r = random(i)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThan(1)
    }
  })
})

describe('scenes', () => {
  it('sceneAt reports activity, local time and progress', () => {
    const span = { start: 30, duration: 60 }
    expect(sceneAt(29, span)).toEqual({ active: false, local: -1, progress: 0 })
    expect(sceneAt(30, span)).toEqual({ active: true, local: 0, progress: 0 })
    expect(sceneAt(60, span)).toEqual({ active: true, local: 30, progress: 0.5 })
    expect(sceneAt(90, span).active).toBe(false)
    expect(sceneAt(120, span).progress).toBe(1)
  })

  it('sequence places items back to back', () => {
    const s = sequence([{ duration: 10 }, { duration: 20 }, { duration: 5 }])
    expect(s.map((x) => x.start)).toEqual([0, 10, 30])
    expect(totalLength(s)).toBe(35)
  })

  it('sequence with overlap starts each item early and keeps extra fields', () => {
    const s = sequence(
      [
        { name: 'a', duration: 10 },
        { name: 'b', duration: 20 },
        { name: 'c', duration: 5 },
      ],
      { overlap: 4, start: 100 },
    )
    expect(s.map((x) => [x.name, x.start])).toEqual([
      ['a', 100],
      ['b', 106],
      ['c', 122],
    ])
    expect(totalLength(s)).toBe(127)
    expect(activeAt(107, s).map((x) => x.name)).toEqual(['a', 'b'])
  })

  it('fade ramps in and out within the span', () => {
    const span = { start: 0, duration: 100 }
    const f = (t: number) => fade(t, span, { fadeIn: 10, fadeOut: 20 })
    expect([-1, 0, 5, 10, 50, 90, 95, 100].map(f)).toEqual([0, 0, 0.5, 1, 1, 0.5, 0.25, 0])
    expect(fade(50, span)).toBe(1)
  })

  it('crossfade swaps opacities over its length', () => {
    expect(crossfade(0, 10, 10)).toEqual([1, 0])
    expect(crossfade(15, 10, 10)).toEqual([0.5, 0.5])
    expect(crossfade(25, 10, 10)).toEqual([0, 1])
  })
})

describe('captions', () => {
  const cues = [
    { start: 0, end: 2, text: 'eins' },
    { start: 2, end: 3.5, text: 'zwei' },
    { start: 5, end: 6, text: 'drei' },
  ]

  it('captionAt uses start <= t < end', () => {
    expect(captionAt(cues, 0)?.text).toBe('eins')
    expect(captionAt(cues, 1.99)?.text).toBe('eins')
    expect(captionAt(cues, 2)?.text).toBe('zwei')
    expect(captionAt(cues, 4)).toBeUndefined()
    expect(captionAt(cues, 6)).toBeUndefined()
  })

  it('captionAt prefers the later cue when cues overlap', () => {
    expect(captionAt([{ start: 0, end: 10, text: 'a' }, { start: 5, end: 7, text: 'b' }], 6)?.text).toBe('b')
  })

  it('spreadCues splits time by text length and ends exactly', () => {
    const c = spreadCues(['aaaa', 'aa', 'aa'], 10, 18)
    expect(c.map((x) => [x.start, x.end])).toEqual([
      [10, 14],
      [14, 16],
      [16, 18],
    ])
  })

  it('splitText breaks at sentences and long sentences at commas or spaces', () => {
    expect(splitText('Erster Satz. Zweiter Satz!')).toEqual(['Erster Satz.', 'Zweiter Satz!'])
    const pieces = splitText('Ein recht langer Satz, der weitergeht und weitergeht und noch weiter geht bis zum Ende.', 40)
    expect(pieces[0]).toBe('Ein recht langer Satz,')
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(40)
    expect(pieces.join(' ')).toBe('Ein recht langer Satz, der weitergeht und weitergeht und noch weiter geht bis zum Ende.')
  })

  it('parseSubtitles reads SRT and VTT', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,500\nHallo\n\n2\n00:00:03,000 --> 00:00:04,000\nzwei\nZeilen\n'
    expect(parseSubtitles(srt)).toEqual([
      { start: 1, end: 2.5, text: 'Hallo' },
      { start: 3, end: 4, text: 'zwei\nZeilen' },
    ])
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000 align:center\nKurz\n'
    expect(parseSubtitles(vtt)).toEqual([{ start: 1, end: 2, text: 'Kurz' }])
  })
})
