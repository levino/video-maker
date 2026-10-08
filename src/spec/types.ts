/**
 * Declarative video description ("spec"). Times are seconds or time references (see TimeRef).
 * Keep in sync with schema.ts.
 */

/**
 * Seconds as number, or a string:
 * - "2.5", "2.5s", "45f" (frames)
 * - in a scene: "start", "end", "voice", "voiceEnd", "sentence:N" (N from 1), "word:<text>"
 * - globally: "start", "end", "scene:<id>", "scene:<id>.end"
 * each optionally followed by an offset: "sentence:2+0.5", "end-1s", "voice+10f"
 */
export type TimeRef = number | string

/** Pixels, or percent of the frame width (x, width) / height (y, height): "50%". */
export type Length = number | string

export type EaseName = string

export type Keyframe = [TimeRef, number] | { t: TimeRef; v: number; ease?: EaseName }

export interface Format {
  width: number
  height: number
}

export interface FontSpec {
  src: string
  /** CSS family name (default: the key). Several entries may share a family with different weight/style. */
  family?: string
  weight?: string
  style?: string
  stretch?: string
}

export interface TextStyle {
  /** Name of a style in theme.styles to start from. */
  preset?: string
  /** Name in theme.fonts or any CSS font-family. */
  font?: string
  size?: number
  weight?: number
  color?: string
  italic?: boolean
  /** Font stretch in percent, e.g. 85. */
  stretch?: number
  lineHeight?: number
  letterSpacing?: number
  uppercase?: boolean
  align?: 'left' | 'center' | 'right'
  /** Box behind the text. */
  background?: string
  borderColor?: string
  borderWidth?: number
  radius?: number
  padding?: number | [number, number]
  shadow?: string
  strike?: boolean
}

export interface CaptionStyle extends TextStyle {
  /** Distance of the caption box from the bottom edge, px. */
  bottom?: number
  maxWidth?: number
  /** Longer sentences are split (default 80). */
  maxChars?: number
  /** Check: characters per second above this are reported (default 20). */
  maxCps?: number
  /** Fade in seconds (default 0.12). */
  fade?: number
}

export interface Theme {
  fonts?: Record<string, FontSpec>
  colors?: Record<string, string>
  background?: string
  text?: TextStyle
  styles?: Record<string, TextStyle>
  captions?: CaptionStyle
  /** Safe margin as fraction of width/height per side (default 0.05). */
  safeArea?: number
}

export type MotionType =
  | 'none'
  | 'fade'
  | 'slide-up'
  | 'slide-down'
  | 'slide-left'
  | 'slide-right'
  | 'scale'
  | 'pop'
  | 'wipe'
  | 'grow-x'
  | 'grow-y'
  | 'blur'
  | 'draw'

export interface Motion {
  type: MotionType
  duration?: number
  ease?: EaseName
  /** Slide distance px (default 60). */
  distance?: number
}

export type Placement = 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** draw: 0..1 share of the strokes of an svg layer that is drawn. */
export type AnimatableProp = 'x' | 'y' | 'scale' | 'scaleX' | 'scaleY' | 'rotate' | 'opacity' | 'width' | 'height' | 'blur' | 'draw'

interface LayerBase {
  id?: string
  x?: Length
  y?: Length
  width?: Length
  height?: Length
  /** Which point of the layer sits at x/y (default top-left). */
  anchor?: Placement
  /** Place inside the safe area instead of x/y. */
  place?: Placement
  rotate?: number
  scale?: number
  opacity?: number
  /** Default: scene start (overlays: video start). */
  at?: TimeRef
  /** Default: scene end (overlays: video end). */
  until?: TimeRef
  enter?: Motion | MotionType
  exit?: Motion | MotionType
  animate?: Partial<Record<AnimatableProp, Keyframe[]>>
  /** Only include in these formats. */
  only?: string[]
  /** Per-format overrides, merged into this layer. */
  formats?: Record<string, Partial<Layer>>
}

export interface TextLayer extends LayerBase {
  type: 'text'
  text: string
  style?: string | TextStyle
}

export interface CounterLayer extends LayerBase {
  type: 'counter'
  from?: number
  to: number
  /** Counting runs from `start` to `end` (default: at … at+1s). */
  start?: TimeRef
  end?: TimeRef
  ease?: EaseName
  decimals?: number
  locale?: string
  prefix?: string
  suffix?: string
  style?: string | TextStyle
}

export interface ImageLayer extends LayerBase {
  type: 'image'
  src: string
  fit?: 'cover' | 'contain'
  /** Ken Burns: zoom and focus point (0..1) move from `from` to `to`. */
  camera?: { from?: CameraPosition; to?: CameraPosition; start?: TimeRef; end?: TimeRef; ease?: EaseName }
}

export interface CameraPosition {
  zoom?: number
  x?: number
  y?: number
}

export interface RectLayer extends LayerBase {
  type: 'rect'
  color?: string
  radius?: Length
  borderColor?: string
  borderWidth?: number
}

export interface SvgLayer extends LayerBase {
  type: 'svg'
  src?: string
  markup?: string
}

export interface GroupLayer extends LayerBase {
  type: 'group'
  layers: Layer[]
}

export interface CustomLayer extends LayerBase {
  type: 'custom'
  /** ES module (relative to the description file) exporting default (element, props, context) => update(t, info). */
  module: string
  props?: Record<string, unknown>
  /** Named time references, passed resolved (seconds from scene start) as context.times. */
  times?: Record<string, TimeRef>
}

export type Layer = TextLayer | CounterLayer | ImageLayer | RectLayer | SvgLayer | GroupLayer | CustomLayer

export interface Voice {
  file: string
  /** Silence before the voice starts, seconds. */
  lead?: number
  /** Time after the voice ends, seconds. */
  tail?: number
  volume?: number
  fadeIn?: number
  fadeOut?: number
  /** Pause positions (seconds into the file) for caption timing, or "detect" (default). */
  pauses?: number[] | 'detect' | 'none'
}

export interface Cue {
  start: TimeRef
  end: TimeRef
  text: string
}

export interface AudioSpec {
  file: string
  start?: TimeRef
  /** Cut the track at this time. */
  end?: TimeRef
  volume?: number | Keyframe[]
  offset?: number
  fadeIn?: number
  fadeOut?: number
}

export interface Transition {
  type: 'cut' | 'fade' | 'slide-left' | 'slide-up' | 'wipe' | 'zoom'
  duration?: number
  /** Start before the previous scene ends (cross-fade) instead of after it. */
  overlap?: boolean
}

export interface Scene {
  id: string
  /** Seconds, or "auto" = lead + voice + tail (default when a voice is set). */
  duration?: number | 'auto'
  voice?: string | Voice
  /** Spoken text: source of captions and of sentence:/word: time references. */
  script?: string
  /** true (default with script), false, explicit cues, or a .srt/.vtt file. */
  captions?: boolean | Cue[] | string
  background?: string
  transition?: Transition | Transition['type']
  audio?: AudioSpec[]
  layers?: Layer[]
  only?: string[]
  formats?: Record<string, Partial<Pick<Scene, 'background' | 'layers' | 'captions' | 'transition'>>>
}

export interface VideoSpec {
  $schema?: string
  fps?: number
  formats: Record<string, Format>
  theme?: Theme
  defaults?: {
    voice?: Omit<Voice, 'file'>
    transition?: Transition | Transition['type']
    enter?: Motion | MotionType
    exit?: Motion | MotionType
  }
  audio?: AudioSpec[]
  overlays?: Layer[]
  scenes: Scene[]
}
