/** JSON Schema (draft-07) of the video description. Printed by `video-maker schema`. */

const timeRef = {
  description:
    'Seconds (number) or reference: "2.5s", "45f", "start", "end", "voice", "voiceEnd", "sentence:N", "word:<text>", globally "scene:<id>", "scene:<id>.end"; optional offset "+0.5", "-10f".',
  type: ['number', 'string'],
}
const length = { description: 'Pixels (number) or percent of the frame: "50%".', type: ['number', 'string'] }
const ease = {
  description: 'Easing: linear, in, out, inOut (cubic), inQuad, outQuad, inOutQuad, inCubic, outCubic, inOutCubic, inSine, outSine, inOutSine, inExpo, outExpo, inOutExpo, inBack, outBack, spring.',
  type: 'string',
}
const color = { description: 'CSS color or a name from theme.colors.', type: 'string' }
const keyframes = {
  type: 'array',
  minItems: 1,
  items: {
    anyOf: [
      { type: 'array', items: [timeRef, { type: 'number' }], minItems: 2, maxItems: 2 },
      { type: 'object', additionalProperties: false, required: ['t', 'v'], properties: { t: timeRef, v: { type: 'number' }, ease } },
    ],
  },
}
const motionType = { enum: ['none', 'fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'scale', 'pop', 'wipe', 'grow-x', 'grow-y', 'blur', 'draw'] }
const motion = {
  description: 'Enter/exit animation: a type name or {type, duration, ease, distance}.',
  anyOf: [
    motionType,
    {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: { type: motionType, duration: { type: 'number', minimum: 0, description: 'Seconds (default 0.4).' }, ease, distance: { type: 'number' } },
    },
  ],
}
const placement = { enum: ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] }

const textStyleProps = {
  preset: { type: 'string', description: 'Start from theme.styles[preset].' },
  font: { type: 'string', description: 'Name in theme.fonts or a CSS font-family.' },
  size: { type: 'number', exclusiveMinimum: 0 },
  weight: { type: 'number' },
  color,
  italic: { type: 'boolean' },
  stretch: { type: 'number', description: 'Font stretch in percent.' },
  lineHeight: { type: 'number' },
  letterSpacing: { type: 'number' },
  uppercase: { type: 'boolean' },
  align: { enum: ['left', 'center', 'right'] },
  background: color,
  borderColor: color,
  borderWidth: { type: 'number' },
  radius: { type: 'number' },
  padding: { anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }] },
  shadow: { type: 'string', description: 'CSS text-shadow.' },
  strike: { type: 'boolean', description: 'Strike-through.' },
}
const textStyle = { type: 'object', additionalProperties: false, properties: textStyleProps }
const styleRef = { description: 'Name in theme.styles or a style object.', anyOf: [{ type: 'string' }, { $ref: '#/definitions/textStyle' }] }

const layerBase = {
  id: { type: 'string' },
  x: length,
  y: length,
  width: length,
  height: length,
  anchor: { ...placement, description: 'Point of the layer placed at x/y (default top-left).' },
  place: { ...placement, description: 'Place inside the safe area (overrides x/y/anchor).' },
  rotate: { type: 'number', description: 'Degrees.' },
  scale: { type: 'number' },
  opacity: { type: 'number', minimum: 0, maximum: 1 },
  at: { ...timeRef, description: 'Appears at (default: scene start). ' + timeRef.description },
  until: { ...timeRef, description: 'Disappears at (default: scene end).' },
  enter: motion,
  exit: motion,
  animate: {
    type: 'object',
    description: 'Keyframes per property: [[time, value], …] or [{t, v, ease}, …]. x/y/width/height in px, rotate in degrees, draw 0..1 (svg strokes).',
    additionalProperties: false,
    properties: Object.fromEntries(['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate', 'opacity', 'width', 'height', 'blur', 'draw'].map((p) => [p, keyframes])),
  },
  only: { type: 'array', items: { type: 'string' }, description: 'Only in these formats.' },
  formats: { type: 'object', description: 'Per-format overrides merged into this layer.', additionalProperties: { type: 'object' } },
}
const layer = (type: string, required: string[], props: Record<string, unknown>, description: string) => ({
  type: 'object',
  description,
  additionalProperties: false,
  required: ['type', ...required],
  properties: { type: { const: type }, ...layerBase, ...props },
})

const audio = {
  type: 'object',
  additionalProperties: false,
  required: ['file'],
  properties: {
    file: { type: 'string' },
    start: timeRef,
    end: { ...timeRef, description: 'Cut the track here.' },
    volume: { description: 'Gain or keyframes [[time, gain], …] (times like start).', anyOf: [{ type: 'number', minimum: 0 }, keyframes] },
    offset: { type: 'number', minimum: 0, description: 'Skip seconds at the start of the file.' },
    fadeIn: { type: 'number', minimum: 0 },
    fadeOut: { type: 'number', minimum: 0 },
  },
}
const transitionType = { enum: ['cut', 'fade', 'slide-left', 'slide-up', 'wipe', 'zoom'] }
const transition = {
  anyOf: [
    transitionType,
    {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: transitionType,
        duration: { type: 'number', minimum: 0, description: 'Seconds (default 0.3).' },
        overlap: { type: 'boolean', description: 'Cross-fade over the previous scene instead of fading in from the background.' },
      },
    },
  ],
}
const voiceProps = {
  lead: { type: 'number', minimum: 0, description: 'Seconds before the voice starts (default 0.25).' },
  tail: { type: 'number', minimum: 0, description: 'Seconds after the voice ends (default 0.6).' },
  volume: { type: 'number', minimum: 0 },
  fadeIn: { type: 'number', minimum: 0 },
  fadeOut: { type: 'number', minimum: 0 },
  pauses: {
    description: 'Pause positions in the file (seconds) for caption timing; "detect" (default) finds them with ffmpeg; "none".',
    anyOf: [{ type: 'array', items: { type: 'number' } }, { enum: ['detect', 'none'] }],
  },
}
const cue = { type: 'object', additionalProperties: false, required: ['start', 'end', 'text'], properties: { start: timeRef, end: timeRef, text: { type: 'string' } } }

export const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://github.com/levino/video-maker/schema.json',
  title: 'video-maker video description',
  type: 'object',
  additionalProperties: false,
  required: ['formats', 'scenes'],
  definitions: {
    textStyle,
    layer: {
      type: 'object',
      required: ['type'],
      discriminator: { propertyName: 'type' },
      oneOf: [
        layer('text', ['text'], { text: { type: 'string', description: 'Line breaks with \\n.' }, style: styleRef }, 'Text block. Wraps inside width.'),
        layer(
          'counter',
          ['to'],
          {
            from: { type: 'number' },
            to: { type: 'number' },
            start: timeRef,
            end: timeRef,
            ease,
            decimals: { type: 'integer', minimum: 0 },
            locale: { type: 'string', description: 'Number format, default de-DE.' },
            prefix: { type: 'string' },
            suffix: { type: 'string' },
            style: styleRef,
          },
          'Number counting from `from` to `to` between start and end.',
        ),
        layer(
          'image',
          ['src'],
          {
            src: { type: 'string' },
            fit: { enum: ['cover', 'contain'] },
            camera: {
              type: 'object',
              description: 'Camera move: zoom and focus (x/y 0..1) from → to.',
              additionalProperties: false,
              properties: {
                from: { $ref: '#/definitions/camera' },
                to: { $ref: '#/definitions/camera' },
                start: timeRef,
                end: timeRef,
                ease,
              },
            },
          },
          'Image, full frame unless x/y/width/height are set.',
        ),
        layer('rect', [], { color, radius: length, borderColor: color, borderWidth: { type: 'number' } }, 'Rectangle (bars, boxes, circles with radius "50%").'),
        layer('svg', [], { src: { type: 'string' }, markup: { type: 'string' } }, 'SVG from file or inline markup, scaled to width/height.'),
        layer('group', ['layers'], { layers: { type: 'array', items: { $ref: '#/definitions/layer' } } }, 'Group: children are positioned in the group box and move with it.'),
        layer(
          'custom',
          ['module'],
          {
            module: { type: 'string', description: 'ES module path; default export (element, props, context) => (t, info) => void.' },
            props: { type: 'object' },
            times: { type: 'object', description: 'Named time references, resolved to seconds from scene start and passed as context.times.', additionalProperties: timeRef },
          },
          'Escape hatch: own HTML/SVG/JS drawn by a module, updated every frame with scene time t (seconds).',
        ),
      ],
    },
    camera: { type: 'object', additionalProperties: false, properties: { zoom: { type: 'number', exclusiveMinimum: 0 }, x: { type: 'number' }, y: { type: 'number' } } },
  },
  properties: {
    $schema: { type: 'string' },
    fps: { type: 'number', exclusiveMinimum: 0, description: 'Frames per second (default 30).' },
    formats: {
      type: 'object',
      description: 'Output formats by name, e.g. {"landscape": {"width": 1920, "height": 1080}, "portrait": {"width": 1080, "height": 1920}}.',
      minProperties: 1,
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['width', 'height'],
        properties: { width: { type: 'integer', minimum: 2 }, height: { type: 'integer', minimum: 2 } },
      },
    },
    theme: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fonts: {
          type: 'object',
          description:
            'Font files by name: {"Archivo": {"src": "fonts/archivo.woff2", "weight": "100 900"}}. Several weights/styles of one family: different keys with the same "family".',
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            required: ['src'],
            properties: {
              src: { type: 'string' },
              family: { type: 'string', description: 'CSS family name (default: the key).' },
              weight: { type: 'string' },
              style: { type: 'string' },
              stretch: { type: 'string' },
            },
          },
        },
        colors: { type: 'object', description: 'Named colors usable wherever a color is expected.', additionalProperties: { type: 'string' } },
        background: color,
        text: { $ref: '#/definitions/textStyle' },
        styles: { type: 'object', description: 'Named text styles for `style: "<name>"`.', additionalProperties: { $ref: '#/definitions/textStyle' } },
        captions: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...textStyleProps,
            bottom: { type: 'number' },
            maxWidth: { type: 'number' },
            maxChars: { type: 'integer', minimum: 10, description: 'Split longer sentences (default 80).' },
            maxCps: { type: 'number', description: 'Reading speed limit for checks, characters/second (default 20).' },
            fade: { type: 'number', minimum: 0 },
          },
        },
        safeArea: { type: 'number', minimum: 0, maximum: 0.4, description: 'Safe margin per side as fraction (default 0.05).' },
      },
    },
    defaults: {
      type: 'object',
      additionalProperties: false,
      properties: {
        voice: { type: 'object', additionalProperties: false, properties: voiceProps },
        transition,
        enter: motion,
        exit: motion,
      },
    },
    audio: { type: 'array', description: 'Tracks over the whole video (times global).', items: audio },
    overlays: { type: 'array', description: 'Layers over the whole video (times global).', items: { $ref: '#/definitions/layer' } },
    scenes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
          duration: { description: 'Seconds or "auto" (lead + voice + tail).', anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { const: 'auto' }] },
          voice: { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: false, required: ['file'], properties: { file: { type: 'string' }, ...voiceProps } }] },
          script: { type: 'string', description: 'Spoken text; captions and sentence:/word: references come from it.' },
          captions: { anyOf: [{ type: 'boolean' }, { type: 'string', description: '.srt or .vtt file' }, { type: 'array', items: cue }] },
          background: color,
          transition,
          audio: { type: 'array', description: 'Tracks with scene-local times.', items: audio },
          layers: { type: 'array', items: { $ref: '#/definitions/layer' } },
          only: { type: 'array', items: { type: 'string' } },
          formats: { type: 'object', additionalProperties: { type: 'object' } },
        },
      },
    },
  },
} as const
