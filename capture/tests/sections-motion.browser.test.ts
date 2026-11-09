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

    // Keyframes are read when the log is taken, so an effect that already finished is still described.
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("#card")!
      el.style.transition = "opacity 50ms ease-in"
      el.style.opacity = "0.5"
    })
    await page.waitForTimeout(300)
    const done = (await motion({ op: "take" })).find((e) => e.property === "opacity")!
    assert.equal(done.durationMs, 50)
    assert.deepEqual(done.keyframes, [{ offset: 0, opacity: "1" }, { offset: 1, opacity: "0.5" }])
  } finally {
    await browser.close()
  }
})

test("live clips are recorded only for sections that move, cropped to the section, with fixed bars put back", async () => {
  const { recordLiveSections } = await import("../src/capture")
  const { closeRenderer } = await import("../src/sheet")
  const browser = await launch()
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`<style>
      body { margin: 0 } section { height: 500px }
      #bar { position: fixed; top: 0; left: 0; right: 0; height: 40px; background: navy }
      #spin { width: 80px; height: 80px; background: tomato; animation: move 1s linear infinite } @keyframes move { to { transform: translateX(600px) } }
    </style><div id="bar"></div><section>still hero</section><section><div id="spin"></div></section><section>still</section>`)
    const cuts = [0, 500, 1000].map((y, i) => ({ kind: "section" as const, label: `s${i}`, y, height: 500 }))
    const clips = await recordLiveSections(page, cuts, "webm")
    assert.equal(clips[0], null, "a still section is not recorded")
    assert.equal(clips[2], null)
    const clip = clips[1]!
    assert.ok(clip, "the moving section is recorded")
    assert.equal(clip.recording.ext, "webm")
    assert.deepEqual([clip.recording.width, clip.height], [800, 500])
    assert.ok(clip.recording.bytes.length > 1000)
    assert.ok(clip.durationMs >= 1000 && clip.durationMs <= 3100, `duration ${clip.durationMs}`)
    assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.getElementById("bar")!).visibility, scrollY]), ["visible", 0], "bars restored and back at the top")
    assert.deepEqual(await recordLiveSections(page, cuts, "gif"), [null, null, null], "no clips when the Worker only shows GIFs")

    // A transparent header over a moving hero background: one clip for both, so their edges stay in step.
    await page.setContent(`<style>
      body { margin: 0 } header { height: 100px } .hero { height: 400px } .rest { height: 900px }
      .bg { position: absolute; top: 0; left: 0; width: 100%; height: 500px; background: linear-gradient(90deg, red, blue); animation: slide 1s linear infinite alternate }
      @keyframes slide { to { opacity: 0.3 } }
    </style><div class="bg"></div><header>nav</header><div class="hero">hero</div><div class="rest">still</div>`)
    const shared = await recordLiveSections(page, [
      { kind: "header", label: "h", y: 0, height: 100 }, { kind: "hero", label: "hero", y: 100, height: 400 }, { kind: "section", label: "rest", y: 500, height: 900 },
    ], "webm")
    assert.ok(shared[0] && shared[0] === shared[1], "header and hero share one clip")
    assert.deepEqual([shared[0]!.y, shared[0]!.height], [0, 500])
    assert.equal(shared[2], null)
  } finally {
    await closeRenderer()
    await browser.close()
  }
})

test("one-shot reveals and a focused caret don't make clips, and a section seen on an earlier page reuses its clip", async () => {
  const { recordLiveSections, liveSignature } = await import("../src/capture")
  const { closeRenderer } = await import("../src/sheet")
  const browser = await launch()
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`<style>body { margin: 0 } section { height: 500px } .reveal { opacity: 0; transition: opacity 1.2s } .reveal.in { opacity: 1 }</style>
      <section><input id="field" style="font-size: 30px"></section>
      <section><div class="reveal" style="height: 300px; background: teal">reveals once</div></section>
      <section>still</section>
      <script>
        new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in"))).observe(document.querySelector(".reveal"))
        document.getElementById("field").focus()
      </script>`)
    const cuts = [0, 500, 1000].map((y, i) => ({ kind: "section" as const, label: `Block ${i}`, y, height: 500 }))
    assert.deepEqual(await recordLiveSections(page, cuts, "webm"), [null, null, null])

    const earlier = { key: "refs/r/a/p0/section-2-live.webm", height: 500, durationMs: 3000 }
    const reused = await recordLiveSections(page, cuts, "webm", new Map([[liveSignature(cuts[2]!)!, earlier]]))
    assert.deepEqual([reused[0], reused[1]], [null, null])
    assert.equal(reused[2]!.recording, null, "nothing recorded again")
    assert.deepEqual(reused[2]!.reuse, earlier)
    assert.equal(liveSignature({ kind: "section", label: "Section 4", y: 0, height: 500 }), null, "generic labels are never reused")
  } finally {
    await closeRenderer()
    await browser.close()
  }
})

test("the other color scheme is captured only when the page has a theme for it, and the page is left in its own", async () => {
  const { captureOtherScheme } = await import("../src/capture")
  const browser = await launch()
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, colorScheme: "light" })
    await page.setContent(`<style>body { margin: 0; height: 1500px; background: #fff; color: #111 } @media (prefers-color-scheme: dark) { body { background: #111; color: #eee } }</style><h1>Themed</h1>`)
    const dark = await captureOtherScheme(page, "light")
    assert.equal(dark?.scheme, "dark")
    assert.equal(dark!.shot.height, 1500)
    assert.equal(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), false, "back in its own scheme")

    await page.setContent(`<style>body { margin: 0; background: #fff }</style><h1>One theme only</h1>`)
    assert.equal(await captureOtherScheme(page, "light"), null)
  } finally {
    await browser.close()
  }
})

test("a full-page shot doesn't send the page a resize, and paints content-visibility sections", async () => {
  const { fullPageShotForTest, HOLD_RESIZE_FOR_TEST } = await import("../src/capture")
  const sharp = (await import("sharp")).default
  const browser = await launch()
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } })
    await context.addInitScript(HOLD_RESIZE_FOR_TEST)
    const page = await context.newPage()
    // A real navigation, as in a capture: setContent rewrites the document in place, which drops the init script's listeners.
    const html = `<style>body { margin: 0 } .far { content-visibility: auto; contain-intrinsic-size: auto 600px; height: 600px; background: rgb(0, 160, 0) }</style>
      <div style="height: 2400px"></div><div class="far"></div>
      <script>window.resizes = 0; addEventListener("resize", () => window.resizes++)</script>`
    await context.route("http://snip.test/", (route) => route.fulfill({ contentType: "text/html", body: html }))
    await page.goto("http://snip.test/")
    const shot = await fullPageShotForTest(page)
    assert.equal(await page.evaluate(() => (window as unknown as { resizes: number }).resizes), 0, "the site never saw the screenshot's resize")
    const { data } = await sharp(shot.buf).extract({ left: 400, top: 2700, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true })
    assert.ok(data[1]! > 120 && data[0]! < 60, `the content-visibility block is painted green, got ${[...data]}`)
    assert.equal(await page.evaluate(() => document.querySelectorAll("style[data-snip-full-page]").length), 0, "the forcing style is removed afterwards")
    assert.equal(await page.evaluate(() => (window as unknown as { __snipHoldResize: boolean }).__snipHoldResize), false)
    await page.setViewportSize({ width: 700, height: 600 })
    await page.waitForTimeout(100)
    assert.ok(await page.evaluate(() => (window as unknown as { resizes: number }).resizes) > 0, "real resizes still reach the page")
  } finally {
    await browser.close()
  }
})

test("sections that look different scrolled into view are patched into the full-page shot, down tall sections too", async () => {
  const { recordLiveSections, patchInView, fullPageShotForTest } = await import("../src/capture")
  const { closeRenderer } = await import("../src/sheet")
  const sharp = (await import("sharp")).default
  const browser = await launch()
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    // Reveals that undo themselves out of view: a shot taken from the top shows them hidden.
    await page.setContent(`<style>body { margin: 0 } .box { height: 200px; background: rgb(0, 128, 128); opacity: 0 } .box.in { opacity: 1 }</style>
      <section style="height: 600px">top</section>
      <section style="height: 1500px; position: relative"><div class="box" style="margin-top: 50px"></div><div class="box" style="position: absolute; top: 1250px; width: 100%"></div></section>
      <section style="height: 600px">end</section>
      <script>const io = new IntersectionObserver((es) => es.forEach((e) => e.target.classList.toggle("in", e.isIntersecting))); document.querySelectorAll(".box").forEach((b) => io.observe(b))</script>`)
    await page.waitForTimeout(100)
    const shot = await fullPageShotForTest(page)
    const px = async (img: Buffer, x: number, y: number) => [...(await sharp(img).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())]
    assert.deepEqual((await px(shot.buf, 400, 750)).slice(0, 3), [255, 255, 255], "the shot from the top misses the reveal")

    const cuts = [{ kind: "section" as const, label: "Top", y: 0, height: 600 }, { kind: "section" as const, label: "Tall", y: 600, height: 1500 }, { kind: "section" as const, label: "End", y: 2100, height: 600 }]
    const inView = { shot: shot.buf, patches: [] as { y: number; height: number; jpeg: Buffer }[] }
    await recordLiveSections(page, cuts, "webm", new Map(), inView)
    assert.ok(inView.patches.length >= 2, `the tall section is patched in several frames, got ${inView.patches.length}`)
    assert.ok(inView.patches.every((p) => p.y >= 600 && p.y < 2100), "only the section that differs")
    const patched = await patchInView(shot.buf, inView.patches)
    const teal = (rgb: number[]) => rgb[0]! < 40 && rgb[1]! > 100 && rgb[2]! > 100
    assert.ok(teal(await px(patched, 400, 750)), "the top reveal is in")
    assert.ok(teal(await px(patched, 400, 1950)), "the reveal far down the tall section is in")
    assert.deepEqual((await px(patched, 400, 300)).slice(0, 3), (await px(shot.buf, 400, 300)).slice(0, 3), "sections that match are left alone")
  } finally {
    await closeRenderer()
    await browser.close()
  }
})

test("only bars pinned to the viewport edges are hidden: fixed backgrounds and pinned section content stay", async () => {
  const { recordLiveSections } = await import("../src/capture")
  const sharp = (await import("sharp")).default
  const { closeRenderer } = await import("../src/sheet")
  const browser = await launch()
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    // The only motion on the page is a full-screen fixed background, and a header bar that blinks.
    await page.setContent(`<style>
      body { margin: 0 } section { height: 600px; position: relative }
      #bg { position: fixed; inset: 0; z-index: -1; background: linear-gradient(90deg, red, blue); animation: fade 0.8s linear infinite alternate }
      #bar { position: fixed; top: 0; left: 0; right: 0; height: 40px; background: navy; animation: blink 0.3s steps(1) infinite }
      @keyframes fade { to { opacity: 0.2 } } @keyframes blink { 50% { background: gold } }
      .col { position: sticky; top: 0; height: 400px; width: 200px; background: green }
    </style><div id="bg"></div><div id="bar"></div>
      <section>hero</section><section><div class="col"></div></section><section>end</section>`)
    const cuts = [0, 600, 1200].map((y, i) => ({ kind: "section" as const, label: `Part ${i}`, y, height: 600 }))
    // A blank shot, so every section differs and keeps its in-view frame: that frame shows what was hidden.
    const blank = await sharp({ create: { width: 800, height: 1800, channels: 3, background: "white" } }).jpeg().toBuffer()
    const inView = { shot: blank, patches: [] as { y: number; height: number; jpeg: Buffer }[] }
    const clips = await recordLiveSections(page, cuts, "webm", new Map(), inView)
    assert.ok(clips[1] && clips[2], "the fixed background is kept, so lower sections still move")
    const frame = inView.patches.find((p) => p.y === 600)!
    const px = [...(await sharp(frame.jpeg).extract({ left: 100, top: 20, width: 1, height: 1 }).raw().toBuffer())]
    assert.ok(px[1]! > 100 && px[0]! < 80 && px[2]! < 80, `the sticky column shows where the hidden header bar would be, got ${px}`)
    await page.evaluate(() => scrollTo(0, 600))
    assert.deepEqual(await page.evaluate(() => ["#bar", "#bg", ".col"].map((s) => getComputedStyle(document.querySelector(s)!).visibility)), ["visible", "visible", "visible"], "everything is restored afterwards")
  } finally {
    await closeRenderer()
    await browser.close()
  }
})
