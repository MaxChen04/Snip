import assert from "node:assert/strict"
import { test } from "node:test"
import { pageText, TEXT_LIMITS } from "../src/text"

test("page text is read in page order, deduplicated, and split by section", () => {
  const blocks = [
    { y: 700, t: "Starter $12" },
    { y: 10, t: "Pricing" },
    { y: 120, t: "Simple pricing" },
    { y: 1300, t: "pricing" }, // the footer link repeats the nav item
  ]
  const text = pageText(blocks, [{ y: 0, height: 600 }, { y: 600, height: 600 }, { y: 1200, height: 200 }])
  assert.equal(text.body, "Pricing\nSimple pricing\nStarter $12")
  assert.deepEqual(text.sections, ["Pricing\nSimple pricing", "Starter $12", "pricing"])
})

test("page text stays within the Worker's caps", () => {
  const blocks = Array.from({ length: 2000 }, (_, i) => ({ y: i, t: `line ${i} `.repeat(10) }))
  const text = pageText(blocks, [{ y: 0, height: 5000 }])
  assert.ok(text.body.length <= TEXT_LIMITS.body)
  assert.ok(text.sections![0]!.length <= TEXT_LIMITS.section)
})
