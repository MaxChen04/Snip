// The one spring for motion the user causes on a canvas: zoom, a pan settling after a release, the edge's rubber band,
// a dragged board item settling. Written as bounce and duration, like every spring in the design system: bounce is the
// only number to change for more or less bounce (0 is none; above .3 it starts to wobble).
// CSS gets the same spring as --spring-ease (a linear() curve) and --spring-duration, set on :root when this loads.

export const SPRING = { bounce: 0.25, duration: 400 }

const omega = (2 * Math.PI) / SPRING.duration
const zeta = 1 - SPRING.bounce

/**
 * Where something on the spring is after dt ms: x is its distance from where it is heading, v its velocity (per ms).
 * Exact for any dt, so a long frame never overshoots further than a short one.
 */
export function springStep(x: number, v: number, dt: number): [number, number] {
  const decay = Math.exp(-zeta * omega * dt)
  if (zeta >= 1) {
    const b = v + omega * x
    return [decay * (x + b * dt), decay * (v - omega * b * dt)]
  }
  const wd = omega * Math.sqrt(1 - zeta * zeta)
  const b = (v + zeta * omega * x) / wd
  const cos = Math.cos(wd * dt)
  const sin = Math.sin(wd * dt)
  return [decay * (x * cos + b * sin), decay * ((b * wd - zeta * omega * x) * cos - (x * wd + zeta * omega * b) * sin)]
}

/** At rest: within a hundredth of a px (or of whatever unit) and barely moving. */
export const settled = (x: number, v: number, unit = 1) => Math.abs(x) < 0.01 * unit && Math.abs(v) < 0.001 * unit

if (typeof document !== "undefined") {
  const points: string[] = []
  for (let i = 0; i <= 40; i++) points.push(String(Math.round((1 + springStep(-1, 0, (SPRING.duration * i) / 40)[0]) * 1000) / 1000))
  points[points.length - 1] = "1"
  document.documentElement.style.setProperty("--spring-ease", `linear(${points.join(", ")})`)
  document.documentElement.style.setProperty("--spring-duration", `${SPRING.duration}ms`)
}
