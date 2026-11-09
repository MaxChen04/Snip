import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { chromium } from "playwright"

const SECTIONS_JS = readFileSync(new URL("../src/inpage/sections.js", import.meta.url), "utf8")
const MOTION_JS = readFileSync(new URL("../src/inpage/motion.js", import.meta.url), "utf8")
const launch = () => chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined })

test("sections are found through wrapper divs, open up a tall main, join heading bands, fold slivers and tile the page", async () => {
  const browser = await launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.setContent(`<style>body { margin: 0 } section, header, footer { display: block }</style>
      <div id="__next"><div class="app">
        <header style="height:80px"><nav>Logo</nav></header>
        <main>
          <section style="height:700px"><h1>Ship faster</h1></section>
          <section style="height:250px"><h2>Loved by teams</h2><p>Some intro text.</p></section>
          <section style="height:900px" aria-label="Customer logos"><img alt="" style="height:40px"></section>
          <div style="height:40px">divider</div>
          <section id="pricing-table" style="height:800px"></section>
          <section style="height:600px"><h2>  Frequently   asked </h2></section>
        </main>
        <div style="position:fixed;top:0;height:50px;width:100%">sticky bar</div>
        <footer style="height:300px">© 2026</footer>
      </div></div>`)
    const sections = await page.evaluate(`(${SECTIONS_JS})({})`) as { kind: string; label: string; y: number; height: number }[]
    assert.deepEqual(sections.map((s) => [s.kind, s.label]), [
      ["header", "Header"],
      ["hero", "Ship faster"],
      ["section", "Loved by teams"],
      ["section", "pricing table"],
      ["section", "Frequently asked"],
      ["footer", "Footer"],
    ])
    // Tiles top to bottom with no gaps: the 40px divider folds into its neighbour.
    assert.equal(sections[0]!.y, 0)
    for (let i = 1; i < sections.length; i++) assert.equal(sections[i]!.y, sections[i - 1]!.y + sections[i - 1]!.height)
    const last = sections.at(-1)!
    assert.equal(last.y + last.height, await page.evaluate(() => document.documentElement.scrollHeight))

    assert.equal((await page.evaluate(`(${SECTIONS_JS})({ max: 3 })`) as unknown[]).length, 3, "merged down to the cap")
    await page.setContent(`<div style="height:3000px">one long block</div>`)
    assert.deepEqual(await page.evaluate(`(${SECTIONS_JS})({})`), [], "a page that doesn't break up has no sections")
  } finally {
    await browser.close()
  }
})

test("motion logging reports transitions, CSS animations and element.animate() with their real timing", async () => {
  const browser = await launch()
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>
      #card { transition: transform 300ms cubic-bezier(0.2, 0, 0, 1) 50ms } #card.on { transform: translateY(-8px) }
      .spin { animation: spin 1s linear infinite } @keyframes spin { to { rotate: 1turn } }
      .pop { animation: pop 400ms ease-out } @keyframes pop { from { opacity: 0 } }
    </style><div id="card">card</div><div class="spin">loading</div><div id="pop">pop</div><div id="wa">wa</div>`)
    const motion = (arg: object) => page.evaluate(`(${MOTION_JS})(${JSON.stringify(arg)})`) as Promise<Record<string, unknown>[]>
    await motion({ op: "install" })
    assert.deepEqual(await motion({ op: "take" }), [], "animations running before install don't count")

    await page.evaluate(() => {
      document.querySelector("#card")!.classList.add("on")
      document.querySelector("#pop")!.classList.add("pop")
      document.querySelector("#wa")!.animate([{ opacity: 0, transform: "scale(0.9)" }, { opacity: 1, transform: "none" }], { duration: 250, easing: "ease-in-out" })
    })
    await page.waitForTimeout(100)
    const entries = await motion({ op: "take" })
    const by = (target: string) => entries.find((e) => e.target === target)!

    assert.deepEqual(
      { ...by("div#card"), startMs: 0, scrollY: 0 },
      { type: "transition", target: "div#card", property: "transform", durationMs: 300, delayMs: 50, easing: "cubic-bezier(0.2, 0, 0, 1)", iterations: 1,
        keyframes: [{ offset: 0, transform: "none" }, { offset: 1, transform: "translateY(-8px)" }], startMs: 0, scrollY: 0 },
    )
    assert.equal(by("div#pop").type, "animation")
    assert.equal(by("div#pop").property, "pop")
    assert.equal(by("div#pop").durationMs, 400)
    assert.equal(by("div#wa").type, "web-animation")
    assert.equal(by("div#wa").easing, "ease-in-out")
    assert.ok(!entries.some((e) => e.property === "spin"), "the spinner was already running")
    assert.equal(entries.length, 3)
    assert.deepEqual(await motion({ op: "take" }), [], "each entry is reported once")
  } finally {
    await browser.close()
  }
})
