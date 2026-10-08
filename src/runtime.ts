/**
 * Browser side. Installed into every page before its own scripts run (Playwright init script,
 * or inline by the preview server). Must stay self-contained: it is serialized with toString().
 *
 * Replaces the page's notion of time with a virtual clock that only moves on seek():
 * Date, performance.now, requestAnimationFrame, setTimeout/setInterval, Math.random (seeded),
 * and all CSS/Web Animations (paused, currentTime = composition time).
 */
export interface RuntimeOptions {
  /** Wall-clock time (ms since 1970) that frame 0 corresponds to. */
  epoch: number
  seed: number
  /** Fallback metadata when the page does not define window.videoMaker. */
  defaults: { width?: number; height?: number; fps?: number; frames?: number; duration?: number }
}

export interface Meta {
  width: number
  height: number
  fps: number
  frames: number
}

export interface Driver {
  ready(): Promise<Meta>
  seek(frame: number): Promise<void>
}

export function installRuntime(options: RuntimeOptions): void {
  const w = window as any
  if (w.__videoMakerDriver) return

  const real = {
    setTimeout: window.setTimeout.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    Date: window.Date,
  }
  let now = 0 // virtual ms since frame 0

  // --- Date and performance.now -------------------------------------------------------------
  const RealDate = real.Date
  const VirtualDate = function (this: unknown, ...args: any[]) {
    if (!new.target) return new RealDate(options.epoch + now).toString()
    return args.length === 0 ? new RealDate(options.epoch + now) : new (RealDate as any)(...args)
  } as any
  VirtualDate.prototype = RealDate.prototype
  VirtualDate.now = () => options.epoch + now
  VirtualDate.parse = RealDate.parse
  VirtualDate.UTC = RealDate.UTC
  w.Date = VirtualDate
  Object.defineProperty(performance, 'now', { value: () => now, configurable: true })

  // --- Math.random: seeded (mulberry32) ------------------------------------------------------
  let state = options.seed >>> 0
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let x = Math.imul(state ^ (state >>> 15), 1 | state)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }

  // --- Timers --------------------------------------------------------------------------------
  interface Timer {
    due: number
    fn: Function | string
    args: unknown[]
    every?: number
    order: number
  }
  const timers = new Map<number, Timer>()
  let nextId = 1
  let order = 0
  let flushScheduled = false

  const runTimer = (id: number, t: Timer) => {
    if (t.every !== undefined) t.due += Math.max(1, t.every)
    else timers.delete(id)
    t.order = order++
    if (typeof t.fn === 'function') t.fn(...t.args)
    else (0, eval)(t.fn)
  }
  // Run all timers due up to `until`, in order of due time, moving the clock along.
  const runTimersUntil = (until: number) => {
    for (let guard = 0; guard < 100000; guard++) {
      let pick: [number, Timer] | undefined
      for (const entry of timers) {
        const t = entry[1]
        if (t.due <= until && (!pick || t.due < pick[1].due || (t.due === pick[1].due && t.order < pick[1].order))) pick = entry
      }
      if (!pick) return
      if (pick[1].due > now) now = pick[1].due
      runTimer(pick[0], pick[1])
    }
  }
  // Zero-delay timers still run while the clock stands still, as they would in a browser.
  const scheduleFlush = () => {
    if (flushScheduled) return
    flushScheduled = true
    real.setTimeout(() => {
      flushScheduled = false
      runTimersUntil(now)
    }, 0)
  }
  const addTimer = (fn: Function | string, delay: unknown, args: unknown[], repeat: boolean) => {
    const d = Math.max(0, Number(delay) || 0)
    const id = nextId++
    timers.set(id, { due: now + d, fn, args, every: repeat ? d : undefined, order: order++ })
    if (d === 0) scheduleFlush()
    return id
  }
  w.setTimeout = (fn: Function | string, delay?: number, ...args: unknown[]) => addTimer(fn, delay, args, false)
  w.setInterval = (fn: Function | string, delay?: number, ...args: unknown[]) => addTimer(fn, delay, args, true)
  w.clearTimeout = w.clearInterval = (id: number) => void timers.delete(id)

  // --- requestAnimationFrame -----------------------------------------------------------------
  let rafCallbacks = new Map<number, FrameRequestCallback>()
  w.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextId++
    rafCallbacks.set(id, cb)
    return id
  }
  w.cancelAnimationFrame = (id: number) => void rafCallbacks.delete(id)
  const runAnimationFrame = () => {
    const due = rafCallbacks
    rafCallbacks = new Map()
    for (const cb of due.values()) cb(now)
  }

  // --- CSS animations and Web Animations -----------------------------------------------------
  // Every animation is placed on the composition timeline (currentTime = t); position it in
  // time with animation-delay / delay. Transitions have no defined start and jump to their end.
  const syncAnimations = () => {
    for (const a of document.getAnimations()) {
      if (a.constructor.name === 'CSSTransition') {
        a.finish()
        continue
      }
      a.pause()
      a.currentTime = now
    }
  }

  // --- Readiness -----------------------------------------------------------------------------
  const settle = async () => {
    await document.fonts.ready
    const images = Array.from(document.images).filter((img) => img.src)
    await Promise.all(images.map((img) => img.decode().catch(() => undefined)))
    await new Promise((resolve) => real.requestAnimationFrame(() => resolve(undefined)))
  }

  const definition = () => (w.videoMaker ?? {}) as Record<string, any>
  let meta: Meta | undefined
  let readyPromise: Promise<Meta> | undefined

  const driver: Driver = {
    ready() {
      readyPromise ??= (async () => {
        if (document.readyState !== 'complete') await new Promise((r) => window.addEventListener('load', r, { once: true }))
        const early = definition()
        if (typeof early.ready === 'function') await early.ready()
        else await early.ready
        const def = definition()
        const pick = (key: string) => (options.defaults as Record<string, number | undefined>)[key] ?? def[key]
        const fps = Number(pick('fps'))
        const d = options.defaults
        const frames =
          d.frames ?? (d.duration !== undefined ? Math.round(d.duration * fps) : undefined) ?? def.frames ?? (def.duration !== undefined ? Math.round(def.duration * fps) : NaN)
        meta = { width: Number(pick('width')), height: Number(pick('height')), fps, frames: Number(frames) }
        for (const [key, value] of Object.entries(meta)) {
          if (!(value > 0)) throw new Error(`video-maker: "${key}" is missing – define it in window.videoMaker or pass it as an option`)
        }
        await settle()
        return meta
      })()
      return readyPromise
    },
    async seek(frame: number) {
      const m = await driver.ready()
      const target = (frame * 1000) / m.fps
      runTimersUntil(target)
      now = target
      const def = definition()
      if (typeof def.frame === 'function') await def.frame(frame, { frame, time: target / 1000, fps: m.fps, frames: m.frames })
      runAnimationFrame()
      runTimersUntil(now) // zero-delay timers scheduled by the frame callbacks
      syncAnimations()
      await settle()
    },
  }
  w.__videoMakerDriver = driver
}
