// The design tokens panel: colour labels are read in full, and a value that is not a colour gets no swatch.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { reference, startApp, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

const tokens = (colors: string[]) => ({
  colors: colors.map((value) => ({ value, count: 3 })),
  fonts: [],
  fontSizes: [],
  spacing: [],
  radii: [],
  shadows: [],
  transitions: [],
  keyframes: [],
  cssVariables: {},
})

test("an oklch colour is shown in full under its swatch, and a url() reference is not a swatch at all", async () => {
  const colors = ["oklch(0.2 0.01 250)", "oklch(0.92 0.02 90 / 0.5)", 'url("#paint0_linear")', "#ff8204"]
  const t = await app.session({ state: { references: { ref1: reference({ id: "ref1", tokens: tokens(colors) }) } }, viewport: { width: 1280, height: 900 } })
  const { page } = t
  await t.goto("/r/ref1?tab=tokens")
  await page.getByRole("heading", { name: "Colors" }).waitFor()
  const swatches = page.locator("section", { has: page.getByRole("heading", { name: "Colors" }) }).locator("button")
  assert.equal(await swatches.count(), 3, "only the three real colours are swatches")
  assert.equal(await page.getByText("url(", { exact: false }).count(), 0)

  for (const value of ["oklch(0.2 0.01 250)", "oklch(0.92 0.02 90 / 0.5)"]) {
    const label = swatches.filter({ hasText: value }).locator("div").last()
    // Wrapped, not cut off: its text is the whole value and it does not overflow its box or lose lines to an ellipsis.
    assert.equal((await label.innerText()).replace(/\s+/g, " "), value)
    const overflow = await label.evaluate((el) => ({ over: el.scrollWidth > el.clientWidth, ellipsis: getComputedStyle(el).textOverflow }))
    assert.deepEqual(overflow, { over: false, ellipsis: "clip" })
  }
})
