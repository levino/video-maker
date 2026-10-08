import { describe, expect, it } from 'vitest'
import { parseAudioSpec, planAudioMix } from '../src/audio.js'
import { encodeArgs } from '../src/ffmpeg.js'

describe('parseAudioSpec', () => {
  it('reads file, start and volume', () => {
    expect(parseAudioSpec('a.mp3')).toEqual({ file: 'a.mp3' })
    expect(parseAudioSpec('a.mp3@0s')).toEqual({ file: 'a.mp3', start: 0 })
    expect(parseAudioSpec('dir/a b.wav@1.5s')).toEqual({ file: 'dir/a b.wav', start: 1.5 })
    expect(parseAudioSpec('a.mp3@250ms')).toEqual({ file: 'a.mp3', start: 0.25 })
    expect(parseAudioSpec('a.mp3@2')).toEqual({ file: 'a.mp3', start: 2 })
    expect(parseAudioSpec('a.mp3@2s,vol=0.3')).toEqual({ file: 'a.mp3', start: 2, volume: 0.3 })
    expect(parseAudioSpec('musik.mp3,volume=0.5')).toEqual({ file: 'musik.mp3', volume: 0.5 })
  })
})

describe('planAudioMix', () => {
  it('returns nothing without tracks', () => {
    expect(planAudioMix([], 10)).toBeUndefined()
  })

  it('delays, scales, pads and trims a single track', () => {
    const plan = planAudioMix([{ file: 'voice.wav', start: 0.3 }], 12)!
    expect(plan.inputs).toEqual(['voice.wav'])
    expect(plan.filter).toBe('[1:a]aresample=48000,adelay=300:all=1,volume=1[a0];[a0]apad,atrim=0:12[aout]')
  })

  it('mixes several tracks without normalizing their levels', () => {
    const plan = planAudioMix(
      [
        { file: 'voice.wav', start: 1 },
        { file: 'music.mp3', volume: 0.2 },
      ],
      30,
    )!
    expect(plan.inputs).toEqual(['voice.wav', 'music.mp3'])
    const [a, b, mix] = plan.filter.split(';')
    expect(a).toBe('[1:a]aresample=48000,adelay=1000:all=1,volume=1[a0]')
    expect(b).toBe('[2:a]aresample=48000,adelay=0:all=1,volume=0.2[a1]')
    expect(mix).toBe('[a0][a1]amix=inputs=2:duration=longest:normalize=0,apad,atrim=0:30[aout]')
  })

  it('rejects negative start and volume', () => {
    expect(() => planAudioMix([{ file: 'x', start: -1 }], 1)).toThrow()
    expect(() => planAudioMix([{ file: 'x', volume: -1 }], 1)).toThrow()
  })
})

describe('encodeArgs', () => {
  const base = { fps: 25, width: 640, height: 360, frames: 50, imageFormat: 'jpeg' as const, out: 'o.mp4' }

  it('pipes images in and writes H.264 yuv420p with faststart and exact duration', () => {
    const args = encodeArgs(base).join(' ')
    expect(args).toContain('-f image2pipe -framerate 25 -c:v mjpeg -i pipe:0')
    expect(args).toContain('-c:v libx264')
    expect(args).toContain('-pix_fmt yuv420p')
    expect(args).toContain('-movflags +faststart')
    expect(args).toContain('-t 2 ')
    expect(args).not.toContain('aac')
  })

  it('adds audio inputs, mapping and AAC', () => {
    const audio = planAudioMix([{ file: 'v.wav' }], 2)
    const args = encodeArgs({ ...base, audio })
    expect(args.slice(args.indexOf('pipe:0') + 1, args.indexOf('pipe:0') + 3)).toEqual(['-i', 'v.wav'])
    expect(args.join(' ')).toContain('-map 0:v -map [aout]')
    expect(args.join(' ')).toContain('-c:a aac')
  })

  it('pads odd sizes to even', () => {
    expect(encodeArgs({ ...base, width: 641 }).join(' ')).toContain('pad=ceil(iw/2)*2:ceil(ih/2)*2')
    expect(encodeArgs(base).join(' ')).not.toContain('pad=')
  })
})
