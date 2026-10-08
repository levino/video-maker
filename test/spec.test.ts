import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { envelopeExpression, planAudioMix } from '../src/audio.js'
import { splitSentences, timeCues } from '../src/kit/captions.js'
import { validate } from '../src/api.js'
import { compile } from '../src/spec/compile.js'
import { validateSpec } from '../src/spec/load.js'
import { resolveTime, type TimeContext } from '../src/spec/time.js'
import type { VideoSpec } from '../src/spec/types.js'
import { resolveFfmpeg } from '../src/ffmpeg.js'

let dir: string
const spec = (s: object) => {
  const file = join(dir, `spec-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(file, JSON.stringify(s))
  return file
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'video-maker-spec-'))
  // 2 s voice: tone, 0.5 s silence, tone
  const r = spawnSync(resolveFfmpeg(), [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=0.75', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=0.5',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=0.75', '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1', join(dir, 'voice.wav'),
  ])
  if (r.status !== 0) throw new Error(String(r.stderr))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('schema validation', () => {
  it('reports unknown properties with path and a suggestion', () => {
    const issues = validateSpec({ formats: { a: { width: 100, height: 100 } }, scenes: [{ id: 's', duration: 1, layers: [{ type: 'text', text: 'x', colour: 'red' }] }] })
    expect(issues).toContainEqual(expect.objectContaining({ code: 'unknown-property', path: '/scenes/0/layers/0/colour' }))
  })

  it('suggests the closest layer type and enum value', () => {
    const issues = validateSpec({
      formats: { a: { width: 100, height: 100 } },
      scenes: [{ id: 's', duration: 1, transition: 'fdae', layers: [{ type: 'txt', text: 'x' }] }],
    })
    expect(issues).toContainEqual(expect.objectContaining({ code: 'invalid-layer-type', path: '/scenes/0/layers/0/type', hint: 'Did you mean "text"?' }))
    expect(issues.find((i) => i.path === '/scenes/0/transition')?.hint).toContain('fade')
  })

  it('requires formats and scenes', () => {
    const issues = validateSpec({})
    expect(issues.map((i) => i.message).join(' ')).toMatch(/formats/)
    expect(issues.map((i) => i.message).join(' ')).toMatch(/scenes/)
  })
})

describe('time references', () => {
  const ctx: TimeContext = {
    fps: 30,
    end: 10,
    voice: { start: 0.5, end: 8 },
    sentences: [0.5, 3, 6],
    word: (t) => (t === 'Brücke' ? 4.2 : undefined),
    scene: (id) => (id === 'b' ? { start: 12, end: 20 } : undefined),
    sceneIds: ['a', 'b'],
  }
  const t = (ref: string | number) => {
    const issues: never[] = []
    return [resolveTime(ref, ctx, '/x', issues), issues] as const
  }

  it('reads numbers, units and anchors with offsets', () => {
    expect(t(2.5)[0]).toBe(2.5)
    expect(t('2.5s')[0]).toBe(2.5)
    expect(t('45f')[0]).toBe(1.5)
    expect(t('end-1')[0]).toBe(9)
    expect(t('voice+10f')[0]).toBeCloseTo(0.8333)
    expect(t('voiceEnd')[0]).toBe(8)
    expect(t('sentence:2+0.5')[0]).toBe(3.5)
    expect(t('word:Brücke')[0]).toBe(4.2)
    expect(t('word:"Brücke"-6f')[0]).toBeCloseTo(4.0)
    expect(t('scene:b.end')[0]).toBe(20)
  })

  it('explains bad references', () => {
    expect(t('sentence:4')[1][0]).toMatchObject({ code: 'invalid-time', path: '/x' })
    expect(t('word:Bank')[1][0].message).toContain('does not occur')
    expect(t('scene:c')[1][0].hint).toContain('a, b')
    expect(t('soon')[1][0].code).toBe('invalid-time')
  })
})

describe('caption timing', () => {
  it('splits sentences before capitals, digits and quotes', () => {
    expect(splitSentences('Eins. Zwei! „Drei?“ 4 Stück. 2,5 Mio. Euro am 3. Mai. Ende')).toEqual([
      'Eins.',
      'Zwei!',
      '„Drei?“',
      '4 Stück.',
      '2,5 Mio. Euro am 3. Mai.',
      'Ende',
    ])
  })

  it('gives each pause to the nearest boundary instead of an earlier one', () => {
    // estimates ≈ 1.5, 3.3, 5.2 s; the pause at 2.808 s belongs to the sentence end, not to the split inside the first sentence
    const pieces = ['Am Morgen fuhr der Zug los', 'und kam erst am Abend wieder an.', 'Unterwegs regnete es ganz kräftig.', 'Die Fahrgäste warteten geduldig in der Halle auf die Weiterfahrt.']
    const cues = timeCues(pieces, 8.375, [2.808, 4.748])
    expect(cues.map((c) => Math.round(c.end * 1000) / 1000)).toEqual([1.53, 2.808, 4.748, 8.375])
  })
})

describe('audio envelope', () => {
  it('builds a piecewise linear ffmpeg expression', () => {
    const e = envelopeExpression([
      [0, 0],
      [1, 0.5],
      [3, 0.5],
    ])
    expect(e).toBe('if(lt(t,0),0,if(lt(t,1),0+(0.5)*(t-0)/1,if(lt(t,3),0.5+(0)*(t-1)/2,0.5)))')
    const plan = planAudioMix([{ file: 'a.wav', start: 2, volume: [[2, 0], [3, 1]], duration: 4, fadeOut: 0.5 }], 10)!
    expect(plan.filter).toContain("volume='if(")
    expect(plan.filter).toContain('afade=t=out:st=3.5:d=0.5')
    expect(plan.filter).toContain('atrim=start=0:end=4')
  })
})

describe('compile', () => {
  const base = { fps: 10, formats: { wide: { width: 320, height: 180 }, tall: { width: 180, height: 320 } } }

  it('times scenes from the voice, overlaps transitions and resolves per-format overrides', async () => {
    const file = spec({
      ...base,
      defaults: { voice: { lead: 0.5, tail: 0.5 } },
      scenes: [
        { id: 'a', voice: 'voice.wav', script: 'Erster Satz. Zweiter Satz.', layers: [{ type: 'text', text: 'Hallo', at: 'sentence:2', formats: { tall: { x: 10 } } }] },
        { id: 'b', duration: 2, transition: { type: 'fade', duration: 0.5, overlap: true } },
      ],
    })
    const s = (await import('../src/spec/load.js')).loadSpec(file)
    const wide = await compile(s, file, 'wide')
    const tall = await compile(s, file, 'tall')
    expect(wide.issues).toEqual([])
    const [a, b] = wide.plan.scenes
    expect(a.frames).toBe(30) // 0.5 + 2.0 + 0.5 s
    expect(b.start).toBe(25) // overlaps by 0.5 s
    expect(wide.plan.frames).toBe(45)
    // the second sentence starts at the detected pause (≈ 1.0 s into the voice)
    expect(a.layers[0].at).toBeGreaterThanOrEqual(14)
    expect(a.layers[0].at).toBeLessThanOrEqual(16)
    expect(wide.plan.captions.cues.map((c) => c.text)).toEqual(['Erster Satz.', 'Zweiter Satz.'])
    expect(wide.audio[0]).toMatchObject({ start: 0.5 })
    expect(wide.audio[0].duration).toBeCloseTo(2, 1)
    expect(tall.plan.scenes[0].layers[0].x).toBe(10)
    expect(wide.plan.scenes[0].layers[0].x).toBe(0)
  })

  it('reports missing files with a suggestion, short scenes and unknown words', async () => {
    const file = spec({
      ...base,
      scenes: [
        { id: 'a', voice: 'voise.wav', duration: 1 },
        { id: 'b', voice: 'voice.wav', duration: 1, script: 'Hallo Welt.', layers: [{ type: 'text', text: 'x', at: 'word:Mond' }] },
      ],
    })
    const r = await validate(file)
    expect(r.ok).toBe(false)
    const byCode = (code: string) => r.issues.find((i) => i.code === code)
    expect(byCode('file-missing')).toMatchObject({ path: '/scenes/0/voice', hint: 'Did you mean "voice.wav"?' })
    expect(byCode('scene-shorter-than-voice')).toMatchObject({ path: '/scenes/1/duration' })
    expect(byCode('invalid-time')).toMatchObject({ path: '/scenes/1/layers/0/at' })
  })

  it('validate returns scene timings per format', async () => {
    const file = spec({ ...base, scenes: [{ id: 'only', duration: 1.5 }] })
    const r = await validate(file)
    expect(r.ok).toBe(true)
    expect(r.formats.map((f) => [f.name, f.frames, f.scenes[0].duration])).toEqual([
      ['wide', 15, 1.5],
      ['tall', 15, 1.5],
    ])
  })
})

export type { VideoSpec }
