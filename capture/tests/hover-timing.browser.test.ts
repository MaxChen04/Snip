import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { recordScroll } from "../src/capture"
import { closeRenderer, renderer } from "../src/sheet"

const TRANSITION_JS = readFileSync(new URL("../src/inpage/transition-ms.js", import.meta.url), "utf8")
const launch = () => chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined })

test("hover timing reads the longest transition or animation on the target, its children and pseudo-elements", async () => {
  const browser = await launch()
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>
      #a { transition: color .2s, transform 250ms }
      #b { transition: opacity .1s } #b img { transition: transform .4s ease .1s }
      #c::after { content: ""; transition: width 0.6s }
      #d span { animation: pulse 0.3s 0.2s infinite } @keyframes pulse { to { opacity: .5 } }
      #e { transition: none }
    </style>
    <a id="a">a</a><div id="b"><img></div><button id="c">c</button><div id="d"><span>d</span></div><p id="e">e</p>`)
    const ms = (sel: string) => page.evaluate(`(${TRANSITION_JS})(${JSON.stringify(sel)})`)
    assert.equal(await ms("#a"), 250)
    assert.equal(await ms("#b"), 500, "a child's duration plus delay")
    assert.equal(await ms("#c"), 600, "a pseudo-element")
    assert.equal(await ms("#d"), 500, "one iteration of an animation")
    assert.equal(await ms("#e"), 0)
    assert.equal(await ms("#missing"), 0)
  } finally {
    await browser.close()
  }
})

test("a scroll that isn't recording (mobile) leaves the encoder page of a recording running alongside it open", async () => {
  const browser = await launch()
  try {
    const helper = await renderer(browser)
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.setContent(`<div style="height:3000px"></div>`)
    await recordScroll(page, false)
    assert.equal(helper.isClosed(), false)
  } finally {
    await closeRenderer()
    await browser.close()
  }
})
