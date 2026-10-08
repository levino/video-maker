import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright'
import { planAudioMix, type AudioTrack } from './audio.js'
import { encodeArgs, resolveFfmpeg, spawnFfmpeg } from './ffmpeg.js'
import { installRuntime, type Meta, type RuntimeOptions } from './runtime.js'
import { serve, type StaticServer } from './server.js'

export type { Meta }

export interface CompositionOptions {
  /** Path to an HTML file (query/hash allowed: `page.html?format=mobile`) or an http(s) URL. */
  input: string
  /** Directory served for local input (default: the HTML file's directory). */
  root?: string
  /** Override or supply metadata the page does not define. */
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
  /** Forward the page's console to the terminal. */
  verbose?: boolean
}

export interface RenderOptions extends CompositionOptions {
  out: string
  audio?: AudioTrack[]
  /** Number of browser pages rendering in parallel (default: 4). */
  parallel?: number
  /** Image format piped to ffmpeg (default jpeg; png is lossless but slower). */
  imageFormat?: 'jpeg' | 'png'
  /** JPEG quality 0–100 (default 95). */
  quality?: number
  /** x264 quality, lower is better (default 18). */
  crf?: number
  /** x264 preset (default medium). */
  preset?: string
  ffmpegPath?: string
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
  page: Page
  close(): Promise<void>
}

function locate(input: string, root?: string) {
  if (/^https?:\/\//.test(input)) return { url: input }
  const m = /^([^?#]*)(.*)$/.exec(input)!
  const file = resolve(m[1])
  if (!existsSync(file)) throw new Error(`Input not found: ${file}`)
  const base = resolve(root ?? dirname(file))
  const rel = relative(base, file)
  if (rel.startsWith('..')) throw new Error(`Input ${file} lies outside root ${base}`)
  return { base, path: '/' + rel.split(/[\\/]/).map(encodeURIComponent).join('/') + m[2] }
}

export async function openComposition(options: CompositionOptions): Promise<Composition> {
  const where = locate(options.input, options.root)
  let server: StaticServer | undefined
  let browser: Browser | undefined
  try {
    if (where.base) server = await serve({ root: where.base })
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
      if (options.verbose) page.on('console', (m) => console.error(`[page] ${m.text()}`))
      const response = await page.goto(url, { waitUntil: 'load' })
      if (response && !response.ok()) throw new Error(`${url}: HTTP ${response.status()}`)
      const meta = await page.evaluate(() => (window as any).__videoMakerDriver.ready() as Promise<Meta>).catch((e) => {
        throw new Error(`Composition not ready: ${e.message}${errors.length ? '\nPage errors:\n' + errors.join('\n') : ''}`)
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
        return {
          page: opened.page,
          async capture(frame, format = 'png', quality = 95) {
            if (!(frame >= 0 && frame < meta.frames)) throw new Error(`Frame ${frame} outside 0..${meta.frames - 1}`)
            await opened.page.evaluate((f) => (window as any).__videoMakerDriver.seek(f), frame)
            const shot = await cdp.send('Page.captureScreenshot', {
              format,
              ...(format === 'jpeg' ? { quality } : {}),
              clip: { x: 0, y: 0, width: meta.width, height: meta.height, scale: 1 },
              optimizeForSpeed: format === 'jpeg',
            })
            return Buffer.from(shot.data, 'base64')
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
    if (!(from >= 0 && to <= meta.frames && from < to)) throw new Error(`Invalid range ${from}..${to}`)
    const total = to - from
    const imageFormat = options.imageFormat ?? 'jpeg'
    const workers = Math.max(1, Math.min(options.parallel ?? 4, total))
    const audio = planAudioMix(options.audio ?? [], total / meta.fps)
    for (const file of audio?.inputs ?? []) if (!existsSync(file)) throw new Error(`Audio file not found: ${file}`)

    await mkdir(dirname(resolve(options.out)), { recursive: true })
    const ffmpeg = spawnFfmpeg(
      resolveFfmpeg(options.ffmpegPath),
      encodeArgs({ ...meta, frames: total, imageFormat, audio, out: options.out, crf: options.crf, preset: options.preset }),
    )

    // Workers take the next frame number from a shared counter; the writer passes frames to
    // ffmpeg strictly in order. A window bounds how far workers may run ahead of the writer.
    const ahead = workers * 4
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
    const progressWaiters: (() => void)[] = []
    const advanced = () => new Promise<void>((r) => progressWaiters.push(r))

    const worker = async () => {
      const page = await composition.openPage()
      try {
        while (!failed) {
          const i = next++
          if (i >= to) return
          while (i - written >= ahead && !failed) await advanced()
          slot(i).resolve(await page.capture(i, imageFormat, options.quality ?? 95))
        }
      } finally {
        await page.close()
      }
    }

    const writer = async () => {
      const stdin = ffmpeg.child.stdin!
      for (let i = from; i < to; i++) {
        const image = await Promise.race([slot(i).promise, ffmpeg.done.then(() => Promise.reject(new Error('ffmpeg ended early')))])
        slots.delete(i)
        if (!stdin.write(image)) await once(stdin, 'drain')
        written = i + 1
        progressWaiters.splice(0).forEach((r) => r())
        options.onProgress?.(written - from, total)
      }
      stdin.end()
    }

    const fail = (e: unknown) => {
      failed ??= e
      progressWaiters.splice(0).forEach((r) => r())
      ffmpeg.child.kill('SIGKILL')
      throw e
    }
    await Promise.all([...Array.from({ length: workers }, () => worker().catch(fail)), writer().catch(fail), ffmpeg.done.catch(fail)]).catch(
      () => {
        throw failed
      },
    )
    return { out: options.out, meta, frames: total, seconds: (performance.now() - started) / 1000 }
  } finally {
    await composition.close()
  }
}
