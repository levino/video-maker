/** High-level operations shared by CLI, MCP server and programmatic use. Inputs: video description (.json/.yaml) or HTML/URL. */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { VideoMakerError, type Issue } from './errors.js'
import { checkFrames, checkLayout, contactSheet, sheetFrames } from './inspect.js'
import { openComposition, render, type CompositionOptions, type EncodeSettings } from './render.js'
import { compile } from './spec/compile.js'
import { isSpecFile, readSpecFile, validateSpec } from './spec/load.js'
import { formatsOf, frameAt, openPlan, outputPath, prepare, renderSpec, type SpecRenderResult } from './spec/project.js'
import type { VideoSpec } from './spec/types.js'
import type { AudioTrack } from './audio.js'

export interface CommonOptions {
  /** Served directory (default: directory of the input). */
  root?: string
  ffmpegPath?: string
  verbose?: boolean
  /** For HTML input: metadata overrides. */
  html?: Pick<CompositionOptions, 'width' | 'height' | 'fps' | 'frames' | 'duration'>
}

const isSpec = (input: string) => isSpecFile(input) && !/^https?:/.test(input)

export interface SceneSummary {
  id: string
  start: number
  duration: number
  voice?: { start: number; end: number }
  captions: number
}

export interface ValidateResult {
  ok: boolean
  issues: Issue[]
  formats: { name: string; width: number; height: number; fps: number; frames: number; duration: number; scenes: SceneSummary[] }[]
}

/** Schema validation plus compilation of every format (files, times, durations, caption speed). No browser. */
export async function validate(input: string, options: CommonOptions & { formats?: string[] } = {}): Promise<ValidateResult> {
  if (!isSpec(input)) throw new VideoMakerError('usage', 'validate needs a video description (.json, .yaml, .yml).')
  const data = readSpecFile(input)
  const schemaIssues = validateSpec(data)
  if (schemaIssues.length) return { ok: false, issues: schemaIssues, formats: [] }
  const spec = data as VideoSpec
  const issues: Issue[] = []
  const formats: ValidateResult['formats'] = []
  for (const format of formatsOf(spec, options.formats)) {
    try {
      const { plan, issues: found } = await compile(spec, input, format, options)
      issues.push(...found.map((i) => ({ format, ...i })))
      formats.push({
        name: format,
        width: plan.width,
        height: plan.height,
        fps: plan.fps,
        frames: plan.frames,
        duration: Math.round((plan.frames / plan.fps) * 100) / 100,
        scenes: plan.scenes.map((s) => ({
          id: s.id,
          start: Math.round((s.start / plan.fps) * 100) / 100,
          duration: Math.round((s.frames / plan.fps) * 100) / 100,
          ...(s.voice ? { voice: { start: Math.round((s.voice.start / plan.fps) * 100) / 100, end: Math.round((s.voice.end / plan.fps) * 100) / 100 } } : {}),
          captions: plan.captions.cues.filter((c) => c.scene === s.id).length,
        })),
      })
    } catch (e) {
      const found = (e as { issues?: Issue[] }).issues
      if (!found) throw e
      issues.push(...found)
    }
  }
  return { ok: !issues.some((i) => i.severity === 'error'), issues: dedupe(issues), formats }
}

const dedupe = (issues: Issue[]) => {
  const seen = new Set<string>()
  return issues.filter((i) => {
    const key = `${i.code}|${i.path}|${i.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export interface CheckResult {
  ok: boolean
  errors: number
  warnings: number
  issues: Issue[]
  checkedFrames: Record<string, number>
}

/** validate + layout checks in the browser (overflow, safe area, overlap, contrast, caption lines). */
export async function check(input: string, options: CommonOptions & { formats?: string[]; layout?: boolean } = {}): Promise<CheckResult> {
  const validated = await validate(input, options)
  const issues = [...validated.issues]
  const checkedFrames: Record<string, number> = {}
  if (validated.ok && options.layout !== false) {
    for (const f of validated.formats) {
      const compiled = await prepare(input, f.name, options)
      const composition = await openPlan(compiled, options)
      try {
        const frames = checkFrames(compiled.plan)
        checkedFrames[f.name] = frames.length
        issues.push(...(await checkLayout(composition, compiled.plan, frames)))
      } finally {
        await composition.close()
      }
    }
  }
  const errors = issues.filter((i) => i.severity === 'error').length
  return { ok: errors === 0, errors, warnings: issues.length - errors, issues, checkedFrames }
}

async function open(input: string, format: string | undefined, options: CommonOptions) {
  if (isSpec(input)) {
    const spec = readSpecFile(input) as VideoSpec
    const name = format ?? Object.keys(spec.formats ?? {})[0]
    const compiled = await prepare(input, name, options)
    return { composition: await openPlan(compiled, options), compiled, format: name }
  }
  return { composition: await openComposition({ input, root: options.root, verbose: options.verbose, ...options.html }), compiled: undefined, format: undefined }
}

export interface StillResult {
  out: string
  format?: string
  frame: number
  time: number
  width: number
  height: number
}

/** One frame as PNG/JPEG. `time` accepts seconds or references like "scene:intro+2"; `frame` wins. */
export async function still(
  input: string,
  options: CommonOptions & { out: string; format?: string; time?: string | number; frame?: number; imageFormat?: 'png' | 'jpeg' },
): Promise<StillResult> {
  const { composition, compiled, format } = await open(input, options.format, options)
  try {
    const { meta } = composition
    const frame =
      options.frame ??
      (compiled ? frameAt(compiled, options.time ?? 0) : Math.min(meta.frames - 1, Math.round(Number(String(options.time ?? 0).replace(/s$/, '')) * meta.fps)))
    const page = await composition.openPage()
    const image = await page.capture(frame, options.imageFormat ?? 'png')
    await mkdir(dirname(resolve(options.out)), { recursive: true })
    await writeFile(options.out, image)
    return { out: options.out, format, frame, time: Math.round((frame / meta.fps) * 1000) / 1000, width: meta.width, height: meta.height }
  } finally {
    await composition.close()
  }
}

export interface SheetResult {
  out: string
  format?: string
  frames: { frame: number; label: string }[]
}

/** Contact sheet: a grid of frames in one PNG (evenly spaced or per scene). */
export async function sheet(
  input: string,
  options: CommonOptions & { out: string; format?: string; count?: number; perScene?: number; columns?: number; thumbWidth?: number },
): Promise<SheetResult> {
  const { composition, compiled, format } = await open(input, options.format, options)
  try {
    const frames = sheetFrames(composition.meta, { count: options.count, plan: compiled?.plan, perScene: options.perScene })
    const png = await contactSheet(composition, frames, options)
    await mkdir(dirname(resolve(options.out)), { recursive: true })
    await writeFile(options.out, png)
    return { out: options.out, format, frames }
  } finally {
    await composition.close()
  }
}

export interface RenderVideoOptions extends CommonOptions, EncodeSettings {
  out: string
  formats?: string[]
  cache?: string | false
  /** HTML input only: audio tracks. */
  audio?: AudioTrack[]
  onProgress?: (format: string, done: number, total: number) => void
}

export async function renderVideo(input: string, options: RenderVideoOptions): Promise<SpecRenderResult[]> {
  if (isSpec(input)) return renderSpec({ ...options, spec: input })
  const started = performance.now()
  const result = await render({ input, root: options.root, verbose: options.verbose, ...options.html, ...options, onProgress: (d, t) => options.onProgress?.('html', d, t) })
  const { width, height, fps } = result.meta
  return [
    {
      format: 'html',
      out: outputPath(options.out, 'html', false),
      width,
      height,
      fps,
      frames: result.frames,
      seconds: Math.round((performance.now() - started) / 100) / 10,
      scenesRendered: 0,
      scenesCached: 0,
    },
  ]
}
