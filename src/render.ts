import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright'
import { planAudioMix, type AudioTrack } from './audio.js'
import { VideoMakerError } from './errors.js'
import { encodeArgs, resolveFfmpeg, spawnFfmpeg } from './ffmpeg.js'
import { installRuntime, type Meta, type RuntimeOptions } from './runtime.js'
import { serve, type ServeOptions, type StaticServer } from './server.js'

export type { Meta }

export interface CompositionOptions {
  /** Path to an HTML file (query/hash allowed: `page.html?format=mobile`) or an http(s) URL. */
  input: string
  /** Directory served for local input (default: the HTML file's directory). */
  root?: string
  /** Generated pages; `input` may name one of them (used for video descriptions). */
  routes?: ServeOptions['routes']
  /** Override or supply metadata. */
  width?: number
  height?: number
  fps?: number
  frames?: number
  /** Duration in seconds (alternative to frames). */
  duration?: number
  /** Wall-clock time of frame 0 seen by Date (ms since 1970). Default 2026-01-01T00:00:00Z. */
  epoch?: number
  /** Seed for Math.random. */
  seed?: number
  /** Extra Chromium flags, appended to the defaults. */
  chromiumArgs?: string[]
  /** Forward the page's console to stderr. */
  verbose?: boolean
}

export interface EncodeSettings {
  /** Image format piped to ffmpeg (default jpeg; png is lossless but slower). */
  imageFormat?: 'jpeg' | 'png'
  /** JPEG quality 0–100 (default 95). */
  quality?: number
  /** x264 quality, lower is better (default 18). */
  crf?: number
  /** x264 preset (default medium). */
  preset?: string
  ffmpegPath?: string
  /** Number of pages rendering in parallel (default 4). */
  parallel?: number
}

export interface RenderOptions extends CompositionOptions, EncodeSettings {
  out: string
  audio?: AudioTrack[]
  /** Render only frames [from, to). */
  range?: [number, number]
  onProgress?: (done: number, total: number) => void
}

export interface StillOptions extends CompositionOptions {
  frame: number
  /** Written when given. */
  out?: string
  format?: 'png' | 'jpeg'
  quality?: number
}

const defaultArgs = [
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--mute-audio',
  '--font-render-hinting=none',
]

/** An opened composition: one browser, any number of pages that can capture frames. */
export interface Composition {
  meta: Meta
  url: string
  /** A page at the composition's size, ready to capture. */
  openPage(): Promise<FramePage>
  close(): Promise<void>
}

export interface FramePage {
  capture(frame: number, format?: 'png' | 'jpeg', quality?: number): Promise<Buffer>
  /** Seek without capturing. */
  seek(frame: number): Promise<void>
  /** Screenshot of the current state. */
  shot(format?: 'png' | 'jpeg', quality?: number): Promise<Buffer>
  page: Page
  close(): Promise<void>
}

function locate(options: CompositionOptions) {
  const { input, root, routes } = options
  if (/^https?:\/\//.test(input)) return { url: input }
  if (routes && routes[input.replace(/[?#].*$/, '')]) return { base: resolve(root ?? '.'), path: input }
  const m = /^([^?#]*)(.*)$/.exec(input)!
  const file = resolve(m[1])
  if (!existsSync(file)) throw new VideoMakerError('missingFile', `Input not found: ${file}`, [{ code: 'file-missing', severity: 'error', message: `Input not found: ${file}`, hint: 'Check the path.' }])
  const base = resolve(root ?? dirname(file))
  const rel = relative(base, file)
  if (rel.startsWith('..')) throw new VideoMakerError('usage', `Input ${file} lies outside root ${base}`)
  return { base, path: '/' + rel.split(/[\\/]/).map(encodeURIComponent).join('/') + m[2] }
}

export async function openComposition(options: CompositionOptions): Promise<Composition> {
  const where = locate(options)
  let server: StaticServer | undefined
  let browser: Browser | undefined
  try {
    if (where.base) server = await serve({ root: where.base, routes: options.routes })
    const url = where.url ?? server!.url + where.path
    browser = await chromium.launch({
      args: [...defaultArgs, ...(options.chromiumArgs ?? [])],
      executablePath: process.env.VIDEO_MAKER_CHROMIUM || undefined,
    })
    const runtime: RuntimeOptions = {
      epoch: options.epoch ?? Date.UTC(2026, 0, 1),
      seed: options.seed ?? 1,
      defaults: { width: options.width, height: options.height, fps: options.fps, frames: options.frames, duration: options.duration },
    }
    const b = browser
    const newPage = async (viewport: { width: number; height: number }) => {
      const context: BrowserContext = await b.newContext({ viewport, deviceScaleFactor: 1 })
      await context.addInitScript(installRuntime, runtime)
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      page.on('console', (m) => {
        if (options.verbose) console.error(`[page] ${m.text()}`)
        if (m.type() === 'error') errors.push(m.text())
      })
      const response = await page.goto(url, { waitUntil: 'load' })
      if (response && !response.ok()) throw new VideoMakerError('renderFailed', `${url}: HTTP ${response.status()}`)
      const meta = await page.evaluate(() => (window as any).__videoMakerDriver.ready() as Promise<Meta>).catch((e) => {
        throw new VideoMakerError('renderFailed', `Composition not ready: ${e.message}${errors.length ? '\nPage errors:\n' + errors.join('\n') : ''}`)
      })
      return { context, page, meta }
    }

    // Read metadata once with explicit size (or a default), then open pages at the real size.
    const probeSize = { width: options.width ?? 1280, height: options.height ?? 720 }
    const first = await newPage(probeSize)
    const meta = first.meta
    let spare: typeof first | undefined = first
    if (meta.width !== probeSize.width || meta.height !== probeSize.height) {
      await first.context.close()
      spare = undefined
    }

    return {
      meta,
      url,
      async openPage() {
        const opened = spare ?? (await newPage({ width: meta.width, height: meta.height }))
        spare = undefined
        const cdp: CDPSession = await opened.context.newCDPSession(opened.page)
        const shot = async (format: 'png' | 'jpeg' = 'png', quality = 95) => {
          const result = await cdp.send('Page.captureScreenshot', {
            format,
            ...(format === 'jpeg' ? { quality } : {}),
            clip: { x: 0, y: 0, width: meta.width, height: meta.height, scale: 1 },
            optimizeForSpeed: format === 'jpeg',
          })
          return Buffer.from(result.data, 'base64')
        }
        const seek = async (frame: number) => {
          if (!(frame >= 0 && frame < meta.frames)) throw new VideoMakerError('usage', `Frame ${frame} outside 0..${meta.frames - 1}`)
          await opened.page.evaluate((f) => (window as any).__videoMakerDriver.seek(f), frame)
        }
        return {
          page: opened.page,
          seek,
          shot,
          async capture(frame, format = 'png', quality = 95) {
            await seek(frame)
            return shot(format, quality)
          },
          close: () => opened.context.close(),
        }
      },
      async close() {
        await b.close()
        await server?.close()
      },
    }
  } catch (e) {
    await browser?.close()
    await server?.close()
    throw e
  }
}

export async function renderStill(options: StillOptions): Promise<Buffer> {
  const composition = await openComposition(options)
  try {
    const page = await composition.openPage()
    const image = await page.capture(options.frame, options.format ?? 'png', options.quality)
    if (options.out) {
      await mkdir(dirname(resolve(options.out)), { recursive: true })
      await writeFile(options.out, image)
    }
    return image
  } finally {
    await composition.close()
  }
}

/**
 * Capture frames [from, to) with all pages in parallel and pipe them in order into an ffmpeg
 * process started with `args`. Workers take the next frame from a shared counter; a window bounds
 * how far they may run ahead of the writer.
 */
export async function encodeFrames(
  pages: FramePage[],
  from: number,
  to: number,
  args: string[],
  settings: EncodeSettings & { onProgress?: (done: number, total: number) => void },
): Promise<void> {
  const total = to - from
  const imageFormat = settings.imageFormat ?? 'jpeg'
  const ffmpeg = spawnFfmpeg(resolveFfmpeg(settings.ffmpegPath), args)
  const workers = pages.slice(0, Math.max(1, Math.min(pages.length, total)))
  const ahead = workers.length * 4
  const slots = new Map<number, { promise: Promise<Buffer>; resolve: (b: Buffer) => void }>()
  const slot = (i: number) => {
    let s = slots.get(i)
    if (!s) {
      let resolve!: (b: Buffer) => void
      const promise = new Promise<Buffer>((r) => (resolve = r))
      s = { promise, resolve }
      slots.set(i, s)
    }
    return s
  }
  let next = from
  let written = from
  let failed: unknown
  const waiters: (() => void)[] = []
  const advanced = () => new Promise<void>((r) => waiters.push(r))

  const worker = async (page: FramePage) => {
    while (!failed) {
      const i = next++
      if (i >= to) return
      while (i - written >= ahead && !failed) await advanced()
      slot(i).resolve(await page.capture(i, imageFormat, settings.quality ?? 95))
    }
  }
  const writer = async () => {
    const stdin = ffmpeg.child.stdin!
    const early = ffmpeg.done.then(() => Promise.reject(new Error('ffmpeg ended early')))
    early.catch(() => {})
    for (let i = from; i < to; i++) {
      const image = await Promise.race([slot(i).promise, early])
      slots.delete(i)
      if (!stdin.write(image)) await once(stdin, 'drain')
      written = i + 1
      waiters.splice(0).forEach((r) => r())
      settings.onProgress?.(written - from, total)
    }
    stdin.end()
  }
  const fail = (e: unknown) => {
    failed ??= e
    waiters.splice(0).forEach((r) => r())
    ffmpeg.child.kill('SIGKILL')
    throw e
  }
  await Promise.all([...workers.map((p) => worker(p).catch(fail)), writer().catch(fail), ffmpeg.done.catch(fail)]).catch(() => {
    throw failed instanceof VideoMakerError ? failed : new VideoMakerError('renderFailed', failed instanceof Error ? failed.message : String(failed))
  })
}

export interface RenderResult {
  out: string
  meta: Meta
  frames: number
  seconds: number
}

export async function render(options: RenderOptions): Promise<RenderResult> {
  const started = performance.now()
  const composition = await openComposition(options)
  try {
    const { meta } = composition
    const from = options.range?.[0] ?? 0
    const to = Math.min(options.range?.[1] ?? meta.frames, meta.frames)
    if (!(from >= 0 && from < to)) throw new VideoMakerError('usage', `Invalid range ${from}..${to}`)
    const total = to - from
    const audio = planAudioMix(options.audio ?? [], total / meta.fps)
    for (const file of audio?.inputs ?? []) if (!existsSync(file)) throw new VideoMakerError('missingFile', `Audio file not found: ${file}`)
    await mkdir(dirname(resolve(options.out)), { recursive: true })
    const pages = await Promise.all(Array.from({ length: Math.max(1, Math.min(options.parallel ?? 4, total)) }, () => composition.openPage()))
    const args = encodeArgs({ ...meta, frames: total, imageFormat: options.imageFormat ?? 'jpeg', audio, out: options.out, crf: options.crf, preset: options.preset })
    await encodeFrames(pages, from, to, args, options)
    return { out: options.out, meta, frames: total, seconds: (performance.now() - started) / 1000 }
  } finally {
    await composition.close()
  }
}
