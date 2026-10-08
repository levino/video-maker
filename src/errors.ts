/** Stable exit codes of the CLI (also reported as `exitCode` in --json output). */
export const exitCodes = {
  ok: 0,
  internal: 1,
  usage: 2,
  invalidSpec: 3,
  missingFile: 4,
  checkFailed: 5,
  renderFailed: 6,
} as const

export type ErrorKind = keyof typeof exitCodes

export interface Issue {
  /** Machine-readable code, e.g. "text-outside-frame". */
  code: string
  severity: 'error' | 'warning'
  message: string
  /** JSON pointer into the video description, e.g. "/scenes/2/layers/0/text". */
  path?: string
  /** Suggested fix. */
  hint?: string
  format?: string
  scene?: string
  frame?: number
  time?: number
}

export class VideoMakerError extends Error {
  constructor(
    public kind: ErrorKind,
    message: string,
    public issues: Issue[] = [],
  ) {
    super(message)
  }
  get exitCode() {
    return exitCodes[this.kind]
  }
}

/** Closest candidate by edit distance, for "did you mean" hints. */
export function closest(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined
  let bestDistance = Infinity
  for (const c of candidates) {
    const d = distance(word.toLowerCase(), c.toLowerCase())
    if (d < bestDistance) [best, bestDistance] = [c, d]
  }
  return bestDistance <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}
