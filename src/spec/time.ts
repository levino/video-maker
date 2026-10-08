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

/**
 * Expressions over time references: + - * / ( ), mix(a, b, t) = a + (b - a) · t, min(…), max(…).
 * Example: "mix(sentence:2, sentence:3, 0.3)", "(voiceEnd - voice) / 2". Words with spaces need quotes.
 */
function evaluate(text: string, ctx: TimeContext, path: string, issues: Issue[]): number {
  let pos = 0
  const fail = (message: string): never => {
    throw Object.assign(new Error(message), { expression: true })
  }
  const skip = () => {
    while (text[pos] === ' ') pos++
  }
  const peek = () => (skip(), text[pos])
  const expect = (ch: string) => (peek() === ch ? pos++ : fail(`expected "${ch}" at position ${pos + 1}`))
  const atom = (): number => {
    const c = peek()
    if (c === '(') {
      pos++
      const v = sum()
      expect(')')
      return v
    }
    if (c === '-') {
      pos++
      return -atom()
    }
    const fn = /^(mix|min|max)\s*\(/.exec(text.slice(pos))
    if (fn) {
      pos += fn[0].length
      const args = [sum()]
      while (peek() === ',') {
        pos++
        args.push(sum())
      }
      expect(')')
      if (fn[1] === 'mix') {
        if (args.length !== 3) fail('mix(a, b, t) needs three arguments')
        return args[0] + (args[1] - args[0]) * args[2]
      }
      return fn[1] === 'min' ? Math.min(...args) : Math.max(...args)
    }
    // a single reference or number: up to the next operator outside quotes
    const m = /^(word:\s*"[^"]*"|[^\s+\-*/(),][^\s+*/(),]*?)(?=\s*(?:[+*/(),]|-(?=[\s\d.(])|$))/.exec(text.slice(pos))
    if (!m) fail(`cannot read a time at position ${pos + 1}`)
    pos += m![0].length
    const sub: Issue[] = []
    const v = resolveTime(m![1], ctx, path, sub)
    if (sub.length) fail(sub[0].message)
    return v
  }
  const product = (): number => {
    let v = atom()
    for (let c = peek(); c === '*' || c === '/'; c = peek()) {
      pos++
      v = c === '*' ? v * atom() : v / atom()
    }
    return v
  }
  const sum = (): number => {
    let v = product()
    for (let c = peek(); c === '+' || c === '-'; c = peek()) {
      pos++
      v = c === '+' ? v + product() : v - product()
    }
    return v
  }
  try {
    const v = sum()
    if (peek() !== undefined) fail(`unexpected "${text.slice(pos)}"`)
    return v
  } catch (e) {
    if (!(e as { expression?: boolean }).expression) throw e
    issues.push({
      code: 'invalid-time',
      severity: 'error',
      path,
      message: `Cannot evaluate "${text}": ${(e as Error).message}.`,
      hint: 'Expressions: + - * / ( ), mix(a, b, t), min(…), max(…) over references like sentence:2 or word:"zwei Wörter".',
    })
    return 0
  }
}

const isExpression = (text: string) => /[()*/,]/.test(text.replace(/word:\s*"[^"]*"/g, ''))

/** Resolve a time reference to seconds; pushes an issue and returns 0 when it cannot. */
export function resolveTime(ref: TimeRef, ctx: TimeContext, path: string, issues: Issue[]): number {
  if (typeof ref === 'number') return ref
  let text = ref.trim()
  if (isExpression(text)) return evaluate(text, ctx, path, issues)
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
      let t = ctx.word(arg)
      // unquoted word with offset: "word:Brücke+10f"
      const o = quoted ? null : offsetRe.exec(arg)
      if (t === undefined && o && o.index > 0) {
        t = ctx.word(arg.slice(0, o.index).trim())
        if (t !== undefined) return t + seconds(o[1], o[2], ctx.fps)
      }
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
