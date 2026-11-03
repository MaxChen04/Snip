import assert from "node:assert/strict"
import { test } from "node:test"
import { bounded, decodeCursor, encodeCursor, jsonBytes } from "../worker/mcp-bounds"

test("oversized style values become omissions and pagination still reaches subsequent values", () => {
  const values = [{ value: "data:image/svg+xml," + "a".repeat(1_000_000) }, { value: "red" }]
  const first = bounded(values, 0, 1)
  assert.equal((first.items[0] as { omitted?: boolean }).omitted, true)
  assert.ok(jsonBytes(first.items) <= 24_000)
  assert.equal(first.nextOffset, 1)
  assert.deepEqual(bounded(values, first.nextOffset!, 1).items, [values[1]])
})

test("UTF-8 bytes, punctuation and omission markers all fit within the list budget", () => {
  const values = ["界".repeat(7_850), ...Array(20).fill("x".repeat(25_000)), "last"]
  let offset: number | null = 0
  const seen: unknown[] = []
  while (offset !== null) {
    const page = bounded(values, offset, 200)
    assert.ok(jsonBytes(page.items) <= 24_000)
    assert.ok(page.nextOffset === null || page.nextOffset > offset)
    seen.push(...page.items)
    offset = page.nextOffset
  }
  assert.equal(seen.length, values.length)
  assert.equal(seen.at(-1), "last")
  assert.equal((bounded(["界".repeat(10_000)], 0, 1).items[0] as { omitted?: boolean }).omitted, true)
})

test("summary budgets also replace large token values", () => {
  const page = bounded([{ name: "--image", value: "x".repeat(1_000_000) }], 0, 6, 2_500)
  assert.ok(jsonBytes(page.items) <= 2_500)
  assert.equal((page.items[0] as { omitted?: boolean }).omitted, true)
})

test("cursors retain reference identity and reject invalid offsets or shapes", () => {
  const cursor = { referenceId: "ref1", part: "tokens", group: "colors", offset: 1, rev: "revision" }
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor)
  for (const offset of [-1, 0.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(decodeCursor(btoa(JSON.stringify({ ...cursor, offset }))), null)
  }
  for (const value of [null, [], true, { offset: 0 }, { ...cursor, referenceId: undefined }]) {
    assert.equal(decodeCursor(btoa(JSON.stringify(value))), null)
  }
  assert.equal(decodeCursor("not-base64"), null)
})
