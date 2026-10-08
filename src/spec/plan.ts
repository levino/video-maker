/** Fully resolved description for one format, consumed by the browser player. Frames, pixels, CSS. */
import type { MotionType } from './types.js'

export type Css = Record<string, string | number>

export interface PlanMotion {
  type: MotionType
  frames: number
  ease: string
  distance: number
}

export interface PlanKey {
  f: number
  v: number
  ease?: string
}

export interface PlanLayer {
  path: string
  id?: string
  type: 'text' | 'counter' | 'image' | 'rect' | 'svg' | 'group' | 'custom' | 'qr'
  x: number
  y: number
  width?: number
  height?: number
  /** Fraction of the layer box placed at x/y. */
  anchor: [number, number]
  /** Vertical anchor is the first text baseline instead of anchor[1]. */
  baseline?: boolean
  split?: 'chars' | 'words'
  staggerFrames?: number
  params?: Record<string, PlanKey[]>
  maxWidth?: number
  rotate: number
  scale: number
  opacity: number
  /** Frames relative to the scene start (overlays: to the video start). */
  at: number
  until: number
  enter?: PlanMotion
  exit?: PlanMotion
  animate: Record<string, PlanKey[]>
  text?: string
  css?: Css
  counter?: { from: number; to: number; start: number; end: number; ease: string; format: Intl.NumberFormatOptions; locale: string; prefix: string; suffix: string }
  src?: string
  fit?: 'cover' | 'contain'
  camera?: { from: { zoom: number; x: number; y: number }; to: { zoom: number; x: number; y: number }; start: number; end: number; ease: string }
  markup?: string
  layers?: PlanLayer[]
  module?: string
  props?: Record<string, unknown>
  /** Resolved custom times, seconds from scene start. */
  times?: Record<string, number>
}

export interface PlanScene {
  id: string
  path: string
  start: number
  frames: number
  transition: { type: string; frames: number; overlap: boolean }
  background: string
  layers: PlanLayer[]
  /** Voice start/end in frames relative to the scene (for custom modules). */
  voice?: { start: number; end: number }
  sentences: number[]
}

export interface PlanCue {
  start: number
  end: number
  text: string
  path: string
  scene: string
}

export interface Plan {
  format: string
  width: number
  height: number
  fps: number
  frames: number
  background: string
  safe: { x: number; y: number }
  fonts: { family: string; src: string; weight?: string; style?: string; stretch?: string }[]
  scenes: PlanScene[]
  overlays: PlanLayer[]
  captions: { css: Css; bottom: number; maxWidth: number; fadeFrames: number; cues: PlanCue[] }
}
