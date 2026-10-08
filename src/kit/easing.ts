/** An easing maps progress 0..1 to eased progress (usually 0..1, may overshoot). */
export type EaseFn = (p: number) => number

const out = (e: EaseFn): EaseFn => (p) => 1 - e(1 - p)
const inOut = (e: EaseFn): EaseFn => (p) => (p < 0.5 ? e(p * 2) / 2 : 1 - e((1 - p) * 2) / 2)
const power = (n: number): EaseFn => (p) => p ** n
const sine: EaseFn = (p) => 1 - Math.cos((p * Math.PI) / 2)
const expo: EaseFn = (p) => (p <= 0 ? 0 : 2 ** (10 * p - 10))
const back: EaseFn = (p) => p * p * (2.70158 * p - 1.70158)

export const ease = {
  linear: ((p) => p) as EaseFn,
  inQuad: power(2),
  outQuad: out(power(2)),
  inOutQuad: inOut(power(2)),
  inCubic: power(3),
  outCubic: out(power(3)),
  inOutCubic: inOut(power(3)),
  inSine: sine,
  outSine: out(sine),
  inOutSine: inOut(sine),
  inExpo: expo,
  outExpo: out(expo),
  inOutExpo: inOut(expo),
  inBack: back,
  outBack: out(back),
  /** Build in-out and out variants from any "in" easing. */
  out,
  inOut,
}

/** CSS-style cubic-bezier(x1, y1, x2, y2). Solves x(t) = p by bisection, then returns y(t). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  const coord = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3
  return (p) => {
    if (p <= 0) return 0
    if (p >= 1) return 1
    let lo = 0
    let hi = 1
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (coord(mid, x1, x2) < p) lo = mid
      else hi = mid
    }
    return coord((lo + hi) / 2, y1, y2)
  }
}

/** Staircase easing with n equal steps, value jumps at the end of each step. */
export const steps =
  (n: number): EaseFn =>
  (p) =>
    p >= 1 ? 1 : Math.floor(p * n) / n
