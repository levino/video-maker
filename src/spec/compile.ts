import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import QRCode from 'qrcode'
import type { AudioTrack } from '../audio.js'
import { closest, type Issue } from '../errors.js'
import { parseSubtitles, splitSentences, splitText, timeCues, type Pause } from '../kit/captions.js'
import { validateLayer } from './load.js'
import type { Css, Plan, PlanCue, PlanKey, PlanLayer, PlanMotion, PlanScene } from './plan.js'
import { resolveTime, type TimeContext } from './time.js'
import type { AudioSpec, CaptionStyle, Keyframe, Layer, Motion, MotionType, Placement, Scene, TextStyle, TimeRef, Transition, VideoSpec, Voice } from './types.js'
import { analyzeAudio } from './voice.js'

export interface CompileOptions {
  /** Directory served to the browser; asset paths must lie inside (default: the description's directory). */
  root?: string
  ffmpegPath?: string
}

export interface Compiled {
  plan: Plan
  audio: AudioTrack[]
  issues: Issue[]
  /** Absolute paths of files each scene depends on (index = plan.scenes index), plus global ones. */
  files: { scenes: string[][]; global: string[] }
  root: string
}

const anchors: Record<Placement, [number, number]> = {
  'top-left': [0, 0],
  top: [0.5, 0],
  'top-right': [1, 0],
  left: [0, 0.5],
  center: [0.5, 0.5],
  right: [1, 0.5],
  'bottom-left': [0, 1],
  bottom: [0.5, 1],
  'bottom-right': [1, 1],
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** QR code as SVG markup: one path for all dark modules on a (rounded) background. */
export function qrSvg(data: string, o: { color: string; background: string; margin: number; level: 'L' | 'M' | 'Q' | 'H'; radius: number }): string {
  const code = QRCode.create(data, { errorCorrectionLevel: o.level })
  const n = code.modules.size
  const total = n + 2 * o.margin
  let d = ''
  for (let row = 0; row < n; row++)
    for (let col = 0; col < n; col++) if (code.modules.get(row, col)) d += `M${col + o.margin} ${row + o.margin}h1v1h-1z`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" rx="${(o.radius * total) / 100}" fill="${o.background}"/><path d="${d}" fill="${o.color}"/></svg>`
}

/** Deep merge: objects merge, everything else (arrays too) is replaced. */
export function merge<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) return (override === undefined ? base : override) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(override)) out[k] = merge(out[k], v)
  return out as T
}

export async function compile(spec: VideoSpec, specFile: string, format: string, options: CompileOptions = {}): Promise<Compiled> {
  const issues: Issue[] = []
  const base = dirname(resolve(specFile))
  const root = resolve(options.root ?? base)
  const fmt = spec.formats[format]
  if (!fmt) {
    const names = Object.keys(spec.formats)
    const guess = closest(format, names)
    issues.push({ code: 'unknown-format', severity: 'error', path: '/formats', message: `Unknown format "${format}".`, hint: guess ? `Did you mean "${guess}"?` : `Known formats: ${names.join(', ')}.` })
    throw Object.assign(new Error(`Unknown format "${format}"`), { issues })
  }
  const W = fmt.width
  const H = fmt.height
  const fps = spec.fps ?? 30
  const theme = spec.theme ?? {}
  const safeFraction = theme.safeArea ?? 0.05
  const safe = { x: Math.round(W * safeFraction), y: Math.round(H * safeFraction) }
  const toFrames = (s: number) => Math.round(s * fps)
  /** A duration: seconds, or "12f", "0.4s", "250ms". */
  const spanSeconds = (v: number | string | undefined, fallback: number) => {
    if (v === undefined) return fallback
    if (typeof v === 'number') return v
    const m = /^(\d+(?:\.\d+)?)\s*(s|f|ms)?$/.exec(v.trim())!
    return m[2] === 'f' ? Number(m[1]) / fps : m[2] === 'ms' ? Number(m[1]) / 1000 : Number(m[1])
  }
  const color = (c: string | undefined) => (c === undefined ? undefined : (theme.colors?.[c] ?? c))
  const globalFiles = new Set<string>()
  let sceneFiles = new Set<string>()

  // --- files ---------------------------------------------------------------------------------
  const file = (rel: string, path: string, global = false): { abs: string; url: string } | undefined => {
    const abs = isAbsolute(rel) ? rel : resolve(base, rel)
    if (!existsSync(abs)) {
      let hint = 'Check the path (relative to the description file).'
      try {
        const guess = closest(basename(abs), readdirSync(dirname(abs)))
        if (guess) hint = `Did you mean "${relative(base, resolve(dirname(abs), guess))}"?`
      } catch {
        hint = `Directory ${relative(base, dirname(abs)) || '.'} does not exist.`
      }
      issues.push({ code: 'file-missing', severity: 'error', path, message: `File not found: ${rel}`, hint })
      return undefined
    }
    const r = relative(root, abs)
    if (r.startsWith('..') || isAbsolute(r)) {
      issues.push({ code: 'outside-root', severity: 'error', path, message: `${rel} lies outside the served directory ${root}.`, hint: 'Move the file next to the description or pass --root with a common parent directory.' })
      return undefined
    }
    ;(global ? globalFiles : sceneFiles).add(abs)
    return { abs, url: '/' + r.split(sep).map(encodeURIComponent).join('/') }
  }

  // --- styles --------------------------------------------------------------------------------
  const families = new Set(Object.entries(theme.fonts ?? {}).map(([key, f]) => f.family ?? key))
  const fontFamily = (name: string) => {
    const family = theme.fonts?.[name]?.family ?? name
    return families.has(family) ? `"${family}"` : name
  }
  const resolveStyle = (style: string | TextStyle | undefined, path: string, seen: string[] = []): TextStyle => {
    if (style === undefined) return {}
    const named = (name: string): TextStyle => {
      const found = theme.styles?.[name]
      if (!found) {
        const guess = closest(name, Object.keys(theme.styles ?? {}))
        issues.push({ code: 'unknown-style', severity: 'error', path, message: `Unknown style "${name}".`, hint: guess ? `Did you mean "${guess}"?` : 'Define it in theme.styles.' })
        return {}
      }
      if (seen.includes(name)) return {}
      return resolveStyle(found, path, [...seen, name])
    }
    if (typeof style === 'string') return named(style)
    return style.preset ? { ...named(style.preset), ...style } : style
  }
  const css = (s: TextStyle): Css => {
    const out: Css = {}
    if (s.font) out.fontFamily = `${fontFamily(s.font)}, system-ui, sans-serif`
    if (s.size) out.fontSize = `${s.size}px`
    if (s.weight) out.fontWeight = s.weight
    if (s.color) out.color = color(s.color)!
    if (s.italic) out.fontStyle = 'italic'
    if (s.stretch) out.fontStretch = `${s.stretch}%`
    if (s.lineHeight) out.lineHeight = s.lineHeight
    if (s.letterSpacing) out.letterSpacing = `${s.letterSpacing}px`
    if (s.uppercase) out.textTransform = 'uppercase'
    if (s.align) out.textAlign = s.align
    if (s.background) out.background = color(s.background)!
    if (s.borderWidth) out.border = `${s.borderWidth}px solid ${color(s.borderColor) ?? 'currentColor'}`
    if (s.radius) out.borderRadius = `${s.radius}px`
    if (s.padding !== undefined) out.padding = Array.isArray(s.padding) ? `${s.padding[0]}px ${s.padding[1]}px` : `${s.padding}px`
    if (s.shadow) out.textShadow = s.shadow
    if (s.strike) out.textDecoration = 'line-through'
    return out
  }
  const baseText: TextStyle = { font: 'system-ui', size: Math.round(Math.min(W, H) * 0.045), color: '#111111', lineHeight: 1.2, ...resolveStyle(theme.text, '/theme/text') }

  // --- motion and keyframes ------------------------------------------------------------------
  const motion = (m: Motion | MotionType | undefined): PlanMotion | undefined => {
    if (m === undefined || m === 'none') return undefined
    const o = typeof m === 'string' ? { type: m } : m
    if (o.type === 'none') return undefined
    return { type: o.type, frames: Math.max(1, toFrames(spanSeconds(o.duration, 0.4))), ease: o.ease ?? (o.type === 'pop' ? 'outBack' : 'outCubic'), distance: o.distance ?? 60 }
  }
  const keyframes = (keys: Keyframe[], ctx: TimeContext, path: string): PlanKey[] =>
    keys
      .map((k, i) => {
        const [t, v, ease] = Array.isArray(k) ? [k[0], k[1], undefined] : [k.t, k.v, k.ease]
        return { f: toFrames(resolveTime(t, ctx, `${path}/${i}`, issues)), v, ...(ease ? { ease } : {}) }
      })
      .sort((a, b) => a.f - b.f)

  const length = (v: number | string | undefined, total: number, path: string): number | undefined => {
    if (v === undefined) return undefined
    if (typeof v === 'number') return v
    const m = /^(-?\d+(?:\.\d+)?)\s*(%|px)?$/.exec(v.trim())
    if (!m) {
      issues.push({ code: 'invalid-length', severity: 'error', path, message: `Cannot read length "${v}".`, hint: 'Use pixels (120) or percent ("50%").' })
      return 0
    }
    return m[2] === '%' ? (Number(m[1]) / 100) * total : Number(m[1])
  }

  // --- layers --------------------------------------------------------------------------------
  const compileLayer = (raw: Layer, path: string, ctx: TimeContext, defaults: { at: TimeRef; until: TimeRef }): PlanLayer | undefined => {
    let l = raw
    const override = raw.formats?.[format]
    if (override) {
      l = merge(raw, override)
      delete (l as Partial<Layer>).formats
      issues.push(...validateLayer(l, `${path}/formats/${format}`))
    }
    if (l.only && !l.only.includes(format)) return undefined
    const at = toFrames(resolveTime(l.at ?? defaults.at, ctx, `${path}/at`, issues))
    const until = toFrames(resolveTime(l.until ?? defaults.until, ctx, `${path}/until`, issues))
    if (until <= at) issues.push({ code: 'layer-never-visible', severity: 'warning', path, message: `Layer is never visible (at ${at / fps}s ≥ until ${until / fps}s).`, hint: 'Check "at" and "until".' })

    let x = length(l.x, W, `${path}/x`) ?? 0
    let y = length(l.y, H, `${path}/y`) ?? 0
    const baseline = l.anchor?.startsWith('baseline') ?? false
    let anchor = baseline ? anchors[(l.anchor === 'baseline' ? 'top' : l.anchor!.replace('baseline', 'top')) as Placement] : anchors[(l.anchor ?? 'top-left') as Placement]
    const width = length(l.width, W, `${path}/width`)
    const height = length(l.height, H, `${path}/height`)
    if (l.place) {
      anchor = anchors[l.place]
      x = safe.x + anchor[0] * (W - 2 * safe.x)
      y = safe.y + anchor[1] * (H - 2 * safe.y)
    }
    const animate: Record<string, PlanKey[]> = {}
    for (const [prop, keys] of Object.entries(l.animate ?? {})) if (keys) animate[prop] = keyframes(keys, ctx, `${path}/animate/${prop}`)
    const layer: PlanLayer = {
      path,
      id: l.id,
      type: l.type,
      x,
      y,
      width,
      height,
      anchor,
      ...(baseline ? { baseline } : {}),
      rotate: l.rotate ?? 0,
      scale: l.scale ?? 1,
      opacity: l.opacity ?? 1,
      at,
      until,
      enter: motion(l.enter ?? spec.defaults?.enter),
      exit: motion(l.exit ?? spec.defaults?.exit),
      animate,
    }
    const textCss = (style: string | TextStyle | undefined, p: string) => css({ ...baseText, ...resolveStyle(style, p) })
    switch (l.type) {
      case 'text':
        layer.text = l.text
        layer.css = textCss(l.style, `${path}/style`)
        if (width === undefined) layer.maxWidth = W - 2 * safe.x
        if (l.split) {
          layer.split = l.split
          layer.staggerFrames = (l.stagger ?? 0.05) * fps
        }
        break
      case 'qr': {
        const size = width ?? height ?? Math.round(Math.min(W, H) * 0.3)
        layer.width = layer.height = size
        layer.markup = qrSvg(l.data, { color: color(l.color) ?? '#000000', background: color(l.background) ?? '#ffffff', margin: l.margin ?? 4, level: l.level ?? 'M', radius: l.radius ?? 0 })
        break
      }
      case 'counter': {
        const start = l.start !== undefined ? toFrames(resolveTime(l.start, ctx, `${path}/start`, issues)) : at
        const end = l.end !== undefined ? toFrames(resolveTime(l.end, ctx, `${path}/end`, issues)) : start + fps
        const decimals = l.decimals ?? 0
        layer.counter = {
          from: l.from ?? 0,
          to: l.to,
          start,
          end,
          ease: l.ease ?? 'outCubic',
          locale: l.locale ?? 'de-DE',
          format: { minimumFractionDigits: decimals, maximumFractionDigits: decimals },
          prefix: l.prefix ?? '',
          suffix: l.suffix ?? '',
        }
        layer.css = textCss(l.style, `${path}/style`)
        break
      }
      case 'image': {
        layer.src = file(l.src, `${path}/src`)?.url
        layer.fit = l.fit ?? 'cover'
        if (l.width === undefined && l.height === undefined && l.x === undefined && l.y === undefined && !l.place) {
          layer.width = W
          layer.height = H
        }
        if (l.camera) {
          const c = l.camera
          const pos = (p: { zoom?: number; x?: number; y?: number } | undefined) => ({ zoom: p?.zoom ?? 1, x: p?.x ?? 0.5, y: p?.y ?? 0.5 })
          layer.camera = {
            from: pos(c.from),
            to: pos(c.to ?? c.from),
            start: c.start !== undefined ? toFrames(resolveTime(c.start, ctx, `${path}/camera/start`, issues)) : at,
            end: c.end !== undefined ? toFrames(resolveTime(c.end, ctx, `${path}/camera/end`, issues)) : until,
            ease: c.ease ?? 'inOutSine',
          }
        }
        break
      }
      case 'rect':
        layer.css = {
          background: color(l.color) ?? 'currentColor',
          ...(l.radius !== undefined ? { borderRadius: typeof l.radius === 'number' ? `${l.radius}px` : l.radius } : {}),
          ...(l.borderWidth ? { border: `${l.borderWidth}px solid ${color(l.borderColor) ?? '#000'}` } : {}),
        }
        break
      case 'svg':
        if (l.src) {
          const f = file(l.src, `${path}/src`)
          if (f) layer.markup = readFileSync(f.abs, 'utf8')
        } else if (l.markup) layer.markup = l.markup
        else issues.push({ code: 'missing-property', severity: 'error', path, message: 'svg layer needs "src" or "markup".', hint: 'Add "src": "file.svg".' })
        break
      case 'group':
        layer.width ??= W
        layer.height ??= H
        layer.layers = l.layers.flatMap((child, i) => compileLayer(child, `${path}/layers/${i}`, ctx, defaults) ?? [])
        break
      case 'custom':
        layer.module = file(l.module, `${path}/module`)?.url
        layer.props = l.props ?? {}
        layer.times = Object.fromEntries(Object.entries(l.times ?? {}).map(([k, t]) => [k, resolveTime(t, ctx, `${path}/times/${k}`, issues)]))
        layer.params = Object.fromEntries(
          Object.entries(l.params ?? {}).map(([k, v]) => [k, typeof v === 'number' ? [{ f: 0, v }] : keyframes(v, ctx, `${path}/params/${k}`)]),
        )
        layer.width ??= W
        layer.height ??= H
        break
    }
    return layer
  }

  // --- scenes: timing ------------------------------------------------------------------------
  interface Prepared {
    scene: Scene
    index: number
    path: string
    voice?: { file: string; lead: number; tail: number; volume: number; fadeIn: number; fadeOut: number; pauses: (number | Pause)[]; duration: number }
    seconds: number
    transition: { type: string; frames: number; overlap: boolean }
  }
  const prepared: Prepared[] = []
  for (const [index, original] of spec.scenes.entries()) {
    const path = `/scenes/${index}`
    if (original.only && !original.only.includes(format)) continue
    const scene: Scene = original.formats?.[format] ? { ...original, ...original.formats[format] } : original
    let voice: Prepared['voice']
    if (scene.voice) {
      const v: Voice = { lead: 0.25, tail: 0.6, volume: 1, fadeIn: 0, fadeOut: 0.1, pauses: 'detect', ...spec.defaults?.voice, ...(typeof scene.voice === 'string' ? { file: scene.voice } : scene.voice) }
      sceneFiles = new Set()
      const f = file(v.file, `${path}/voice${typeof scene.voice === 'string' ? '' : '/file'}`)
      if (f) {
        try {
          const info = await analyzeAudio(f.abs, options.ffmpegPath)
          voice = {
            file: f.abs,
            lead: spanSeconds(v.lead, 0.25),
            tail: spanSeconds(v.tail, 0.6),
            volume: v.volume!,
            fadeIn: spanSeconds(v.fadeIn, 0),
            fadeOut: spanSeconds(v.fadeOut, 0.1),
            duration: info.duration,
            pauses: Array.isArray(v.pauses) ? v.pauses : v.pauses === 'none' ? [] : info.pauses,
          }
        } catch (e) {
          issues.push({ code: 'audio-unreadable', severity: 'error', path: `${path}/voice`, message: String(e instanceof Error ? e.message : e), hint: 'Use a WAV, MP3, M4A or OGG file.' })
        }
      }
    }
    let seconds: number
    if (typeof scene.duration === 'number') {
      seconds = scene.duration
      if (voice && seconds < voice.lead + voice.duration)
        issues.push({
          code: 'scene-shorter-than-voice',
          severity: 'error',
          path: `${path}/duration`,
          message: `Scene lasts ${seconds}s but its voice ends at ${(voice.lead + voice.duration).toFixed(2)}s.`,
          hint: `Set "duration" to at least ${Math.ceil((voice.lead + voice.duration + 0.3) * 10) / 10} or to "auto".`,
        })
    } else if (voice) seconds = voice.lead + voice.duration + voice.tail
    else {
      if (!scene.voice)
        issues.push({ code: 'missing-duration', severity: 'error', path: `${path}/duration`, message: 'Scene has neither a duration nor a voice.', hint: 'Add "duration": <seconds> or a "voice" file.' })
      seconds = 1
    }
    const t: Transition | undefined = (() => {
      const raw = scene.transition ?? (prepared.length > 0 ? spec.defaults?.transition : undefined) ?? (prepared.length > 0 ? 'fade' : 'cut')
      return typeof raw === 'string' ? { type: raw } : raw
    })()
    prepared.push({
      scene,
      index,
      path,
      voice,
      seconds,
      transition: { type: t.type, frames: t.type === 'cut' ? 0 : Math.max(1, toFrames(spanSeconds(t.duration, 0.3))), overlap: !!t.overlap && prepared.length > 0 },
    })
  }

  let cursor = 0
  const timeline = prepared.map((p) => {
    const frames = Math.ceil(p.seconds * fps - 1e-9)
    const start = Math.max(0, cursor - (p.transition.overlap ? p.transition.frames : 0))
    cursor = start + frames
    return { start, frames }
  })
  const totalFrames = Math.max(1, ...timeline.map((t) => t.start + t.frames))
  const sceneIds = prepared.map((p) => p.scene.id)
  const sceneAt = (id: string) => {
    const i = sceneIds.indexOf(id)
    return i < 0 ? undefined : { start: timeline[i].start / fps, end: (timeline[i].start + timeline[i].frames) / fps }
  }

  // --- scenes: content -----------------------------------------------------------------------
  const captionStyle: CaptionStyle = {
    font: baseText.font,
    size: Math.round(Math.min(W, H) * 0.042),
    weight: 600,
    color: '#ffffff',
    background: 'rgba(0, 0, 0, 0.78)',
    radius: 10,
    padding: [12, 28],
    lineHeight: 1.25,
    align: 'center',
    ...resolveStyle(theme.captions, '/theme/captions'),
  }
  const maxChars = captionStyle.maxChars ?? (W >= H ? 80 : 42)
  const maxCps = captionStyle.maxCps ?? 20
  const cues: PlanCue[] = []
  const audio: AudioTrack[] = []
  const filesPerScene: string[][] = []

  const audioTracks = (list: AudioSpec[] | undefined, path: string, ctx: TimeContext, offset: number) => {
    for (const [i, a] of (list ?? []).entries()) {
      const p = `${path}/${i}`
      const f = file(a.file, `${p}/file`, offset === 0 && path === '/audio')
      if (!f) continue
      const start = resolveTime(a.start ?? 0, ctx, `${p}/start`, issues)
      const end = a.end !== undefined ? resolveTime(a.end, ctx, `${p}/end`, issues) : undefined
      const volume =
        Array.isArray(a.volume) && a.volume.length
          ? keyframes(a.volume, ctx, `${p}/volume`).map((k): [number, number] => [k.f / fps + offset, k.v])
          : (a.volume as number | undefined)
      audio.push({
        file: f.abs,
        start: Math.max(0, start + offset),
        volume,
        offset: a.offset,
        duration: end !== undefined ? Math.max(0, end - start) : undefined,
        fadeIn: a.fadeIn,
        fadeOut: end !== undefined ? a.fadeOut : undefined,
      })
      if (a.fadeOut && end === undefined)
        issues.push({ code: 'fade-out-needs-end', severity: 'warning', path: `${p}/fadeOut`, message: 'fadeOut is ignored without "end".', hint: 'Add "end".' })
    }
  }

  const scenes: PlanScene[] = prepared.map((p, i) => {
    sceneFiles = new Set(p.voice ? [p.voice.file] : [])
    const { start, frames } = timeline[i]
    const { scene, path, voice } = p
    const seconds = frames / fps
    // captions and sentence times (seconds from scene start)
    let sentenceTimes: number[] = []
    let pieces: { text: string; start: number; end: number }[] = []
    if (scene.script) {
      const sentences = splitSentences(scene.script)
      const parts = sentences.flatMap((s, n) => splitText(s, maxChars).map((text) => ({ text, sentence: n })))
      const span = voice ? voice.duration : seconds
      const offset = voice ? voice.lead : 0
      const timed = timeCues(
        parts.map((x) => x.text),
        span,
        voice?.pauses ?? [],
      )
      pieces = timed.map((c) => ({ text: c.text, start: c.start + offset, end: c.end + offset }))
      // sentence starts: timed on whole sentences, independent of how captions are split
      sentenceTimes = timeCues(sentences, span, voice?.pauses ?? []).map((c) => c.start + offset)
    }
    const ctx: TimeContext = {
      fps,
      end: seconds,
      voice: voice ? { start: voice.lead, end: voice.lead + voice.duration } : undefined,
      sentences: sentenceTimes,
      word: scene.script
        ? (text) => {
            const piece = pieces.find((x) => x.text.includes(text))
            if (!piece) return undefined
            return piece.start + (piece.text.indexOf(text) / piece.text.length) * (piece.end - piece.start)
          }
        : undefined,
      scene: (id) => {
        const s = sceneAt(id)
        return s && { start: s.start - start / fps, end: s.end - start / fps }
      },
      sceneIds,
      scriptHint: scene.script?.slice(0, 80),
    }

    // captions
    let sceneCues: { text: string; start: number; end: number; path: string }[] = []
    if (Array.isArray(scene.captions)) {
      sceneCues = scene.captions.map((c, n) => ({
        text: c.text,
        start: resolveTime(c.start, ctx, `${path}/captions/${n}/start`, issues),
        end: resolveTime(c.end, ctx, `${path}/captions/${n}/end`, issues),
        path: `${path}/captions/${n}`,
      }))
    } else if (typeof scene.captions === 'string') {
      const f = file(scene.captions, `${path}/captions`)
      if (f) sceneCues = parseSubtitles(readFileSync(f.abs, 'utf8')).map((c, n) => ({ ...c, path: `${path}/captions#${n + 1}` }))
    } else if (scene.captions !== false && scene.script) {
      sceneCues = pieces.map((c) => ({ ...c, path: `${path}/script` }))
    }
    for (const c of sceneCues) {
      const duration = c.end - c.start
      const cps = c.text.length / Math.max(duration, 0.001)
      if (cps > maxCps)
        issues.push({
          code: 'caption-too-fast',
          severity: 'warning',
          path: c.path,
          scene: scene.id,
          time: Math.round((start / fps + c.start) * 100) / 100,
          message: `Caption "${c.text.slice(0, 40)}…" needs ${cps.toFixed(1)} characters/s (limit ${maxCps}).`,
          hint: 'Shorten the text, slow down the voice or raise theme.captions.maxCps.',
        })
      if (duration < 0.7)
        issues.push({ code: 'caption-too-short', severity: 'warning', path: c.path, scene: scene.id, time: Math.round((start / fps + c.start) * 100) / 100, message: `Caption "${c.text.slice(0, 40)}" is shown only ${duration.toFixed(2)}s.`, hint: 'Merge it with a neighbouring caption.' })
      if (c.text.length > maxChars)
        issues.push({ code: 'caption-too-long', severity: 'warning', path: c.path, scene: scene.id, message: `Caption has ${c.text.length} characters (limit ${maxChars}).`, hint: 'Split it or raise theme.captions.maxChars.' })
      cues.push({ text: c.text, start: start + toFrames(c.start), end: Math.min(start + frames, start + toFrames(c.end)), path: c.path, scene: scene.id })
    }

    const layers = (scene.layers ?? []).flatMap((l, n) => compileLayer(l, `${path}/layers/${n}`, ctx, { at: 'start', until: 'end' }) ?? [])
    for (const l of layers)
      if (l.at >= frames) issues.push({ code: 'layer-after-scene', severity: 'warning', path: l.path, scene: scene.id, message: `Layer starts at ${(l.at / fps).toFixed(2)}s, after the scene ends (${seconds.toFixed(2)}s).`, hint: 'Move "at" into the scene.' })

    if (voice)
      audio.push({ file: voice.file, start: start / fps + voice.lead, volume: voice.volume, duration: voice.duration, fadeIn: voice.fadeIn || undefined, fadeOut: voice.fadeOut || undefined })
    audioTracks(scene.audio, `${path}/audio`, ctx, start / fps)
    filesPerScene.push([...sceneFiles])

    return {
      id: scene.id,
      path,
      start,
      frames,
      transition: p.transition,
      background: color(scene.background ?? theme.background) ?? '#ffffff',
      layers,
      voice: voice ? { start: toFrames(voice.lead), end: toFrames(voice.lead + voice.duration) } : undefined,
      sentences: sentenceTimes.map(toFrames),
    }
  })

  // --- global --------------------------------------------------------------------------------
  sceneFiles = globalFiles
  const globalCtx: TimeContext = { fps, end: totalFrames / fps, scene: sceneAt, sceneIds }
  const overlays = (spec.overlays ?? []).flatMap((l, n) => compileLayer(l, `/overlays/${n}`, globalCtx, { at: 'start', until: 'end' }) ?? [])
  audioTracks(spec.audio, '/audio', globalCtx, 0)
  const fonts = Object.entries(theme.fonts ?? {}).flatMap(([key, f]) => {
    const found = file(f.src, `/theme/fonts/${key}/src`, true)
    return found ? [{ family: f.family ?? key, src: found.url, weight: f.weight, style: f.style, stretch: f.stretch }] : []
  })

  const { bottom, maxWidth, fade, ...captionText } = captionStyle
  const plan: Plan = {
    format,
    width: W,
    height: H,
    fps,
    frames: totalFrames,
    background: color(theme.background) ?? '#ffffff',
    safe,
    fonts,
    scenes,
    overlays,
    captions: {
      css: css(captionText),
      bottom: bottom ?? Math.round(H * 0.06),
      maxWidth: maxWidth ?? Math.round(W * 0.86),
      fadeFrames: toFrames(fade ?? 0.12),
      cues,
    },
  }
  return { plan, audio, issues, files: { scenes: filesPerScene, global: [...globalFiles] }, root }
}
