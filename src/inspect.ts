import type { Issue } from './errors.js'
import type { Composition, FramePage } from './render.js'
import type { Plan, PlanLayer } from './spec/plan.js'

export interface SheetFrame {
  frame: number
  label: string
}

/** Pick frames: `count` evenly spaced over [0, frames), or the middle of each scene. */
export function sheetFrames(meta: { frames: number; fps: number }, options: { count?: number; plan?: Plan; perScene?: number }): SheetFrame[] {
  const label = (f: number, scene?: string) => `${(f / meta.fps).toFixed(2)} s · #${f}${scene ? ` · ${scene}` : ''}`
  const sceneOf = (f: number) => options.plan?.scenes.filter((s) => f >= s.start && f < s.start + s.frames).at(-1)?.id
  if (options.plan && options.perScene) {
    const k = options.perScene
    return options.plan.scenes.flatMap((s) =>
      Array.from({ length: k }, (_, i) => {
        const f = Math.min(s.start + s.frames - 1, s.start + Math.round(((i + 0.5) / k) * s.frames))
        return { frame: f, label: label(f, s.id) }
      }),
    )
  }
  const n = Math.max(1, Math.min(options.count ?? 12, meta.frames))
  return Array.from({ length: n }, (_, i) => {
    const f = Math.min(meta.frames - 1, Math.floor(((i + 0.5) / n) * meta.frames))
    return { frame: f, label: label(f, sceneOf(f)) }
  })
}

/** Render the frames as a labelled grid into one PNG. */
export async function contactSheet(composition: Composition, frames: SheetFrame[], options: { columns?: number; thumbWidth?: number } = {}): Promise<Buffer> {
  const { meta } = composition
  const page = await composition.openPage()
  try {
    const shots: string[] = []
    for (const f of frames) shots.push((await page.capture(f.frame, 'jpeg', 85)).toString('base64'))
    const portrait = meta.height > meta.width
    const columns = options.columns ?? Math.min(frames.length, portrait ? 6 : 4)
    const thumb = options.thumbWidth ?? (portrait ? 270 : 480)
    const browser = page.page.context().browser()!
    const sheet = await browser.newPage({ viewport: { width: columns * (thumb + 12) + 12, height: 200 } })
    try {
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
      await sheet.setContent(`<!doctype html><html><body style="margin:0;background:#1d1f24;font:600 14px system-ui,sans-serif;color:#e8e8e8">
<div style="display:grid;grid-template-columns:repeat(${columns},${thumb}px);gap:12px;padding:12px">
${frames.map((f, i) => `<figure style="margin:0"><img style="display:block;width:${thumb}px;height:auto;outline:1px solid #444" src="data:image/jpeg;base64,${shots[i]}"><figcaption style="padding:4px 2px 0">${esc(f.label)}</figcaption></figure>`).join('\n')}
</div></body></html>`)
      await sheet.evaluate(() => Promise.all(Array.from(document.images).map((img) => img.decode())))
      return await sheet.screenshot({ fullPage: true, type: 'png' })
    } finally {
      await sheet.close()
    }
  } finally {
    await page.close()
  }
}

interface TextInfo {
  path: string
  caption: boolean
  text: string
  rect: { x: number; y: number; width: number; height: number }
  color: string
  fontSize: number
  fontWeight: number
  overflow: boolean
  lines: number
  opacity: number
}

/** Frames worth checking: every text layer once fully entered, every caption in its middle. */
export function checkFrames(plan: Plan): number[] {
  const frames = new Set<number>()
  const walk = (layers: PlanLayer[], offset: number, end: number) => {
    for (const l of layers) {
      if (l.layers) walk(l.layers, offset, end)
      if (l.type !== 'text' && l.type !== 'counter') continue
      const until = Math.min(l.until, end)
      if (until <= l.at) continue
      const settled = l.at + (l.enter?.frames ?? 0) + Math.max(0, ...Object.values(l.animate).map((k) => (k.length ? k[k.length - 1].f - l.at : 0)))
      const exitStart = until - (l.exit?.frames ?? 0)
      const f = l.counter ? Math.max(l.counter.end, Math.min(settled, exitStart - 1)) : Math.min(settled, exitStart - 1)
      frames.add(offset + Math.max(l.at, Math.min(f, until - 1)))
    }
  }
  for (const s of plan.scenes) walk(s.layers, s.start, s.frames)
  walk(plan.overlays, 0, plan.frames)
  for (const c of plan.captions.cues) frames.add(Math.floor((c.start + c.end) / 2))
  return [...frames].filter((f) => f >= 0 && f < plan.frames).sort((a, b) => a - b)
}

const luminance = ([r, g, b]: number[]) => {
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

/** Run layout and contrast checks on the given frames. */
export async function checkLayout(composition: Composition, plan: Plan, frames: number[]): Promise<Issue[]> {
  const { width: W, height: H, fps } = plan
  const issues = new Map<string, Issue>()
  const add = (issue: Issue) => {
    const key = `${issue.code}|${issue.path}`
    if (!issues.has(key)) issues.set(key, { format: plan.format, ...issue })
  }
  const sceneAt = (f: number) => plan.scenes.filter((s) => f >= s.start && f < s.start + s.frames).at(-1)?.id
  const page: FramePage = await composition.openPage()
  try {
    for (const frame of frames) {
      await page.seek(frame)
      const texts = (await page.page.evaluate(() => (window as any).__videoMakerInspect?.() ?? [])) as TextInfo[]
      if (!texts.length) continue
      await page.page.evaluate(() => (window as any).__videoMakerHideText(true))
      const background = (await page.shot('png')).toString('base64')
      await page.page.evaluate(() => (window as any).__videoMakerHideText(false))
      // Sample the background behind each text box (text hidden) on a grid.
      const { samples, colors } = (await page.page.evaluate(
        async ({ png, rects, colors }) => {
          const blob = await (await fetch(`data:image/png;base64,${png}`)).blob()
          const bitmap = await createImageBitmap(blob)
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!
          ctx.drawImage(bitmap, 0, 0)
          const samples = rects.map((r: { x: number; y: number; width: number; height: number }) => {
            const out: number[][] = []
            for (let i = 0; i < 12; i++)
              for (let j = 0; j < 5; j++) {
                const x = Math.min(bitmap.width - 1, Math.max(0, Math.round(r.x + ((i + 0.5) / 12) * r.width)))
                const y = Math.min(bitmap.height - 1, Math.max(0, Math.round(r.y + ((j + 0.5) / 5) * r.height)))
                out.push(Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)))
              }
            return out
          })
          // any CSS color (oklch, named, …) to sRGB via a 1×1 canvas
          const one = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!
          const rgb = colors.map((c: string) => {
            one.clearRect(0, 0, 1, 1)
            one.fillStyle = c
            one.fillRect(0, 0, 1, 1)
            return Array.from(one.getImageData(0, 0, 1, 1).data.slice(0, 4))
          })
          return { samples, colors: rgb }
        },
        { png: background, rects: texts.map((t) => t.rect), colors: texts.map((t) => t.color) },
      )) as { samples: number[][][]; colors: number[][] }

      const scene = sceneAt(frame)
      const where = { frame, time: Math.round((frame / fps) * 100) / 100, scene }
      texts.forEach((t, i) => {
        const r = t.rect
        const name = t.caption ? 'Caption' : `Text "${t.text.slice(0, 30)}"`
        if (r.x < -2 || r.y < -2 || r.x + r.width > W + 2 || r.y + r.height > H + 2)
          add({ code: 'text-outside-frame', severity: 'error', path: t.path, ...where, message: `${name} extends beyond the frame.`, hint: 'Reduce size or text, or set width so it wraps; check x/y/anchor.' })
        else if (!t.caption && (r.x < plan.safe.x - 2 || r.y < plan.safe.y - 2 || r.x + r.width > W - plan.safe.x + 2 || r.y + r.height > H - plan.safe.y + 2))
          add({ code: 'text-outside-safe-area', severity: 'warning', path: t.path, ...where, message: `${name} lies outside the safe area (${plan.safe.x}px/${plan.safe.y}px).`, hint: 'Move it inwards or use "place".' })
        if (t.overflow) add({ code: 'text-overflow', severity: 'error', path: t.path, ...where, message: `${name} does not fit into its box.`, hint: 'Increase width/height, shorten the text or reduce the size.' })
        if (t.caption && t.lines > 2)
          add({ code: 'caption-too-many-lines', severity: 'warning', path: t.path, ...where, message: `Caption needs ${t.lines} lines.`, hint: 'Lower theme.captions.maxChars or raise maxWidth.' })
        // contrast: 20th percentile over the sampled background points
        // semi-transparent text is blended with what lies behind it
        const [r0, g0, b0, a0] = colors[i]
        const alpha = a0 / 255
        const ratios = samples[i]
          .map((bg) => contrast(luminance([r0, g0, b0].map((c, k) => alpha * c + (1 - alpha) * bg[k])), luminance(bg)))
          .sort((a, b) => a - b)
        const ratio = ratios[Math.floor(ratios.length * 0.2)]
        const large = t.fontSize >= H * 0.035 || (t.fontSize >= H * 0.028 && t.fontWeight >= 700) || t.fontSize >= 40
        const limit = large ? 3 : 4.5
        if (ratio < limit)
          add({
            code: 'low-contrast',
            severity: ratio < 1.5 ? 'error' : 'warning',
            path: t.path,
            ...where,
            message: `${name}: contrast ${ratio.toFixed(2)}:1 against its background (needs ${limit}:1).`,
            hint: 'Change the text color or give the text a background box (style.background).',
          })
      })
      // overlaps between text boxes
      for (let a = 0; a < texts.length; a++)
        for (let b = a + 1; b < texts.length; b++) {
          const p = texts[a].rect
          const q = texts[b].rect
          const w = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x)
          const h = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y)
          if (w <= 0 || h <= 0) continue
          const share = (w * h) / Math.min(p.width * p.height, q.width * q.height)
          if (share > 0.08)
            add({
              code: 'text-overlap',
              severity: 'warning',
              path: texts[a].path,
              ...where,
              message: `Text "${texts[a].text.slice(0, 25)}" overlaps "${texts[b].text.slice(0, 25)}" (${texts[b].path}).`,
              hint: texts[b].caption || texts[a].caption ? 'Move the layer above the captions or change theme.captions.bottom.' : 'Move one of them or change their timing.',
            })
        }
    }
  } finally {
    await page.close()
  }
  return [...issues.values()]
}
