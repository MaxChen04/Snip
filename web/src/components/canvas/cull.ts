// Which part of the world a canvas keeps mounted. Pure and free of `@/` imports: web/tests/canvas-cull.test.ts runs it under node.

/** A rectangle in world px. */
export type Rect = { x: number; y: number; w: number; h: number }

/** Below this zoom a tiled canvas (see InfiniteCanvas) is far out: its tiles are a few dozen px wide. */
export const FAR_ZOOM = 0.5

/**
 * The visible world rect plus a margin, snapped outward to a grid, so children re-render only when it crosses a grid
 * line. The grid is about 256 screen px wide and the margin a quarter of the screen. For `tiled` canvases (many light
 * tiles that mount as the view moves) both are about half that below FAR_ZOOM: the rect grows with 1/zoom^2, so at 25%
 * that margin and grid mount about twice the tiles that are on screen. Other canvases keep the same rect at every
 * zoom, because a few hundred heavy items cost more to mount again than to keep. `tx`, `ty` and `k` are the world's
 * translation and zoom; `w` and `h` the viewport's size in screen px.
 */
export function cullRect({ tx, ty, k, w, h }: { tx: number; ty: number; k: number; w: number; h: number }, tiled = false): Rect {
  const far = tiled && k < FAR_ZOOM
  const step = (far ? 128 : 256) * 2 ** Math.max(0, Math.round(Math.log2(1 / k)))
  const m = (Math.max(w, h) * (far ? 0.12 : 0.25)) / k
  const x = Math.floor((-tx / k - m) / step) * step
  const y = Math.floor((-ty / k - m) / step) * step
  return { x, y, w: Math.ceil(((w - tx) / k + m) / step) * step - x, h: Math.ceil(((h - ty) / k + m) / step) * step - y }
}
