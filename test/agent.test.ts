// End-to-end tests of the declarative path, the CLI contract and the MCP server (built package).
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { probe, renderVideo, resolveFfmpeg } from '../dist/index.js'

const cli = join(import.meta.dirname, '../dist/cli.js')
const mcp = join(import.meta.dirname, '../dist/mcp.js')
const ffmpeg = resolveFfmpeg()
let dir: string
let good: string
let bad: string

const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [cli, ...args, '--json'], { encoding: 'utf8' })
  return { code: r.status, json: JSON.parse(r.stdout || '{}'), stderr: r.stderr }
}
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** RGB of pixel (x, y) in an image file (frame 0). */
function pixel(file: string, x: number, y: number, width: number) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 26 })
  const i = (y * width + x) * 3
  return [r.stdout[i], r.stdout[i + 1], r.stdout[i + 2]]
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'video-maker-agent-'))
  const r = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', join(dir, 'stimme.wav')])
  if (r.status !== 0) throw new Error(String(r.stderr))
  good = join(dir, 'video.yaml')
  writeFileSync(
    good,
    `fps: 10
formats:
  wide: { width: 320, height: 180 }
  tall: { width: 180, height: 320 }
theme:
  colors: { red: "#ff0000", blue: "#0000ff" }
  text: { size: 20, color: "#ffffff" }
scenes:
  - id: a
    background: red
    voice: { file: stimme.wav, lead: 0.2, tail: 0.3 }
    script: Ein kurzer Satz.
    layers:
      - { type: text, text: "A", place: center, enter: pop }
  - id: b
    duration: 1
    background: blue
    transition: { type: fade, duration: 0.3, overlap: true }
    captions: false
    layers:
      - { type: counter, to: 100, place: center, start: 0, end: 0.5 }
`,
  )
  bad = join(dir, 'schlecht.yaml')
  writeFileSync(
    bad,
    `formats: { wide: { width: 320, height: 180 } }
scenes:
  - id: a
    duration: 1
    background: "#ffffff"
    layers:
      - { type: text, text: "zu breit und viel zu groß", x: 200, y: 20, style: { size: 60, color: "#000000" } }
      - { type: text, text: "kaum lesbar", x: 20, y: 120, style: { size: 16, color: "#eeeeee" } }
`,
  )
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('video description', () => {
  it('renders every format with exact frame count and AAC; a second run comes from the cache with identical bytes', async () => {
    const out = join(dir, 'out/film.mp4')
    const first = await renderVideo(good, { out, parallel: 2 })
    // scene a: 0.2 + 1.2 + 0.3 s = 17 frames; scene b: 10 frames, starts 3 frames early (overlap)
    expect(first.map((r) => [r.format, r.frames, r.scenesRendered])).toEqual([
      ['wide', 24, 2],
      ['tall', 24, 2],
    ])
    const wide = await probe(join(dir, 'out/film-wide.mp4'))
    expect(wide).toMatchObject({ width: 320, height: 180, frames: 24, videoCodec: 'h264', pixelFormat: 'yuv420p', audioCodec: 'aac' })
    expect(wide.duration).toBeCloseTo(2.4, 1)
    expect((await probe(join(dir, 'out/film-tall.mp4'))).height).toBe(320)

    const hash = sha(join(dir, 'out/film-wide.mp4'))
    const second = await renderVideo(good, { out, formats: ['wide'] })
    expect(second[0]).toMatchObject({ scenesRendered: 0, scenesCached: 2 })
    expect(sha(join(dir, 'out/film-wide.mp4'))).toBe(hash)

    // without cache, in one pass: same frames, same bytes
    const direct = join(dir, 'out/direkt.mp4')
    await renderVideo(good, { out: direct, formats: ['wide'], cache: false })
    expect((await probe(direct)).frames).toBe(24)
  }, 180_000)

  it('still accepts time references', () => {
    const png = join(dir, 'b.png')
    const r = run('still', good, '--time', 'scene:b+0.5', '--out', png)
    expect(r.code).toBe(0)
    expect(r.json).toMatchObject({ ok: true, format: 'wide', frame: 19 })
    expect(pixel(png, 5, 5, 320)).toEqual([0, 0, 255])
  }, 60_000)

  it('contact sheet writes one PNG with labelled frames', () => {
    const png = join(dir, 'bogen.png')
    const r = run('sheet', good, '--per-scene', '2', '--out', png, '--format', 'tall')
    expect(r.code).toBe(0)
    expect(r.json.frames).toHaveLength(4)
    expect(r.json.frames[0].label).toContain('· a')
    expect(readFileSync(png).subarray(1, 4).toString()).toBe('PNG')
  }, 60_000)

  it('check finds layout problems and exits with 5', () => {
    const r = run('check', bad)
    expect(r.code).toBe(5)
    const codes = r.json.issues.map((i: { code: string; path: string }) => `${i.code} ${i.path}`)
    expect(codes).toContain('text-outside-frame /scenes/0/layers/0')
    expect(codes).toContain('low-contrast /scenes/0/layers/1')
    expect(r.json.issues[0].hint).toBeTruthy()
    expect(run('check', good).json.errors).toBe(0)
  }, 60_000)
})

describe('CLI contract', () => {
  it('exit codes and JSON errors', () => {
    const invalid = join(dir, 'ungueltig.json')
    writeFileSync(invalid, JSON.stringify({ formats: { a: { width: 10, height: 10 } }, scenes: [{ id: 'x', duration: 1, layers: [{ type: 'text', txt: 'a' }] }] }))
    const r = run('validate', invalid)
    expect(r.code).toBe(3)
    expect(r.json.ok).toBe(false)
    expect(r.json.issues).toContainEqual(expect.objectContaining({ path: '/scenes/0/layers/0/txt', hint: 'Did you mean "text"?' }))

    const missing = join(dir, 'fehlt.json')
    writeFileSync(missing, JSON.stringify({ formats: { a: { width: 10, height: 10 } }, scenes: [{ id: 'x', voice: 'nichts.wav' }] }))
    expect(run('validate', missing).code).toBe(4)
    expect(run('render', good).code).toBe(2)
    expect(run('frobnicate', good).code).toBe(2)
    expect(run('validate', good).json.formats[0].scenes.map((s: { id: string }) => s.id)).toEqual(['a', 'b'])
  }, 60_000)

  it('prints schema and docs', () => {
    const schema = JSON.parse(spawnSync(process.execPath, [cli, 'schema'], { encoding: 'utf8' }).stdout)
    expect(schema.required).toEqual(['formats', 'scenes'])
    expect(spawnSync(process.execPath, [cli, 'docs'], { encoding: 'utf8' }).stdout).toContain('## Zeiten')
  })
})

describe('MCP server', () => {
  it('lists tools and validates over stdio', async () => {
    const child = spawn(process.execPath, [mcp], { stdio: ['pipe', 'pipe', 'inherit'] })
    const replies: any[] = []
    let buffer = ''
    child.stdout.on('data', (d) => {
      buffer += d
      let n
      while ((n = buffer.indexOf('\n')) >= 0) {
        replies.push(JSON.parse(buffer.slice(0, n)))
        buffer = buffer.slice(n + 1)
      }
    })
    const send = (msg: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
    const reply = async (id: number) => {
      for (let i = 0; i < 400 && !replies.some((r) => r.id === id); i++) await new Promise((r) => setTimeout(r, 25))
      return replies.find((r) => r.id === id)
    }
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    expect((await reply(1)).result.serverInfo.name).toBe('video-maker')
    send({ method: 'notifications/initialized' })
    send({ id: 2, method: 'tools/list' })
    expect((await reply(2)).result.tools.map((t: { name: string }) => t.name)).toEqual(['validate', 'check', 'still', 'contact_sheet', 'render', 'schema', 'docs'])
    send({ id: 3, method: 'tools/call', params: { name: 'validate', arguments: { input: good } } })
    const result = JSON.parse((await reply(3)).result.content[0].text)
    expect(result.ok).toBe(true)
    child.kill()
  }, 30_000)
})
