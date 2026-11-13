import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { chromium } from "playwright"
import sharp from "sharp"
import type { Job, PageUpload } from "../../web/shared/types"
import { JobGoneError, type SnipApi } from "../src/api"
import { captureJob } from "../src/capture"
import { closeRenderer } from "../src/sheet"

// A header bar and footer too short to be worth shrinking around three blocks that are, and a dark theme for the other color scheme.
const PAGE = `<!doctype html><title>Thumbs</title>
  <style>
    :root { --bg: #f4efe6; --fg: #1d2a3a } @media (prefers-color-scheme: dark) { :root { --bg: #10151c; --fg: #e8edf4 } }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 16px Georgia } header, section, footer { display: block }
    section { background-image: repeating-linear-gradient(135deg, transparent 0 24px, color-mix(in srgb, var(--fg) 14%, transparent) 24px 28px) } h1, h2 { margin: 0; padding: 48px }
  </style>
  <header style="height: 80px"><nav>Logo</nav></header>
  <main>
    <section style="height: 700px"><h1>Ship faster</h1></section>
    <section style="height: 520px" aria-label="Customers"><h2>Loved by teams</h2><img alt="" width="200" height="120" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></section>
    <section style="height: 900px" aria-label="Pricing"><h2>Simple pricing</h2><img alt="" width="200" height="120" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></section>
  </main>
  <footer style="height: 120px">© 2026</footer>`

async function withPage(run: (url: string) => Promise<void>) {
  const previous = process.env.ALLOW_PRIVATE_URLS
  process.env.ALLOW_PRIVATE_URLS = "true"
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}/`)
  } finally {
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_URLS
    else process.env.ALLOW_PRIVATE_URLS = previous
  }
}

const size = async (jpeg: Buffer) => {
  const { width, height } = await sharp(jpeg).metadata()
  return { width: width!, height: height! }
}

test("section thumbnails are made for a Worker that says it reads them, and never cost a section", { timeout: 180_000 }, async (t) => {
  await withPage(async (url) => {
    const browser = await chromium.launch()
    try {
      /** One capture of the page. `failThumbs` makes every thumbnail upload fail; `goneOnThumbs` ends the job under it. */
      const capture = async (features: Job["features"], { failThumbs = false, goneOnThumbs = false } = {}) => {
        const uploads = new Map<string, Buffer>()
        const pages: PageUpload[] = []
        const api = {
          control: async () => null,
          progress: async () => {},
          upload: async (key: string, body: Buffer | string) => {
            if (/section-\d+-thumb\.jpg$/.test(key)) {
              if (goneOnThumbs) throw new JobGoneError()
              if (failThumbs) throw new Error("storage said no")
            }
            uploads.set(key, Buffer.from(body))
            return key
          },
          addPage: async (_id: string, page: PageUpload) => { pages.push(page) },
          complete: async () => {},
        } as unknown as SnipApi
        const job: Job = { id: "thumbs", url, mode: "single", maxPages: 1, attempt: "a".repeat(32), lease: "b".repeat(32), resume: null, options: null, features }
        await captureJob(browser, api, job)
        assert.equal(pages.length, 1)
        return { uploads, page: pages[0]! }
      }

      await t.test("a Worker that advertises sectionThumbs gets a 640 px thumbnail of each crop that shrinks", async () => {
        const { uploads, page } = await capture(["sections", "schemes", "sectionThumbs"])
        const sections = page.sections!
        assert.deepEqual(sections.map((s) => s.kind), ["header", "hero", "section", "section", "footer"])
        for (const [i, s] of sections.entries()) {
          const crop = await size(uploads.get(s.key)!)
          assert.equal(crop.width, 1440, "the crop is as wide as the page")
          const tall = s.height >= 160
          assert.equal(s.thumbKey, tall ? s.key.replace(/\.jpg$/, "-thumb.jpg") : undefined, `section ${i} (${s.height} px tall)`)
          if (!s.thumbKey) {
            assert.ok(!uploads.has(s.key.replace(/\.jpg$/, "-thumb.jpg")), `a ${s.height} px strip has no thumbnail to upload`)
            continue
          }
          const thumb = uploads.get(s.thumbKey)!
          assert.deepEqual(await size(thumb), { width: 640, height: Math.round((640 * crop.height) / 1440) }, `section ${i} keeps its proportions at 640 px wide`)
          assert.ok(thumb.length < uploads.get(s.key)!.length, `section ${i}'s thumbnail is smaller than its crop`)
          assert.deepEqual([...thumb.subarray(0, 3)], [0xff, 0xd8, 0xff], "a JPEG")
        }
        assert.ok(sections.filter((s) => s.thumbKey).length >= 3, "the three blocks have thumbnails")
        // The other color scheme's crops are only for the inspector and the page viewer: no thumbnails.
        assert.equal(page.altScheme?.scheme, "dark", "the page has a dark theme")
        assert.ok(page.altScheme!.sectionKeys.every((key) => key && uploads.has(key)))
        assert.deepEqual([...uploads.keys()].filter((key) => /section-\d+-dark-thumb/.test(key)), [])
      })

      await t.test("a Worker that does not advertise it gets nothing extra, as before", async () => {
        const { uploads, page } = await capture(["sections", "live", "schemes", "icon", "gzip"])
        assert.equal(page.sections!.length, 5)
        assert.ok(page.sections!.every((s) => !("thumbKey" in s)), "no section names a thumbnail")
        assert.deepEqual([...uploads.keys()].filter((key) => /section-\d+-thumb/.test(key)), [], "and none is uploaded")
      })

      await t.test("a thumbnail that cannot be stored leaves the section whole, without thumbKey", async () => {
        const { uploads, page } = await capture(["sections", "sectionThumbs"], { failThumbs: true })
        assert.equal(page.sections!.length, 5, "every section is still saved")
        for (const s of page.sections!) {
          assert.ok(uploads.has(s.key), "with its crop")
          assert.ok(!("thumbKey" in s), "and no thumbKey, which would point at a file that is not there")
        }
      })

      await t.test("a job that is gone still ends the capture from under a thumbnail upload", async () => {
        await assert.rejects(capture(["sections", "sectionThumbs"], { goneOnThumbs: true }), JobGoneError)
      })
    } finally {
      await closeRenderer()
      await browser.close()
    }
  })
})
