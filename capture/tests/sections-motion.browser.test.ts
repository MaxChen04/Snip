import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { chromium } from "playwright"

// Only the first crawl page gets clips here, so the second takes the patch-only pass. Read when capture.ts first loads.
process.env.SNIP_LIVE_PAGES = "1"
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

test("motion installed before load logs entrance staggers, and names the page's animation tech", async () => {
  const browser = await launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    await context.addInitScript(`(${MOTION_JS})({ "op": "install" })`)
    const page = await context.newPage()
    await page.route("http://snip.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><style>
        :root { --ease-spring: linear(0, 0.5 20%, 1.04 45%, 0.99 70%, 1) }
        .glyph { animation: rise 600ms cubic-bezier(0.34, 1.56, 0.64, 1) both; animation-delay: calc(var(--i) * 70ms) }
        @keyframes rise { from { opacity: 0; transform: translateY(8px) } }
        .same { animation: rise 300ms ease-out both }
      </style>
      <div>${[0, 1, 2, 3, 4].map((i) => `<span class="glyph" style="--i:${i}">g</span>`).join("")}</div>
      <div>${[0, 1, 2].map(() => `<b class="same">x</b>`).join("")}</div>
      <p id="pulse">p</p><p class="word">a</p><p class="word">b</p><p class="word">c</p><p class="word">d</p>
      <canvas id="gl" width="400" height="300" style="width:400px;height:300px"></canvas><canvas id="flat" width="200" height="100" style="width:200px;height:100px"></canvas>
      <script>
        window.gsap = { version: "3.12.5" }
        document.querySelector("#gl").getContext("webgl2")
        document.querySelector("#flat").getContext("2d")
        ;[0, 1, 2].forEach((i) => setTimeout(() => document.querySelector("#pulse").animate([{ scale: 1 }, { scale: 1.1 }], { duration: 90 }), i * 100))
        // Started in turn from script once the page has loaded (timers fired during the load itself wander more).
        addEventListener("load", () => document.querySelectorAll(".word").forEach((el, i) => setTimeout(() => el.animate([{ opacity: 0, filter: "blur(2px)" }, { opacity: 1, filter: "blur(0px)" }], { duration: 403, easing: "cubic-bezier(.22,1,.36,1)" }), i * 40)))
      </script>` }))
    await page.goto("http://snip.test/")
    await page.waitForTimeout(400)
    const motion = (arg: object) => page.evaluate(`(${MOTION_JS})(${JSON.stringify(arg)})`) as Promise<Record<string, any>[]>
    await motion({ op: "install" }) // the capture calls it again after load: a no-op
    const entries = await motion({ op: "take" })

    const glyphs = entries.find((e) => e.property === "rise" && e.target.includes("glyph"))!
    assert.equal(glyphs.count, 5)
    assert.deepEqual(glyphs.stagger, { stepMs: 70, spanMs: 280 }, "a delay-driven stagger is one entry with its step")
    assert.equal(glyphs.delayMs, 0, "the first element's delay")
    assert.equal(glyphs.easing, "cubic-bezier(0.34, 1.56, 0.64, 1)", "a CSS animation's easing is its animation-timing-function, not the effect's linear")
    const words = entries.find((e) => e.target === "body > p.word" || e.target === "p.word")!
    assert.equal(words.count, 4)
    assert.ok(words.stagger && Math.abs(words.stagger.stepMs - 40) <= 10, `elements started in turn are a stagger too (${JSON.stringify(words.stagger)})`)
    assert.equal(words.durationMs, 403)
    const pulse = entries.find((e) => e.target === "p#pulse")!
    assert.equal(pulse.count, 3)
    assert.equal(pulse.stagger, undefined, "one element animated again and again is not a stagger")
    const same = entries.find((e) => e.target.includes("same"))!
    assert.equal(same.count, 3)
    assert.equal(same.stagger, undefined, "effects that start together are not a stagger")

    const tech = await page.evaluate(`(${MOTION_JS})({ "op": "tech" })`) as Record<string, any>
    assert.ok(tech.libraries.includes("GSAP 3.12.5"))
    assert.deepEqual(tech.canvases.map((c: { context: string; width: number }) => [c.context, c.width]), [["webgl2", 400], ["2d", 200]])
    assert.equal(tech.scrollDriven, false, "the animation shorthand's default animation-timeline drives nothing")
    await page.addStyleTag({ content: ".reveal { animation: rise linear both; animation-timeline: view() }" })
    assert.equal((await page.evaluate(`(${MOTION_JS})({ "op": "tech" })`) as Record<string, any>).scrollDriven, true)
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
    const sharp = (await import("sharp")).default
    const blank = await sharp({ create: { width: 800, height: 1500, channels: 3, background: "white" } }).jpeg().toBuffer()
    const inView = { shot: blank, patches: [] as { y: number; height: number; jpeg: Buffer }[] }
    const clips = await recordLiveSections(page, cuts, "webm", new Map(), inView)
    // The clip's first frame is the last patch of its band, so the screenshot shows the frame the clip starts on.
    const last = inView.patches.at(-1)!
    assert.deepEqual([last.y, last.height, last.jpeg === clips[1]!.still], [500, 500, true], "the clip's first frame is patched into the shot, over any in-view patch")
    const size = await sharp(last.jpeg).metadata()
    assert.deepEqual([size.width, size.height], [800, 500])
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

test("a section whose motion only starts a beat after it scrolls in is recorded, as long as the page keeps repainting", async () => {
  const { recordLiveSections } = await import("../src/capture")
  const { closeRenderer } = await import("../src/sheet")
  const browser = await launch()
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    // Like a product video that holds on its last frame before looping, or a demo that loads on view: nothing moves for
    // the first second after the demo scrolls in. A 4px speck keeps the compositor busy, far below the change threshold.
    await page.setContent(`<style>
      body { margin: 0 } section { height: 800px; position: relative }
      #speck { position: absolute; top: 4px; left: 4px; width: 4px; height: 4px }
      #box { position: absolute; top: 300px; left: 0; width: 120px; height: 120px; background: tomato }
      #box.go { animation: slide 1s linear infinite alternate } @keyframes slide { to { transform: translateX(600px) } }
    </style><section>hero</section><section id="demo"><div id="speck"></div><div id="box"></div></section><section>end</section>
    <script>
      let n = 0
      ;(function tick() { document.getElementById("speck").style.background = ++n % 2 ? "black" : "white"; requestAnimationFrame(tick) })()
      new IntersectionObserver((es, io) => { if (es[0].isIntersecting) { io.disconnect(); setTimeout(() => document.getElementById("box").classList.add("go"), 1000) } }).observe(document.getElementById("demo"))
    </script>`)
    const cuts = [0, 800, 1600].map((y, i) => ({ kind: "section" as const, label: `Part ${i}`, y, height: 800 }))
    const clips = await recordLiveSections(page, cuts, "webm")
    assert.equal(clips[0], null)
    assert.ok(clips[1], "the demo is recorded although it was still for the first probe window")
    assert.equal(clips[2], null)
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
    const seenCut = { ...cuts[2]!, fp: "abc" }
    const reused = await recordLiveSections(page, [cuts[0]!, cuts[1]!, seenCut], "webm", new Map([[liveSignature(seenCut)!, earlier]]))
    assert.deepEqual([reused[0], reused[1]], [null, null])
    assert.equal(reused[2]!.recording, null, "nothing recorded again")
    assert.deepEqual(reused[2]!.reuse, earlier)
    assert.equal(liveSignature({ kind: "section", label: "Section 4", y: 0, height: 500, fp: "abc" }), null, "generic labels are never reused")
    assert.equal(liveSignature({ kind: "section", label: "Overview", y: 0, height: 500 }), null, "nor sections without a content fingerprint")
    assert.notEqual(liveSignature({ kind: "hero", label: "Overview", y: 0, height: 500, fp: "a" }), liveSignature({ kind: "hero", label: "Overview", y: 0, height: 500, fp: "b" }), "same label and height, different content")
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
    const html = `<style>body { margin: 0 } .far { content-visibility: auto; contain-intrinsic-size: auto 600px; height: 600px; background: rgb(0, 160, 0) }
      .off { content-visibility: hidden; contain-intrinsic-size: 600px; height: 600px } .off div { height: 600px; background: rgb(200, 0, 0) }</style>
      <div style="height: 2400px"></div><div class="far"></div><div class="off"><div></div></div>
      <script>window.resizes = 0; addEventListener("resize", () => window.resizes++)</script>`
    await context.route("http://snip.test/", (route) => route.fulfill({ contentType: "text/html", body: html }))
    await page.goto("http://snip.test/")
    const shot = await fullPageShotForTest(page)
    assert.equal(await page.evaluate(() => (window as unknown as { resizes: number }).resizes), 0, "the site never saw the screenshot's resize")
    const { data } = await sharp(shot.buf).extract({ left: 400, top: 2700, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true })
    assert.ok(data[1]! > 120 && data[0]! < 60, `the content-visibility block is painted green, got ${[...data]}`)
    const hidden = [...(await sharp(shot.buf).extract({ left: 400, top: 3300, width: 1, height: 1 }).raw().toBuffer())]
    assert.ok(hidden[0]! > 200 && hidden[1]! > 200, `content-visibility: hidden stays unpainted, got ${hidden}`)
    assert.deepEqual(await page.evaluate(() => [document.querySelectorAll("[data-snip-cv]").length, (document.querySelector(".far") as HTMLElement).style.cssText]), [0, ""], "the override is removed afterwards")
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

// A page whose reveals undo themselves out of view, so a full-page shot taken from the top shows them hidden.
// The teal box sits at document y 1000-1300, below the first viewport on desktop and mobile alike.
const REVEAL_PAGE = (title: string, link = "") => `<!doctype html><title>${title}</title><meta name="viewport" content="width=device-width">
  <style>body { margin: 0; font: 16px sans-serif } section { display: block; position: relative } .box { height: 300px; background: rgb(0, 128, 128); opacity: 0 } .box.in { opacity: 1 }</style>
  <nav>${link}</nav>
  <section style="height: 900px"><h1>${title}</h1></section>
  <section style="height: 700px"><h2>Reveals</h2><div class="box" style="position: absolute; top: 100px; width: 100%"></div></section>
  <section style="height: 900px"><h2>Still end</h2></section>
  <script>const io = new IntersectionObserver((es) => es.forEach((e) => e.target.classList.toggle("in", e.isIntersecting))); document.querySelectorAll(".box").forEach((b) => io.observe(b))</script>`
const teal = (rgb: number[]) => rgb[0]! < 60 && rgb[1]! > 90 && rgb[2]! > 90

test("without clips, in-view patches come from one still per section, on desktop and on a mobile viewport at its own DPR", async () => {
  const { recordLiveSections, patchInView, fullPageShotAtForTest, OBSERVED_FOR_TEST, HOLD_RESIZE_FOR_TEST } = await import("../src/capture")
  const sharp = (await import("sharp")).default
  const px = async (img: Buffer, x: number, y: number) => [...(await sharp(img).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())]
  const browser = await launch()
  try {
    for (const { name, options, dpr } of [
      { name: "desktop", options: { viewport: { width: 800, height: 600 } }, dpr: 1 },
      { name: "mobile", options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true }, dpr: 1.5 },
    ]) {
      const context = await browser.newContext(options)
      await context.addInitScript(HOLD_RESIZE_FOR_TEST)
      await context.addInitScript(OBSERVED_FOR_TEST)
      await context.route("http://snip.test/", (route) => route.fulfill({ contentType: "text/html", body: REVEAL_PAGE("Patch only") }))
      const page = await context.newPage()
      await page.goto("http://snip.test/")
      const shot = await fullPageShotAtForTest(page, dpr)
      assert.equal(shot.width, Math.round((options.viewport.width) * dpr))
      assert.ok(!teal(await px(shot.buf, 100, 1150 * dpr)), `${name}: the shot from the top misses the reveal`)

      const cuts = [{ y: 0, height: 900 }, { y: 900, height: 700 }, { y: 1600, height: 900 }].map((c, i) => ({ kind: "section" as const, label: `Part ${i}`, ...c }))
      const inView = { shot: shot.buf, patches: [] as { y: number; height: number; jpeg: Buffer }[], dpr }
      // "gif": the Worker takes no clips, so nothing is recorded, but the patches are still collected.
      assert.deepEqual(await recordLiveSections(page, cuts, "gif", new Map(), inView), [null, null, null])
      assert.ok(inView.patches.length >= 1 && inView.patches.every((p) => p.y >= 900 && p.y < 1600), `${name}: only the revealing section, got ${inView.patches.map((p) => p.y)}`)
      const patched = await patchInView(shot.buf, inView.patches, dpr)
      assert.deepEqual(imageSizeOf(await sharp(patched).metadata()), [shot.width, shot.height], `${name}: same size`)
      assert.ok(teal(await px(patched, 100, 1150 * dpr)), `${name}: the reveal is in, got ${await px(patched, 100, 1150 * dpr)}`)
      assert.ok(!teal(await px(patched, 100, 950 * dpr)) && !teal(await px(patched, 100, 1350 * dpr)), `${name}: the patch lines up with the box in image px`)
      assert.equal(await page.evaluate(() => scrollY), 0, "left at the top")
      await context.close()
    }
  } finally {
    await browser.close()
  }
})

const imageSizeOf = (m: { width?: number; height?: number }) => [m.width, m.height]

test("a section that ends at the bottom of a fractional-DPR viewport is patched, not skipped for a band one pixel past the image", async () => {
  const { recordLiveSections, patchInView, fullPageShotAtForTest, OBSERVED_FOR_TEST, HOLD_RESIZE_FOR_TEST } = await import("../src/capture")
  const sharp = (await import("sharp")).default
  const browser = await launch()
  try {
    // example.com on a phone: 898px tall in an 844px viewport, so the last section (y 589, 309 tall) scrolls to viewport
    // top 535. At 1.5 image px per CSS px, rounding that top and that height separately (803 + 464) ends at row 1267 of
    // a 1266 row frame. The section's reveal sits below the first screen, so the shot from the top shows it hidden.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true })
    await context.addInitScript(HOLD_RESIZE_FOR_TEST)
    await context.addInitScript(OBSERVED_FOR_TEST)
    await context.route("http://snip.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width">
      <style>body { margin: 0 } section { display: block; position: relative } .box { position: absolute; top: 260px; width: 100%; height: 40px; background: rgb(0, 128, 128); opacity: 0 } .box.in { opacity: 1 }</style>
      <section style="height: 345px">one</section><section style="height: 244px">two</section><section style="height: 309px"><div class="box"></div></section>
      <script>const io = new IntersectionObserver((es) => es.forEach((e) => e.target.classList.toggle("in", e.isIntersecting))); io.observe(document.querySelector(".box"))</script>` }))
    const page = await context.newPage()
    await page.goto("http://snip.test/")
    const shot = await fullPageShotAtForTest(page, 1.5)
    const cuts = [{ y: 0, height: 345 }, { y: 345, height: 244 }, { y: 589, height: 309 }].map((c, i) => ({ kind: "section" as const, label: `Part ${i}`, ...c }))
    const inView = { shot: shot.buf, patches: [] as { y: number; height: number; jpeg: Buffer }[], dpr: 1.5 }
    await recordLiveSections(page, cuts, "gif", new Map(), inView)
    assert.deepEqual(inView.patches.map((p) => [p.y, p.height]), [[589, 309]], "the last section's reveal is patched in")
    const patched = await patchInView(shot.buf, inView.patches, 1.5)
    const [r, g, b] = [...(await sharp(patched).extract({ left: 100, top: Math.round(870 * 1.5), width: 1, height: 1 }).raw().toBuffer())]
    assert.ok(r! < 60 && g! > 90 && b! > 90, `the reveal is in the shot, got ${[r, g, b]}`)
    await context.close()
  } finally {
    await browser.close()
  }
})

test("a crawl page past the clip limit and the mobile shot still get in-view patches", { timeout: 180_000 }, async () => {
  const http = await import("node:http")
  const sharp = (await import("sharp")).default
  const { captureJob } = await import("../src/capture")
  const previous = process.env.ALLOW_PRIVATE_URLS
  process.env.ALLOW_PRIVATE_URLS = "true"
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end(req.url === "/b" ? REVEAL_PAGE("Page B") : REVEAL_PAGE("Page A", `<a href="/b">Page B</a>`))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  const browser = await launch()
  try {
    const uploads = new Map<string, Buffer>()
    const pages: { url: string; desktopKey: string; mobileKey: string | null }[] = []
    const api = {
      control: async () => null,
      progress: async () => {},
      upload: async (key: string, body: Buffer | string) => { uploads.set(key, Buffer.from(body)); return key },
      addPage: async (_id: string, page: { url: string; desktopKey: string; mobileKey: string | null }) => { pages.push(page) },
      complete: async () => {},
    }
    await captureJob(browser, api as never, {
      id: "inview", url, mode: "crawl", maxPages: 2, attempt: "a".repeat(32), resume: null, options: null,
      recordingFormats: ["gif", "webm"], features: ["sections", "live"],
    })
    assert.equal(pages.length, 2)
    const px = async (key: string, x: number, y: number) => [...(await sharp(uploads.get(key)!).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())]
    for (const page of pages) {
      assert.ok(teal(await px(page.desktopKey, 100, 1150)), `${page.url}: the desktop shot shows the reveal`)
      assert.ok(teal(await px(page.mobileKey!, 100, Math.round(1150 * 1.5))), `${page.url}: the mobile shot shows the reveal`)
    }
  } finally {
    await browser.close()
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_URLS
    else process.env.ALLOW_PRIVATE_URLS = previous
  }
})

test("a moving section taller than the viewport is recorded whole, unless growing the viewport moves the layout", { timeout: 120_000 }, async () => {
  const { recordLiveSections } = await import("../src/capture")
  const { closeRenderer } = await import("../src/sheet")
  const browser = await launch()
  try {
    for (const [name, css, height, want] of [["fixed height", "height: 800px", 800, 800], ["viewport-sized", "height: 130vh", 780, 600]] as const) {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
      await page.setContent(`<style>
        body { margin: 0 } section { ${css} } .rest { height: 1200px }
        #spin { width: 80px; height: 80px; background: tomato; animation: move 1s linear infinite } @keyframes move { to { transform: translateX(600px) } }
      </style><section><div id="spin"></div></section><div class="rest"></div>`)
      const clips = await recordLiveSections(page, [{ kind: "hero" as const, label: "hero", y: 0, height }], "webm")
      assert.deepEqual([clips[0]?.height, clips[0]?.recording?.height], [want, want], name)
      assert.deepEqual(page.viewportSize(), { width: 800, height: 600 }, `${name}: the viewport is put back`)
      await page.close()
    }
  } finally {
    await closeRenderer()
    await browser.close()
  }
})

test("a tall section is recorded whole only if growing the viewport leaves the page where it was cut", { timeout: 240_000 }, async (t) => {
  const { recordLiveSections } = await import("../src/capture")
  const { closeRenderer } = await import("../src/sheet")
  const sharp = (await import("sharp")).default
  const browser = await launch()
  // The viewport is 600 tall and grows to 800 for the 800px section "b", cut at y=600 of a 1800px page. Every case
  // keeps the page 1800px tall at both heights, so only where the sections sit tells whether the layout moved.
  const sec = (cls: string, height: string) => `<section class="${cls}" style="height: ${height}"></section>`
  const b = `<section class="b" style="height: 800px"><div id="spin"></div></section>`
  const grow = (px: number) => `${px / 200} * (100vh - 600px)` // px taller at 800, no change at 600
  const cases: [string, string, number][] = [
    ["sections sized 100vh and calc(1400px - 100vh)", `${sec("a", "100vh")}<section class="b" style="height: calc(1400px - 100vh)"><div id="spin"></div></section>${sec("c", "400px")}`, 600],
    ["a section above grows by 3px", `${sec("a", `calc(600px + ${grow(3)})`)}${b}${sec("c", `calc(400px - ${grow(3)})`)}`, 600],
    ["the section itself grows by 100px", `${sec("a", "600px")}<section class="b" style="height: calc(800px + ${grow(100)})"><div id="spin"></div></section>${sec("c", `calc(400px - ${grow(100)})`)}`, 600],
    ["a section above grows by 1px (rounding)", `${sec("a", `calc(600px + ${grow(1)})`)}${b}${sec("c", `calc(400px - ${grow(1)})`)}`, 800],
    ["sections above trade 100px, so the section stays put", `${sec("a", `calc(300px + ${grow(100)})`)}${sec("a", `calc(300px - ${grow(100)})`)}${b}${sec("c", "400px")}`, 800],
    ["fixed and sticky bars follow the viewport", `<div style="position: fixed; inset: 0; pointer-events: none"></div><div style="position: fixed; bottom: 0; left: 0; right: 0; height: 60px; background: gray"></div>
      <header style="position: sticky; top: 0; height: 50px; background: gray"></header>${sec("a", "550px")}${b}${sec("c", "360px")}<footer style="position: sticky; bottom: 0; height: 40px; background: gray"></footer>`, 800],
  ]
  const pixel = async (jpeg: Buffer, x: number, y: number) => {
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true })
    const at = (y * info.width + x) * info.channels
    return [data[at]!, data[at + 1]!, data[at + 2]!]
  }
  try {
    for (const [name, html, want] of cases) await t.test(name, async () => {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
      await page.setContent(`<style>
        body { margin: 0 } .a { background: #ff2020 } .b { background: #2040ff } .c { background: #20c040 }
        #spin { width: 80px; height: 80px; background: tomato; animation: move 1s linear infinite } @keyframes move { to { transform: translateX(600px) } }
      </style>${html}`)
      const height = () => page.evaluate(() => document.documentElement.scrollHeight)
      await page.setViewportSize({ width: 800, height: 800 })
      assert.equal(await height(), 1800, `${name}: the page is as tall grown as not`)
      await page.setViewportSize({ width: 800, height: 600 })
      assert.equal(await height(), 1800)

      const blank = await sharp({ create: { width: 800, height: 1800, channels: 3, background: "white" } }).jpeg().toBuffer()
      const inView = { shot: blank, patches: [] as { y: number; height: number; jpeg: Buffer }[] }
      const clips = await recordLiveSections(page, [{ kind: "section" as const, label: "b", y: 600, height: 800 }], "webm", new Map(), inView)
      assert.deepEqual([clips[0]?.height, clips[0]?.recording?.height], [want, want], name)
      assert.deepEqual(page.viewportSize(), { width: 800, height: 600 }, `${name}: the viewport is put back`)
      // The clip's first frame is pasted into the screenshot at the section's place: it must show the section, not the one above it.
      const last = inView.patches.at(-1)!
      assert.deepEqual([last.y, last.height], [600, want], name)
      const [red, , blue] = await pixel(last.jpeg, 400, 100)
      assert.ok(blue! > 200 && red! < 100, `${name}: the first frame shows section b (r ${red}, b ${blue})`)
      await page.close()
    })
  } finally {
    await closeRenderer()
    await browser.close()
  }
})
