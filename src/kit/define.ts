export interface FrameInfo {
  frame: number
  /** Seconds since start. */
  time: number
  fps: number
  frames: number
}

/** What a composition page publishes as `window.videoMaker`. */
export interface VideoDefinition {
  width?: number
  height?: number
  fps?: number
  /** Length in frames … */
  frames?: number
  /** … or in seconds. */
  duration?: number
  /** Awaited once before the first frame (fonts, data, images). */
  ready?: Promise<unknown> | (() => unknown)
  /** Bring the page into the state of this frame. May be async. */
  frame?: (frame: number, info: FrameInfo) => unknown
}

/** Registers the composition for the renderer and returns it unchanged. */
export function defineVideo<T extends VideoDefinition>(definition: T): T {
  if (typeof window !== 'undefined') (window as unknown as { videoMaker: T }).videoMaker = definition
  return definition
}
