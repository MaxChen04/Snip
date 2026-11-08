import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { chromium } from "playwright"
import sharp from "sharp"
import type { Job, PageUpload } from "../../web/shared/types"
import type { SnipApi } from "../src/api"
import { captureJob } from "../src/capture"

test("scroll and hover uploads use only formats the destination Worker advertises", { timeout: 90_000 }, async (t) => {
  const previous = process.env.ALLOW_PRIVATE_URLS
  process.env.ALLOW_PRIVATE_URLS = "true"
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end(`<!doctype html><title>Recording compatibility fixture</title>
      <style>body{margin:0;height:1100px;background:linear-gradient(#eee,#999)}
      button{margin:40px;width:180px;height:60px;background:#e33;transition:background-color .2s}
      button:hover{background:#33e}</style><button>Hover fixture</button>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  const browser = await chromium.launch()
  try {
    // Reuse the browser while capabilities change between jobs: support belongs to the destination, not Chromium.
    for (const { name, formats, ext } of [
      { name: "older Worker omits capabilities", formats: undefined, ext: "gif" },
      { name: "upgraded Worker advertises WebM", formats: ["gif", "webm"] as Job["recordingFormats"], ext: "webm" },
      { name: "destination only advertises GIF", formats: ["gif"] as Job["recordingFormats"], ext: "gif" },
    ]) {
      await t.test(name, async () => {
        const uploads = new Map<string, { bytes: Buffer; contentType: string }>()
        const pages: PageUpload[] = []
        let completed = false
        const api = {
          control: async () => null,
          progress: async () => {},
          upload: async (key: string, body: Buffer | string, contentType: string) => {
            uploads.set(key, { bytes: Buffer.from(body), contentType })
            return key
          },
          addPage: async (_id: string, page: PageUpload) => { pages.push(page) },
          complete: async () => { completed = true },
        } as unknown as SnipApi
        const job: Job = {
          id: "formats", url, mode: "single", maxPages: 1, attempt: "a".repeat(32), resume: null, options: null,
          ...(formats ? { recordingFormats: formats } : {}),
        }
        await captureJob(browser, api, job)
        assert.equal(completed, true)
        assert.equal(pages.length, 1)
        const animations = pages[0]!.animations
        assert.deepEqual(animations.map((a) => a.kind).sort(), ["hover", "scroll"])
        for (const animation of animations) {
          assert.ok(animation.gifKey.endsWith(`.${ext}`), `${animation.kind}: ${animation.gifKey}`)
          const file = uploads.get(animation.gifKey)!
          assert.equal(file.contentType, ext === "gif" ? "image/gif" : "video/webm")
          if (ext === "gif") {
            const decoded = await sharp(file.bytes, { animated: true }).metadata()
            assert.equal(decoded.format, "gif")
            assert.ok(decoded.pages! > 1, "older galleries receive a real animated image")
          } else assert.equal(file.bytes.subarray(0, 4).toString("hex"), "1a45dfa3")
          assert.ok(animation.sheetKey && uploads.has(animation.sheetKey), "contact sheets remain available to agents")
          assert.ok(animation.meta!.frames.length > 1, "sampled frames remain available to agents")
        }
      })
    }
  } finally {
    await browser.close()
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_URLS
    else process.env.ALLOW_PRIVATE_URLS = previous
  }
})
