import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from "playwright"
import { JobGoneError } from "../src/api"
import { closeRenderer, fenceRenderer, renderer } from "../src/sheet"

// The stills/video helper of a cancelled capture: a Cancel that lands while the helper is still opening closes it, and once
// the capture is cancelled no new helper opens, so nothing can sit in one until the page deadline.
let browser: Browser
before(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined }) })
after(async () => { await closeRenderer(); await browser?.close() })

const within = <T>(ms: number, p: Promise<T>, what: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(what)), ms) })]).finally(() => clearTimeout(timer))
}

/** A browser whose helper context waits at \`hold\` (before it exists) or never loads its page (\`page\`). */
function stalled(at: "context" | "page") {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const fake = Object.create(browser, {
    newContext: { value: async (options: BrowserContextOptions) => {
      if (at === "context") { entered.resolve(); await release.promise }
      const ctx: BrowserContext = await browser.newContext(options)
      if (at === "page") {
        const newPage = ctx.newPage.bind(ctx)
        ctx.newPage = async () => {
          const page = await newPage()
          const route = page.route.bind(page)
          // The helper's document is never answered, so its goto waits until the context closes.
          page.route = (async (url: string) => route(url, () => entered.resolve())) as typeof page.route
          return page
        }
      }
      return ctx
    } },
  }) as Browser
  return { fake, entered: entered.promise, release: release.resolve }
}

for (const at of ["context", "page"] as const) test(`a Cancel while the helper's ${at === "context" ? "context is being created" : "page is loading"} closes it and fails the helper`, { timeout: 15_000 }, async () => {
  const cancelled = new AbortController()
  const release = fenceRenderer(cancelled.signal)
  try {
    const { fake, entered, release: go } = stalled(at)
    const opening = renderer(fake)
    const settled = opening.then(() => "opened", (error: unknown) => error)
    await entered
    cancelled.abort(new JobGoneError())
    await closeRenderer()
    go()
    const result = await within(3000, settled, "the helper kept opening after the cancel")
    assert.ok(result instanceof Error, "the helper did not open")
    await within(3000, (async () => { while (browser.contexts().length) await new Promise((r) => setTimeout(r, 20)) })(), "the helper's context was left open")
  } finally { release() }
})

test("once a capture is cancelled, no helper opens for it, and the next capture opens one again", { timeout: 15_000 }, async () => {
  const cancelled = new AbortController()
  const release = fenceRenderer(cancelled.signal)
  const open = await renderer(browser)
  cancelled.abort(new JobGoneError())
  await closeRenderer()
  assert.ok(open.isClosed())
  await assert.rejects(renderer(browser), JobGoneError)
  assert.equal(browser.contexts().length, 0)
  release()
  const next = new AbortController()
  const releaseNext = fenceRenderer(next.signal)
  try {
    const page = await renderer(browser)
    assert.equal(page.isClosed(), false)
    await closeRenderer()
  } finally { releaseNext() }
})
