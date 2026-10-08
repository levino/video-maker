import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { planAudioMix } from '../audio.js'
import { VideoMakerError, type Issue } from '../errors.js'
import { encodeArgs, muxArgs, resolveFfmpeg, spawnFfmpeg } from '../ffmpeg.js'
import { playerPage, playerPath } from '../player/page.js'
import { encodeFrames, openComposition, type Composition, type EncodeSettings, type FramePage } from '../render.js'
import { compile, type Compiled } from './compile.js'
import { loadSpec } from './load.js'
import { resolveTime } from './time.js'
import type { TimeRef, VideoSpec } from './types.js'

export const version = '0.1.0'

export interface ProjectOptions {
  root?: string
  ffmpegPath?: string
  verbose?: boolean
}

export function formatsOf(spec: VideoSpec, requested?: string | string[]): string[] {
  const all = Object.keys(spec.formats)
  if (!requested || (Array.isArray(requested) && requested.length === 0)) return all
  return Array.isArray(requested) ? requested : [requested]
}

/** Load, validate and compile; throws with all issues when there are errors. */
export async function prepare(specFile: string, format: string, options: ProjectOptions = {}): Promise<Compiled & { spec: VideoSpec }> {
  const spec = loadSpec(specFile)
  let compiled: Compiled
  try {
    compiled = await compile(spec, specFile, format, options)
  } catch (e) {
    const issues = (e as { issues?: Issue[] }).issues
    if (issues) throw new VideoMakerError('usage', (e as Error).message, issues)
    throw e
  }
  const errors = compiled.issues.filter((i) => i.severity === 'error')
  if (errors.length) {
    const kind = errors.every((i) => i.code === 'file-missing') ? 'missingFile' : 'invalidSpec'
    throw new VideoMakerError(kind, `${errors.length} error(s) in ${specFile} (format ${format})`, compiled.issues.map((i) => ({ format, ...i })))
  }
  return { ...compiled, spec }
}

export function openPlan(compiled: Compiled, options: ProjectOptions = {}): Promise<Composition> {
  return openComposition({
    input: playerPath,
    root: compiled.root,
    routes: { [playerPath]: { type: 'text/html; charset=utf-8', body: playerPage(compiled.plan) } },
    verbose: options.verbose,
  })
}

/** Frame number for a time reference in the whole video ("12.5", "scene:intro+2", "end-1"). */
export function frameAt(compiled: Compiled, ref: TimeRef): number {
  const { plan } = compiled
  const issues: Issue[] = []
  const scenes = plan.scenes
  const seconds = resolveTime(
    ref,
    {
      fps: plan.fps,
      end: plan.frames / plan.fps,
      sceneIds: scenes.map((s) => s.id),
      scene: (id) => {
        const s = scenes.find((x) => x.id === id)
        return s && { start: s.start / plan.fps, end: (s.start + s.frames) / plan.fps }
      },
    },
    '(time)',
    issues,
  )
  if (issues.length) throw new VideoMakerError('usage', issues[0].message, issues)
  return Math.min(plan.frames - 1, Math.max(0, Math.round(seconds * plan.fps)))
}

// --- rendering with per-scene cache ----------------------------------------------------------

const fileHashes = new Map<string, string>()
function hashFile(file: string): string {
  const { mtimeMs, size } = statSync(file)
  const key = `${file}:${mtimeMs}:${size}`
  let h = fileHashes.get(key)
  if (!h) {
    h = createHash('sha256').update(readFileSync(file)).digest('hex')
    fileHashes.set(key, h)
  }
  return h
}

export interface SpecRenderOptions extends ProjectOptions, EncodeSettings {
  spec: string
  /** Formats to render (default: all). */
  formats?: string[]
  /** Output file; with several formats "{format}" is replaced or "-<format>" appended. */
  out: string
  /** Segment cache directory, or false to render in one pass (default: .video-maker-cache next to the description). */
  cache?: string | false
  onProgress?: (format: string, done: number, total: number) => void
}

export interface SpecRenderResult {
  format: string
  out: string
  width: number
  height: number
  fps: number
  frames: number
  seconds: number
  scenesRendered: number
  scenesCached: number
}

export function outputPath(out: string, format: string, several: boolean): string {
  if (out.includes('{format}')) return out.replaceAll('{format}', format)
  if (!several) return out
  const ext = extname(out)
  return `${out.slice(0, out.length - ext.length)}-${format}${ext}`
}

export async function renderSpec(options: SpecRenderOptions): Promise<SpecRenderResult[]> {
  const spec = loadSpec(options.spec)
  const formats = formatsOf(spec, options.formats)
  const results: SpecRenderResult[] = []
  for (const format of formats) {
    const started = performance.now()
    const compiled = await prepare(options.spec, format, options)
    const { plan } = compiled
    const out = outputPath(options.out, format, formats.length > 1)
    await mkdir(dirname(resolve(out)), { recursive: true })
    const audio = planAudioMix(compiled.audio, plan.frames / plan.fps)
    // the browser starts only when a segment actually needs rendering
    let composition: Composition | undefined
    let opened: Promise<FramePage[]> | undefined
    const pagesNeeded = () =>
      (opened ??= openPlan(compiled, options).then((c) => {
        composition = c
        return Promise.all(Array.from({ length: Math.max(1, options.parallel ?? 4) }, () => c.openPage()))
      }))
    let rendered = 0
    let cached = 0
    try {
      const enc = { imageFormat: options.imageFormat ?? 'jpeg', crf: options.crf, preset: options.preset }
      let done = 0
      const progress = (n: number) => options.onProgress?.(format, (done += n), plan.frames)
      if (options.cache === false) {
        const args = encodeArgs({ ...plan, frames: plan.frames, imageFormat: enc.imageFormat, audio, out, crf: enc.crf, preset: enc.preset })
        await encodeFrames(await pagesNeeded(), 0, plan.frames, args, { ...options, onProgress: (d, t) => options.onProgress?.(format, d, t) })
        rendered = plan.scenes.length
      } else {
        const cacheDir = resolve(options.cache ?? join(dirname(resolve(options.spec)), '.video-maker-cache'))
        await mkdir(cacheDir, { recursive: true })
        const shared = {
          version,
          size: [plan.width, plan.height, plan.fps],
          enc: { ...enc, quality: options.quality ?? 95 },
          fonts: plan.fonts,
          overlays: plan.overlays,
          globalFiles: compiled.files.global.map(hashFile),
        }
        const segments: string[] = []
        for (const [i, scene] of plan.scenes.entries()) {
          const from = scene.start
          const to = i + 1 < plan.scenes.length ? plan.scenes[i + 1].start : plan.frames
          if (to <= from) continue
          const involved = plan.scenes.flatMap((s, j) => (s.start < to && s.start + s.frames > from ? [{ s, files: compiled.files.scenes[j].map(hashFile) }] : []))
          const cues = plan.captions.cues.filter((c) => c.start < to && c.end > from)
          const key = createHash('sha256').update(JSON.stringify({ shared, from, to, captions: { ...plan.captions, cues }, involved })).digest('hex').slice(0, 32)
          const segment = join(cacheDir, `${key}.mp4`)
          if (existsSync(segment)) {
            cached++
            progress(to - from)
          } else {
            const tmp = `${segment}.${process.pid}.tmp.mp4`
            const args = encodeArgs({ ...plan, frames: to - from, imageFormat: enc.imageFormat, out: tmp, crf: enc.crf, preset: enc.preset })
            let last = 0
            await encodeFrames(await pagesNeeded(), from, to, args, {
              ...options,
              onProgress: (d) => {
                progress(d - last)
                last = d
              },
            })
            await rename(tmp, segment)
            rendered++
          }
          segments.push(segment)
        }
        const list = join(cacheDir, `${createHash('sha256').update(segments.join('\n')).digest('hex').slice(0, 16)}.txt`)
        await writeFile(list, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n') + '\n')
        const mux = spawnFfmpeg(resolveFfmpeg(options.ffmpegPath), muxArgs({ list, fps: plan.fps, frames: plan.frames, audio, out }))
        mux.child.stdin?.end()
        await mux.done.catch((e) => {
          throw new VideoMakerError('renderFailed', e.message)
        })
        await rm(list, { force: true })
      }
    } finally {
      if (opened) await opened.catch(() => undefined)
      await composition?.close()
    }
    results.push({
      format,
      out,
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      frames: plan.frames,
      seconds: Math.round((performance.now() - started) / 100) / 10,
      scenesRendered: rendered,
      scenesCached: cached,
    })
  }
  return results
}
