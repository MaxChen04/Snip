const encoder = new TextEncoder()
export const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength

/** Bound the actual UTF-8 JSON array, including commas and omission markers. */
export function bounded<T>(all: T[], offset: number, limit: number, bytes = 24_000, hint = "use the original signed file URL from get_page") {
  const items: (T | { omitted: true; index: number; bytes: number; reason: string })[] = []
  let used = 2 // []
  let taken = 0
  for (let i = offset; i < all.length && taken < limit; i++) {
    const size = jsonBytes(all[i])
    const item = size + 2 > bytes
      ? { omitted: true as const, index: i, bytes: size, reason: `Entry exceeds the response budget; ${hint}.` }
      : all[i]!
    const cost = jsonBytes(item) + (items.length ? 1 : 0)
    if (used + cost > bytes) break
    items.push(item)
    used += cost
    taken++
  }
  const next = offset + taken
  return { items, total: all.length, offset, nextOffset: next < all.length ? next : null }
}

/** `key` is the last row's sort key for parts read from the database a page at a time ("pages", "animations"). */
export type ReferenceCursor = { referenceId: string; part: string; group?: string; offset: number; rev: string; key?: (string | number)[] }
export const encodeCursor = (cursor: ReferenceCursor) => btoa(JSON.stringify(cursor))
export function decodeCursor(value: string | undefined): ReferenceCursor | null {
  if (!value) return null
  try {
    const c = JSON.parse(atob(value))
    if (!c || typeof c !== "object" || Array.isArray(c)
      || typeof c.referenceId !== "string" || typeof c.part !== "string" || typeof c.rev !== "string"
      || (c.group !== undefined && typeof c.group !== "string")
      || !Number.isSafeInteger(c.offset) || c.offset < 0
      || (c.key !== undefined && !(Array.isArray(c.key) && c.key.length <= 3 && c.key.every((v: unknown) => typeof v === "string" || typeof v === "number")))) return null
    return c
  } catch {
    return null
  }
}
