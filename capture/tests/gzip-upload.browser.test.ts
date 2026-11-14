import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { gunzipSync } from "node:zlib"
import { chromium } from "playwright"
import type { Job, PageUpload } from "../../web/shared/types"
import type { SnipApi } from "../src/api"
import { captureJob } from "../src/capture"

test("the HTML snapshot and styles file are gzipped only for a Worker that says it reads them", { timeout: 90_000 }, async (t) => {
  const previous = process.env.ALLOW_PRIVATE_URLS
  process.env.ALLOW_PRIVATE_URLS = "true"
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(`<!doctype html><title>Gzip fixture — café</title>
      <style>body{margin:0;height:900px;background:#fafafa}h1{font:700 40px Georgia;color:#123456}</style><h1>Gzip fixture — café 日本語</h1>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  const browser = await chromium.launch()
  try {
    for (const { name, features, gzipped, split = false } of [
      { name: "older Worker omits features", features: undefined, gzipped: false },
      { name: "Worker that predates the flag", features: ["sections", "live", "schemes"] as Job["features"], gzipped: false },
      { name: "Worker that advertises gzip", features: ["sections", "live", "schemes", "gzip"] as Job["features"], gzipped: true },
      { name: "Worker that takes split styles", features: ["sections", "live", "schemes", "gzip", "style-parts"] as Job["features"], gzipped: true, split: true },
    ]) {
      await t.test(name, async () => {
        const uploads = new Map<string, { bytes: Buffer; contentType: string }>()
        const pages: PageUpload[] = []
        const api = {
          control: async () => null,
          progress: async () => {},
          upload: async (key: string, body: Buffer | string, contentType: string) => {
            uploads.set(key, { bytes: Buffer.from(body), contentType })
            return key
          },
          addPage: async (_id: string, page: PageUpload) => { pages.push(page) },
          complete: async () => {},
        } as unknown as SnipApi
        const job: Job = { id: "gz", url, mode: "single", maxPages: 1, attempt: "a".repeat(32), lease: "b".repeat(32), resume: null, options: null, ...(features ? { features } : {}) }
        await captureJob(browser, api, job)
        assert.equal(pages.length, 1)
        const { snapshotKey, stylesKey } = pages[0]!
        assert.ok(snapshotKey && stylesKey)
        assert.equal(snapshotKey.endsWith(gzipped ? "/snapshot.gz.html" : "/snapshot.html"), true, snapshotKey)
        assert.equal(stylesKey.endsWith(gzipped ? "/styles.gz.json" : "/styles.json"), true, stylesKey)
        const html = uploads.get(snapshotKey)!
        const styles = uploads.get(stylesKey)!
        // The content type stays the file's own either way; the Worker unzips by name, not by type.
        assert.equal(html.contentType, "text/html; charset=utf-8")
        assert.equal(styles.contentType, "application/json")
        const text = (file: { bytes: Buffer }) => (gzipped ? gunzipSync(file.bytes) : file.bytes).toString("utf8")
        if (gzipped) assert.deepEqual([...html.bytes.subarray(0, 2)], [0x1f, 0x8b], "real gzip bytes")
        else assert.notDeepEqual([...html.bytes.subarray(0, 2)], [0x1f, 0x8b])
        assert.match(text(html), /Gzip fixture — café 日本語/)
        const parsed = JSON.parse(text(styles)) as { elements: unknown[]; tokens?: unknown }
        assert.ok(Array.isArray(parsed.elements) && parsed.elements.length > 0, "the styles file parses")
        assert.ok(!uploads.has(gzipped ? snapshotKey.replace(".gz.", ".") : snapshotKey.replace(".html", ".gz.html")), "only one of the two names is uploaded")
        // The split styles file goes only to a Worker that lists "style-parts", next to the full file.
        const summary = pages[0]!.stylesSummary
        const partsKeys = [...uploads.keys()].filter((k) => k.endsWith("/styles-parts.gzm"))
        if (!split) {
          assert.equal(summary, undefined)
          assert.deepEqual(partsKeys, [])
        } else {
          assert.ok(summary)
          assert.deepEqual(partsKeys, [stylesKey.replace("styles.gz.json", "styles-parts.gzm")])
          assert.equal(summary.parts.key, partsKeys[0])
          assert.equal(summary.elements, parsed.elements.length)
          const bytes = uploads.get(partsKeys[0]!)!.bytes
          const [at, len] = summary.parts.index
          const index = JSON.parse(gunzipSync(bytes.subarray(at, at + len)).toString("utf8")) as [string | null, string | null][]
          assert.ok(index.some(([, text]) => text?.includes("gzip fixture — café")), "the index holds lowercased own text")
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
