// Board canvas geometry: auto-placing new items, fitting group frames, moving items in and out of frames,
// reading order. Pure and free of `@/` imports: web/tests/canvas-board-layout.test.ts runs it under node.

export type Box = { x: number; y: number; w: number; h: number }
/** Something on the board: `key` is unique, `groupId` the frame it belongs to. */
export type Placed = Box & { key: string; groupId: string | null }
export type Frame = Box & { id: string }

export const GAP = 24
/** Space around a frame's items, and its title row above them. */
export const FRAME_PAD = 12
export const FRAME_TITLE = 36

export function bounds(boxes: Box[]): Box | null {
  if (!boxes.length) return null
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const b of boxes) {
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export const intersects = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const contains = (b: Box, x: number, y: number) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h

/**
 * Positions for new items, in order: masonry columns (each item into the shortest), in a block below everything
 * already placed and lined up with its left edge, or centred on the origin when nothing is placed yet.
 */
export function autoPlace(placed: Box[], sizes: { w: number; h: number }[]): { x: number; y: number }[] {
  if (!sizes.length) return []
  const pitch = Math.max(...sizes.map((s) => s.w)) + GAP
  const cols = Math.min(sizes.length, Math.max(3, Math.min(8, Math.ceil(Math.sqrt(sizes.length * 1.6)))))
  const heights = new Array<number>(cols).fill(0)
  const out = sizes.map((s) => {
    const c = heights.indexOf(Math.min(...heights))
    const at = { x: c * pitch, y: heights[c]! }
    heights[c]! += s.h + GAP
    return at
  })
  const area = bounds(placed)
  const dx = area ? area.x : -(cols * pitch - GAP) / 2
  const dy = area ? area.y + area.h + GAP * 2 : -(Math.max(...heights) - GAP) / 2
  return out.map((p) => ({ x: p.x + dx, y: p.y + dy }))
}

/** A row of items centred on a point (images dropped onto the board). */
export function rowAt(at: { x: number; y: number }, sizes: { w: number; h: number }[]): { x: number; y: number }[] {
  let x = at.x - (sizes.reduce((n, s) => n + s.w, 0) + GAP * (sizes.length - 1)) / 2
  return sizes.map((s) => {
    const p = { x, y: at.y - s.h / 2 }
    x += s.w + GAP
    return p
  })
}

/** The frame around some items: their bounds plus padding, with the title row on top. */
export function fitFrame(boxes: Box[]): Box {
  const b = bounds(boxes) ?? { x: 0, y: 0, w: 0, h: 0 }
  return { x: b.x - FRAME_PAD, y: b.y - FRAME_PAD - FRAME_TITLE, w: b.w + FRAME_PAD * 2, h: b.h + FRAME_PAD * 2 + FRAME_TITLE }
}

/** The topmost (last) frame under a point. */
export const frameAt = <F extends Frame>(frames: F[], x: number, y: number, skip?: Set<string>) =>
  frames.findLast((f) => !skip?.has(f.id) && contains(f, x, y))

/** Positions that keep a selection's relative layout, centred on the origin (a new board's home). */
export function centred(boxes: Box[]): { x: number; y: number }[] {
  const b = bounds(boxes)
  if (!b) return []
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  return boxes.map((p) => ({ x: Math.round(p.x - cx), y: Math.round(p.y - cy) }))
}

/**
 * Move items (`keys`) and frames (`frameIds`, with every item in them) by dx, dy. A moved item that isn't riding
 * along with its frame joins the frame under its centre, or leaves its frame for open canvas. Frames that end up
 * with a moved item grow to fit all their items. Returns everything, plus which items and frames changed.
 */
export function moveOnBoard<T extends Placed, F extends Frame>(items: T[], frames: F[], keys: Set<string>, frameIds: Set<string>, dx: number, dy: number) {
  const changed = new Set<string>()
  const nextItems = items.map((it) => {
    const riding = it.groupId !== null && frameIds.has(it.groupId)
    if (!riding && !keys.has(it.key)) return it
    changed.add(it.key)
    const moved = { ...it, x: it.x + dx, y: it.y + dy }
    if (riding) return moved
    const home = frameAt(frames, moved.x + moved.w / 2, moved.y + moved.h / 2, frameIds)
    return { ...moved, groupId: home?.id ?? null }
  })
  const grow = new Set(nextItems.filter((it) => changed.has(it.key) && it.groupId && !frameIds.has(it.groupId)).map((it) => it.groupId!))
  const changedFrames = new Set<string>()
  const nextFrames = frames.map((f) => {
    if (frameIds.has(f.id)) {
      changedFrames.add(f.id)
      return { ...f, x: f.x + dx, y: f.y + dy }
    }
    if (!grow.has(f.id)) return f
    const fit = bounds([f, fitFrame(nextItems.filter((it) => it.groupId === f.id))])!
    if (fit.x === f.x && fit.y === f.y && fit.w === f.w && fit.h === f.h) return f
    changedFrames.add(f.id)
    return { ...f, ...fit }
  })
  return {
    items: nextItems,
    frames: nextFrames,
    movedItems: nextItems.filter((it) => changed.has(it.key)),
    movedFrames: nextFrames.filter((f) => changedFrames.has(f.id)),
  }
}

/** Top to bottom, left to right: a row is everything whose top lies above the middle of the row's first item. */
export function readingOrder<T extends Box>(boxes: T[]): T[] {
  const byY = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)
  const out: T[] = []
  let row: T[] = []
  for (const b of byY) {
    if (row.length && b.y > row[0]!.y + row[0]!.h / 2) {
      out.push(...row.sort((a, c) => a.x - c.x))
      row = []
    }
    row.push(b)
  }
  return [...out, ...row.sort((a, c) => a.x - c.x)]
}

/** Gap between items laid out in a row (the layer menu's Auto layout). */
export const ROW_GAP = 16

/** One even row: left to right in their current order, ROW_GAP apart, tops on the topmost, from the leftmost. */
export function inRow(boxes: Box[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = new Array(boxes.length)
  if (!boxes.length) return out
  const y = Math.min(...boxes.map((b) => b.y))
  let x = Math.min(...boxes.map((b) => b.x))
  for (const i of boxes.map((_, i) => i).sort((a, b) => boxes[a]!.x - boxes[b]!.x || boxes[a]!.y - boxes[b]!.y)) {
    out[i] = { x, y }
    x += boxes[i]!.w + ROW_GAP
  }
  return out
}

/** Whether boxes already sit at these spots (half a pixel either way). */
export const at = (boxes: Box[], spots: { x: number; y: number }[]) => boxes.every((b, i) => Math.abs(b.x - spots[i]!.x) < 0.5 && Math.abs(b.y - spots[i]!.y) < 0.5)
