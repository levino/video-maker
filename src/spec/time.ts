import type { Issue } from '../errors.js'
import type { TimeRef } from './types.js'

/** What a time reference can point at, in seconds relative to the current context. */
export interface TimeContext {
  fps: number
  /** Context length (scene or video), seconds. */
  end: number
  voice?: { start: number; end: number }
  sentences?: number[]
  /** Seconds at which a word sequence is spoken, or undefined. */
  word?: (text: string) => number | undefined
  /** Start and end of a scene relative to this context. */
  scene: (id: string) => { start: number; end: number } | undefined
  sceneIds: string[]
  scriptHint?: string
}

const offsetRe = /([+-]\s*\d+(?:\.\d+)?)\s*(s|f|ms)?$/

function seconds(value: string, unit: string | undefined, fps: number) {
  const n = Number(value.replace(/\s/g, ''))
  return unit === 'f' ? n / fps : unit === 'ms' ? n / 1000 : n
}

/** Resolve a time reference to seconds; pushes an issue and returns 0 when it cannot. */
export function resolveTime(ref: TimeRef, ctx: TimeContext, path: string, issues: Issue[]): number {
  if (typeof ref === 'number') return ref
  let text = ref.trim()
  const plain = /^(\d+(?:\.\d+)?)\s*(s|f|ms)?$/.exec(text)
  if (plain) return seconds(plain[1], plain[2], ctx.fps)

  let offset = 0
  const quoted = /^word:\s*"([^"]*)"(.*)$/.exec(text)
  let base = text
  if (quoted) {
    base = `word:${quoted[1]}`
    const o = offsetRe.exec(quoted[2].trim())
    if (o) offset = seconds(o[1], o[2], ctx.fps)
  } else {
    const o = offsetRe.exec(text)
    if (o && o.index > 0 && !/^word:/.test(text)) {
      offset = seconds(o[1], o[2], ctx.fps)
      base = text.slice(0, o.index).trim()
    }
  }

  const fail = (message: string, hint: string) => {
    issues.push({ code: 'invalid-time', severity: 'error', path, message, hint })
    return 0
  }
  const [kind, arg = ''] = base.split(/:(.*)/s)
  switch (kind) {
    case 'start':
      return offset
    case 'end':
      return ctx.end + offset
    case 'voice':
    case 'voiceEnd':
      if (!ctx.voice) return fail(`"${kind}" needs a voice in this scene.`, 'Add "voice" to the scene or use seconds.')
      return (kind === 'voice' ? ctx.voice.start : ctx.voice.end) + offset
    case 'sentence': {
      const n = Number(arg)
      if (!ctx.sentences?.length) return fail(`"${base}" needs a script in this scene.`, 'Add "script" to the scene or use seconds.')
      if (!Number.isInteger(n) || n < 1 || n > ctx.sentences.length)
        return fail(`Sentence ${arg} does not exist.`, `The script has ${ctx.sentences.length} sentence(s): use sentence:1 … sentence:${ctx.sentences.length}.`)
      return ctx.sentences[n - 1] + offset
    }
    case 'word': {
      if (!ctx.word) return fail(`"${base}" needs a script in this scene.`, 'Add "script" to the scene or use seconds.')
      const t = ctx.word(arg)
      if (t === undefined) return fail(`"${arg}" does not occur in the script.`, `Use a word sequence copied from the script${ctx.scriptHint ? `: "${ctx.scriptHint}"` : ''}.`)
      return t + offset
    }
    case 'scene': {
      const [id, edge] = arg.split(/\.(?=(?:start|end)$)/)
      const scene = ctx.scene(id)
      if (!scene) return fail(`Unknown scene "${id}".`, `Known scenes: ${ctx.sceneIds.join(', ')}.`)
      return (edge === 'end' ? scene.end : scene.start) + offset
    }
    default:
      return fail(
        `Cannot read time "${ref}".`,
        'Use seconds (2.5, "2.5s", "45f") or start, end, voice, voiceEnd, sentence:N, word:<text>, scene:<id>[.end], each with optional offset like "+0.5".',
      )
  }
}
