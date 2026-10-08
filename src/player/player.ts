/**
 * Browser player for a compiled plan (window.__videoMakerPlan). Builds the DOM once and updates
 * it per frame. Implements the composition contract (window.videoMaker) and inspection hooks
 * used by `check`.
 */
import { ease as easings, parseSpring, spring } from '../kit/easing.js'
import type { Plan, PlanKey, PlanLayer, PlanMotion, PlanScene } from '../spec/plan.js'

type EaseFn = (p: number) => number
const named: Record<string, EaseFn> = { in: easings.inCubic, out: easings.outCubic, inOut: easings.inOutCubic, back: easings.outBack }
/** Easing by name; a spring runs in real time, so it needs the segment length in seconds. */
const easeFn = (name: string | undefined, seconds = 1): EaseFn => {
  const s = name ? parseSpring(name) : undefined
  if (s) return (p) => spring(p * seconds, s)
  return (name && (named[name] ?? (easings as unknown as Record<string, EaseFn>)[name])) || easings.inOutCubic
}
const clamp01 = (p: number) => Math.min(1, Math.max(0, p))
const fps = (window as any).__videoMakerPlan.fps as number

function keyValue(keys: PlanKey[] | undefined, f: number, fallback: number): number {
  if (!keys?.length) return fallback
  if (f <= keys[0].f) return keys[0].v
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]
    if (f < b.f) {
      const a = keys[i - 1]
      return a.v + (b.v - a.v) * easeFn(b.ease, (b.f - a.f) / fps)(clamp01((f - a.f) / (b.f - a.f)))
    }
  }
  // a spring into the last key keeps swinging until it settles
  const last = keys[keys.length - 1]
  const s = keys.length > 1 && last.ease ? parseSpring(last.ease) : undefined
  if (s) {
    const a = keys[keys.length - 2]
    return a.v + (last.v - a.v) * spring((f - a.f) / fps, s)
  }
  return last.v
}

interface Effect {
  opacity: number
  dx: number
  dy: number
  scale: number
  scaleX: number
  scaleY: number
  clip?: number
  blur: number
  draw: number
}

function applyMotion(m: PlanMotion, p: number, e: Effect) {
  switch (m.type) {
    case 'fade':
      e.opacity *= p
      break
    case 'slide-up':
      e.dy += (1 - p) * m.distance
      e.opacity *= p
      break
    case 'slide-down':
      e.dy -= (1 - p) * m.distance
      e.opacity *= p
      break
    case 'slide-left':
      e.dx += (1 - p) * m.distance
      e.opacity *= p
      break
    case 'slide-right':
      e.dx -= (1 - p) * m.distance
      e.opacity *= p
      break
    case 'scale':
      e.scale *= 0.85 + 0.15 * p
      e.opacity *= p
      break
    case 'pop':
      e.scale *= Math.max(0, 0.5 + 0.5 * p)
      e.opacity *= clamp01(p * 3)
      break
    case 'wipe':
      e.clip = (1 - clamp01(p)) * 100
      break
    case 'grow-x':
      e.scaleX *= Math.max(0, p)
      break
    case 'grow-y':
      e.scaleY *= Math.max(0, p)
      break
    case 'blur':
      e.blur += (1 - p) * 16
      e.opacity *= p
      break
    case 'draw':
      e.draw = Math.min(e.draw, clamp01(p))
      break
  }
}

interface View {
  layer: PlanLayer
  el: HTMLElement
  update(f: number): void
  children: View[]
  custom?: (t: number, info: object) => unknown
  /** Distance from the top of the box to the first text baseline (baseline anchors). */
  baselinePx?: number
}

/** Measure first-line baselines once fonts are loaded: an empty inline-block sits on the baseline. */
function measureBaselines() {
  for (const view of views) {
    if (!view.layer.baseline) continue
    const { el } = view
    const display = el.style.display
    el.style.display = ''
    const probe = document.createElement('span')
    probe.style.display = 'inline-block'
    probe.style.width = probe.style.height = '0'
    el.prepend(probe)
    view.baselinePx = probe.offsetTop + el.clientTop
    probe.remove()
    el.style.display = display
    el.style.transformOrigin = `${view.layer.anchor[0] * 100}% ${view.baselinePx}px`
  }
}

const plan = (window as any).__videoMakerPlan as Plan
const W = plan.width
const H = plan.height
const views: View[] = []
const pending: Promise<unknown>[] = []

function setStyle(el: HTMLElement, css: Record<string, string | number> | undefined) {
  if (css) for (const [k, v] of Object.entries(css)) (el.style as any)[k] = typeof v === 'number' && k !== 'fontWeight' && k !== 'lineHeight' && k !== 'opacity' ? `${v}px` : String(v)
}

function buildLayer(layer: PlanLayer, parent: HTMLElement, scene?: PlanScene): View {
  const el = document.createElement('div')
  el.dataset.vmPath = layer.path
  el.dataset.vmType = layer.type
  el.style.position = 'absolute'
  el.style.boxSizing = 'border-box'
  el.style.transformOrigin = `${layer.anchor[0] * 100}% ${layer.anchor[1] * 100}%`
  if (layer.width !== undefined) el.style.width = `${layer.width}px`
  if (layer.height !== undefined) el.style.height = `${layer.height}px`
  // boxes the author fixed: only these can overflow
  el.dataset.vmFixed = `${layer.width !== undefined || layer.animate.width ? 'w' : ''}${layer.height !== undefined || layer.animate.height ? 'h' : ''}`
  setStyle(el, layer.css)
  const view: View = { layer, el, update: () => {}, children: [] }
  let img: HTMLImageElement | undefined
  let nf: Intl.NumberFormat | undefined
  let strokes: SVGGeometryElement[] = []
  const units: HTMLSpanElement[] = []
  switch (layer.type) {
    case 'text':
      if (layer.split) {
        // one span per character or word; whitespace stays plain text so lines wrap normally
        for (const part of (layer.text ?? '').split(layer.split === 'chars' ? /(\s)/ : /(\s+)/)) {
          if (!part) continue
          if (/^\s+$/.test(part)) el.append(part)
          else
            for (const unit of layer.split === 'chars' ? Array.from(part) : [part]) {
              const span = document.createElement('span')
              span.textContent = unit
              span.style.position = 'relative'
              el.append(span)
              units.push(span)
            }
        }
      } else el.textContent = layer.text ?? ''
      el.style.whiteSpace = 'pre-line'
      el.style.textWrap = 'balance'
      el.style.overflowWrap = 'break-word'
      if (layer.width === undefined) {
        el.style.width = 'max-content'
        el.style.maxWidth = `${layer.maxWidth}px`
      }
      el.dataset.vmText = '1'
      break
    case 'counter':
      el.style.whiteSpace = 'nowrap'
      el.style.fontVariantNumeric = 'tabular-nums'
      el.dataset.vmText = '1'
      nf = new Intl.NumberFormat(layer.counter!.locale, layer.counter!.format)
      break
    case 'image':
      el.style.overflow = 'hidden'
      img = document.createElement('img')
      img.src = layer.src ?? ''
      img.style.width = '100%'
      img.style.height = '100%'
      img.style.display = 'block'
      img.style.objectFit = layer.fit ?? 'cover'
      el.append(img)
      break
    case 'svg':
    case 'qr':
      el.innerHTML = layer.markup ?? ''
      if (layer.width !== undefined || layer.height !== undefined) {
        const svg = el.querySelector('svg')
        if (svg) {
          svg.setAttribute('width', '100%')
          svg.setAttribute('height', '100%')
        }
      }
      // strokes that the draw effect reveals (dashed strokes keep their pattern)
      if (layer.enter?.type === 'draw' || layer.exit?.type === 'draw' || layer.animate.draw) {
        strokes = Array.from(el.querySelectorAll<SVGGeometryElement>('path, line, polyline, polygon, circle, ellipse, rect')).filter(
          (s) => s.getAttribute('stroke') && s.getAttribute('stroke') !== 'none' && !s.getAttribute('stroke-dasharray'),
        )
        for (const s of strokes) {
          s.setAttribute('pathLength', '1')
          s.style.strokeDasharray = '1 1'
        }
      }
      break
    case 'group':
      view.children = (layer.layers ?? []).map((child) => buildLayer(child, el, scene))
      break
    case 'custom':
      pending.push(
        import(layer.module!).then(async (mod) => {
          const context = {
            width: W,
            height: H,
            fps: plan.fps,
            format: plan.format,
            box: { width: layer.width, height: layer.height },
            times: layer.times ?? {},
            scene: scene && { id: scene.id, frames: scene.frames, voice: scene.voice, sentences: scene.sentences },
          }
          view.custom = await mod.default(el, layer.props ?? {}, context)
        }),
      )
      break
  }
  parent.append(el)

  view.update = (f: number) => {
    const visible = f >= layer.at && f < layer.until
    el.style.display = visible ? '' : 'none'
    if (!visible) return
    const a = layer.animate
    const e: Effect = {
      opacity: keyValue(a.opacity, f, layer.opacity),
      dx: 0,
      dy: 0,
      scale: keyValue(a.scale, f, layer.scale),
      scaleX: keyValue(a.scaleX, f, 1),
      scaleY: keyValue(a.scaleY, f, 1),
      blur: keyValue(a.blur, f, 0),
      draw: keyValue(a.draw, f, 1),
    }
    const { enter, exit } = layer
    if (enter && units.length) {
      // per character/word: each unit runs the enter motion `staggerFrames` after the previous one
      units.forEach((span, i) => {
        const u: Effect = { opacity: 1, dx: 0, dy: 0, scale: 1, scaleX: 1, scaleY: 1, blur: 0, draw: 1 }
        const local = f - layer.at - i * (layer.staggerFrames ?? 0)
        if (local < enter.frames) applyMotion(enter, easeFn(enter.ease, enter.frames / fps)(clamp01(local / enter.frames)), u)
        span.style.opacity = String(clamp01(u.opacity))
        span.style.left = `${u.dx}px`
        span.style.top = `${u.dy}px`
      })
    } else if (enter && f < layer.at + enter.frames) applyMotion(enter, easeFn(enter.ease, enter.frames / fps)((f - layer.at) / enter.frames), e)
    if (exit && f >= layer.until - exit.frames) applyMotion(exit, easeFn(exit.ease, exit.frames / fps)((layer.until - f) / exit.frames), e)
    el.style.left = `${keyValue(a.x, f, layer.x)}px`
    el.style.top = `${keyValue(a.y, f, layer.y)}px`
    if (a.width) el.style.width = `${keyValue(a.width, f, layer.width ?? 0)}px`
    if (a.height) el.style.height = `${keyValue(a.height, f, layer.height ?? 0)}px`
    el.style.opacity = String(clamp01(e.opacity))
    const [ax, ay] = layer.anchor
    const dyAnchor = layer.baseline ? `${-(view.baselinePx ?? 0)}px` : `${-ay * 100}%`
    el.style.transform = `translate(${-ax * 100}%, ${dyAnchor}) translate(${e.dx}px, ${e.dy}px) rotate(${keyValue(a.rotate, f, layer.rotate)}deg) scale(${e.scale * e.scaleX}, ${e.scale * e.scaleY})`
    el.style.clipPath = e.clip !== undefined ? `inset(0 ${e.clip}% 0 0)` : ''
    el.style.filter = e.blur > 0 ? `blur(${e.blur}px)` : ''
    for (const s of strokes) s.style.strokeDashoffset = String(1 - clamp01(e.draw))
    if (layer.counter && nf) {
      const c = layer.counter
      const p = easeFn(c.ease)(clamp01((f - c.start) / Math.max(1, c.end - c.start)))
      el.textContent = c.prefix + nf.format(c.from + (c.to - c.from) * p) + c.suffix
    }
    if (layer.camera && img) {
      const c = layer.camera
      const p = easeFn(c.ease)(clamp01((f - c.start) / Math.max(1, c.end - c.start)))
      const mix = (x: number, y: number) => x + (y - x) * p
      img.style.transformOrigin = `${mix(c.from.x, c.to.x) * 100}% ${mix(c.from.y, c.to.y) * 100}%`
      img.style.transform = `scale(${mix(c.from.zoom, c.to.zoom)})`
    }
    for (const child of view.children) child.update(f)
    if (view.custom) {
      const params: Record<string, number> = {}
      for (const [k, keys] of Object.entries(layer.params ?? {})) params[k] = keyValue(keys, f, 0)
      view.custom(f / plan.fps, { frame: f, fps: plan.fps, params })
    }
  }
  views.push(view)
  return view
}

// --- DOM ---------------------------------------------------------------------------------------
document.documentElement.style.background = plan.background
document.body.style.margin = '0'
const stage = document.createElement('div')
stage.id = 'stage'
Object.assign(stage.style, { position: 'relative', width: `${W}px`, height: `${H}px`, overflow: 'hidden', background: plan.background })
document.body.append(stage)

const sceneViews = plan.scenes.map((scene) => {
  const el = document.createElement('div')
  el.dataset.vmScene = scene.id
  Object.assign(el.style, { position: 'absolute', inset: '0', background: scene.background, overflow: 'hidden' })
  const content = document.createElement('div')
  Object.assign(content.style, { position: 'absolute', inset: '0' })
  el.append(content)
  stage.append(el)
  return { scene, el, content, layers: scene.layers.map((l) => buildLayer(l, content, scene)) }
})
const overlayBox = document.createElement('div')
Object.assign(overlayBox.style, { position: 'absolute', inset: '0', pointerEvents: 'none' })
stage.append(overlayBox)
const overlays = plan.overlays.map((l) => buildLayer(l, overlayBox))

const captionBox = document.createElement('div')
Object.assign(captionBox.style, { position: 'absolute', left: '0', right: '0', bottom: `${plan.captions.bottom}px`, display: 'flex', justifyContent: 'center' })
const cueEl = document.createElement('div')
cueEl.dataset.vmText = '1'
cueEl.dataset.vmCaption = '1'
setStyle(cueEl, plan.captions.css)
// maxWidth is the outer width of the caption box, padding included
Object.assign(cueEl.style, { maxWidth: `${plan.captions.maxWidth}px`, boxSizing: 'border-box', textWrap: 'balance', whiteSpace: 'pre-line' })
captionBox.append(cueEl)
stage.append(captionBox)

function renderFrame(f: number) {
  for (const { scene, el, content, layers } of sceneViews) {
    const local = f - scene.start
    const visible = local >= 0 && local < scene.frames
    el.style.display = visible ? '' : 'none'
    if (!visible) continue
    const t = scene.transition
    const target = t.overlap ? el : content
    el.style.opacity = content.style.opacity = '1'
    el.style.transform = content.style.transform = el.style.clipPath = content.style.clipPath = ''
    // the compiler gives the first scene a transition only when the description asks for one
    if (t.frames > 0 && local < t.frames) {
      const p = easeFn('inOutSine')(local / t.frames)
      if (t.type === 'fade') target.style.opacity = String(p)
      else if (t.type === 'slide-left') target.style.transform = `translateX(${(1 - p) * W}px)`
      else if (t.type === 'slide-up') target.style.transform = `translateY(${(1 - p) * H}px)`
      else if (t.type === 'wipe') target.style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`
      else if (t.type === 'zoom') {
        target.style.transform = `scale(${1.08 - 0.08 * p})`
        target.style.opacity = String(p)
      }
    }
    for (const v of layers) v.update(local)
  }
  for (const v of overlays) v.update(f)
  let cue: (typeof plan.captions.cues)[number] | undefined
  for (const c of plan.captions.cues) if (f >= c.start && f < c.end && (!cue || c.start >= cue.start)) cue = c
  captionBox.style.display = cue ? 'flex' : 'none'
  if (cue) {
    if (cueEl.textContent !== cue.text) cueEl.textContent = cue.text
    cueEl.dataset.vmPath = cue.path
    cueEl.style.opacity = String(plan.captions.fadeFrames > 0 ? clamp01((f - cue.start + 1) / plan.captions.fadeFrames) : 1)
  }
}

// --- fonts and contract ------------------------------------------------------------------------
for (const font of plan.fonts) {
  const face = new FontFace(font.family, `url("${font.src}")`, {
    ...(font.weight ? { weight: font.weight } : {}),
    ...(font.style ? { style: font.style } : {}),
    ...(font.stretch ? { stretch: font.stretch } : {}),
  })
  document.fonts.add(face)
  pending.push(face.load())
}

;(window as any).videoMaker = {
  width: W,
  height: H,
  fps: plan.fps,
  frames: plan.frames,
  ready: () => Promise.all(pending).then(measureBaselines),
  frame: (f: number) => renderFrame(f),
}

// --- inspection for `check` --------------------------------------------------------------------
;(window as any).__videoMakerInspect = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-vm-text]'))
    .filter((el) => el.offsetParent !== null || el.getClientRects().length > 0)
    .map((el) => {
      const r = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      let opacity = 1
      for (let n: HTMLElement | null = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity)
      const range = document.createRange()
      range.selectNodeContents(el)
      const lines = new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size
      return {
        path: el.dataset.vmPath ?? '',
        caption: el.dataset.vmCaption === '1',
        text: (el.textContent ?? '').slice(0, 60),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        color: style.color,
        fontSize: parseFloat(style.fontSize),
        fontWeight: Number(style.fontWeight),
        overflow:
          (el.dataset.vmFixed?.includes('w') && el.scrollWidth > el.clientWidth + 1) ||
          (el.dataset.vmFixed?.includes('h') && el.scrollHeight > el.clientHeight + Math.max(2, parseFloat(style.fontSize) * 0.3)) ||
          // unfixed text: wider than its maximum width (a single unbreakable word)
          (!el.dataset.vmFixed && el.scrollWidth > el.clientWidth + 1),
        lines,
        opacity,
      }
    })
    .filter((t) => t.opacity > 0.5 && t.text.trim() !== '')
;(window as any).__videoMakerHideText = (hide: boolean) => {
  for (const el of document.querySelectorAll<HTMLElement>('[data-vm-text]')) {
    el.style.color = hide ? 'transparent' : ''
    el.style.textShadow = hide ? 'none' : ''
    if (!hide) setStyle(el, el.dataset.vmCaption ? plan.captions.css : findCss(el.dataset.vmPath))
  }
}
const findCss = (path?: string) => views.find((v) => v.layer.path === path)?.layer.css
