import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { chromium } from "playwright"

const STYLES_JS = readFileSync(new URL("../src/inpage/styles.js", import.meta.url), "utf8")

test("color tokens are colors: a paint server or keyword is dropped, modern color syntax is kept", async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined })
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>
      .brand { background-color: oklch(0.7 0.1 200); color: color(display-p3 1 0 0) } .plain { color: #123456 }
      #grad { fill: url(#paint0_linear); stroke: none } #ctx { fill: context-fill } #cur { fill: currentColor } #hex { fill: #abcdef }
    </style>
    <h1 class="brand">brand</h1><p class="plain">plain</p>
    <svg width="20" height="20"><defs><linearGradient id="paint0_linear"><stop stop-color="red"/></linearGradient></defs>
      <path id="grad" d="M0 0h9v9z"/><path id="ctx" d="M0 0h9v9z"/><path id="cur" d="M0 0h9v9z"/><path id="hex" d="M0 0h9v9z"/></svg>`)
    const { tokens } = (await page.evaluate(`(${STYLES_JS})({ maxElements: 100 })`)) as { tokens: { colors: { value: string }[] } }
    const colors = tokens.colors.map((c) => c.value)
    assert.deepEqual(colors.filter((v) => /url\(|^none$|context|currentcolor/i.test(v)), [], `no paint server or keyword, got ${colors}`)
    for (const kept of ["oklch(0.7 0.1 200)", "color(display-p3 1 0 0)", "#123456", "#abcdef"]) assert.ok(colors.includes(kept), `${kept} is kept, got ${colors}`)
  } finally {
    await browser.close()
  }
})
