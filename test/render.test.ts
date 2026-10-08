import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// The integration tests use the built package (dist), like a real user would.
import { openComposition, probe, render, renderStill, resolveFfmpeg } from '../dist/index.js'

const fixture = join(import.meta.dirname, 'fixtures/farben.html')
const ffmpeg = resolveFfmpeg()
let dir: string

type RGB = [number, number, number]

/** Decode an image or one video frame to raw RGB with ffmpeg and read pixels. */
function pixels(file: string, frame = 0) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
    maxBuffer: 1 << 26,
  })
  if (r.status !== 0) throw new Error(String(r.stderr))
  return (x: number, y: number): RGB => {
    const i = (y * 320 + x) * 3
    return [r.stdout[i], r.stdout[i + 1], r.stdout[i + 2]]
  }
}

const near = (actual: RGB, expected: RGB, tolerance = 40) => actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance)

const red: RGB = [255, 0, 0]
const blue: RGB = [0, 0, 255]
const green: RGB = [0, 255, 0]
const white: RGB = [255, 255, 255]
const black: RGB = [0, 0, 0]
const yellow: RGB = [255, 255, 0]
const magenta: RGB = [255, 0, 255]

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'video-maker-'))
  // A 1 s test tone as audio track
  const r = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', join(dir, 'ton.wav')])
  if (r.status !== 0) throw new Error(String(r.stderr))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('still', () => {
  it('shows the state of each frame: frame(), rAF + performance.now, timers, CSS animations', async () => {
    const early = join(dir, 'f2.png')
    const late = join(dir, 'f7.png')
    await renderStill({ input: fixture, frame: 2, out: early })
    await renderStill({ input: fixture, frame: 7, out: late })
    const a = pixels(early)
    const b = pixels(late)
    expect(a(160, 100)).toEqual(red)
    expect(b(160, 100)).toEqual(blue)
    // bar: 20 px at 0.2 s, 70 px at 0.7 s
    expect(a(15, 10)).toEqual(green)
    expect(a(25, 10)).toEqual(red)
    expect(b(65, 10)).toEqual(green)
    expect(b(75, 10)).toEqual(blue)
    // timer fires at 0.3 s
    expect(a(20, 160)).toEqual(black)
    expect(b(20, 160)).toEqual(white)
    // CSS animation switches at 0.5 s
    expect(a(300, 160)).toEqual(yellow)
    expect(b(300, 160)).toEqual(magenta)
  }, 60_000)

  it('is deterministic: the same frame twice gives identical bytes', async () => {
    const first = await renderStill({ input: fixture, frame: 7 })
    const second = await renderStill({ input: fixture, frame: 7 })
    expect(first.equals(second)).toBe(true)
  }, 60_000)

  it('gives the same frame whether reached directly or after earlier frames', async () => {
    const composition = await openComposition({ input: fixture })
    try {
      const sequential = await composition.openPage()
      for (let f = 0; f < 7; f++) await sequential.capture(f)
      const viaSequence = await sequential.capture(7)
      const direct = await (await composition.openPage()).capture(7)
      expect(viaSequence.equals(direct)).toBe(true)
      // Date runs on the virtual clock, too
      const date = await sequential.page.evaluate(() => Number(document.getElementById('bar')!.dataset.date))
      expect(date).toBe(Date.UTC(2026, 0, 1) + 700)
    } finally {
      await composition.close()
    }
  }, 60_000)
})

describe('render', () => {
  it('writes an MP4 with the right size, frame count, duration and an AAC track', async () => {
    const out = join(dir, 'film.mp4')
    const result = await render({ input: fixture, out, parallel: 3, audio: [{ file: join(dir, 'ton.wav'), start: 0.2, volume: 0.5 }] })
    expect(result.frames).toBe(10)

    const info = await probe(out)
    expect(info).toMatchObject({ width: 320, height: 180, frames: 10, videoCodec: 'h264', pixelFormat: 'yuv420p', audioCodec: 'aac' })
    expect(info.duration).toBeGreaterThan(0.95)
    expect(info.duration).toBeLessThan(1.1)

    // faststart: moov atom before mdat
    const bytes = readFileSync(out)
    expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat'))

    // frames arrive in order even with parallel pages
    for (let f = 0; f < 10; f++) {
      const px = pixels(out, f)
      expect(near(px(160, 100), f < 5 ? red : blue), `frame ${f}`).toBe(true)
      expect(near(px(300, 160), f < 5 ? yellow : magenta), `frame ${f}`).toBe(true)
    }
  }, 120_000)

  it('places an audio track at its start time', async () => {
    // 0.3 s tone, placed at 0.4 s: sound must begin at 0.4 s in the output
    const tone = join(dir, 'kurz.wav')
    const r = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', tone])
    if (r.status !== 0) throw new Error(String(r.stderr))
    const out = join(dir, 'einsatz.mp4')
    await render({ input: fixture, out, parallel: 1, audio: [{ file: tone, start: 0.4 }] })
    const log = spawnSync(ffmpeg, ['-i', out, '-af', 'silencedetect=noise=-30dB:d=0.05', '-f', 'null', '-'], { encoding: 'utf8' }).stderr
    expect(Number(/silence_end: ([\d.]+)/.exec(log)?.[1])).toBeCloseTo(0.4, 1)
  }, 120_000)

  it('can render without audio', async () => {
    const out = join(dir, 'stumm.mp4')
    await render({ input: fixture, out, parallel: 1, imageFormat: 'png', range: [0, 4] })
    const info = await probe(out)
    expect(info.frames).toBe(4)
    expect(info.audioCodec).toBeUndefined()
  }, 120_000)
})
