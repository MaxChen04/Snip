// Which part of the world a canvas keeps mounted. Pure and free of `@/` imports: web/tests/canvas-cull.test.ts runs it under node.

/** A rectangle in world px. */
export type Rect = { x: number; y: number; w: number; h: number }

/**
 * Below this zoom the world layer carries a `data-far` attribute (so CSS can drop detail nobody can see at this size)
 * and the mounted rect hugs the screen. It grows with 1/zoom^2, so a quarter-screen margin that is cheap at 100% is
 * more than half of the tiles mounted at 25%.
 */
export const FAR_ZOOM = 0.5

/**
 * The visible world rect plus a margin, snapped outward to a grid, so children re-render only when it crosses a grid
 * line. The grid is about 256 screen px wide and the margin a quarter of the screen; far out (FAR_ZOOM) both are about
 * half that. `tx`, `ty` and `k` are the world's translation and zoom; `w` and `h` the viewport's size in screen px.
 */
export function cullRect({ tx, ty, k, w, h }: { tx: number; ty: number; k: number; w: number; h: number }): Rect {
  const far = k < FAR_ZOOM
  const step = (far ? 128 : 256) * 2 ** Math.max(0, Math.round(Math.log2(1 / k)))
  const m = (Math.max(w, h) * (far ? 0.12 : 0.25)) / k
  const x = Math.floor((-tx / k - m) / step) * step
  const y = Math.floor((-ty / k - m) / step) * step
  return { x, y, w: Math.ceil(((w - tx) / k + m) / step) * step - x, h: Math.ceil(((h - ty) / k + m) / step) * step - y }
}
