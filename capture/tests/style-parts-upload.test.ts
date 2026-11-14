import { test } from "node:test"
import assert from "node:assert/strict"
import { gunzipSync } from "node:zlib"
import { JobGoneError, uploadStyleParts } from "../src/api"

const styles = {
  viewport: { width: 1440, height: 900 },
  elements: [{ sel: "nav > a", text: "Pricing" }, { sel: "main" }],
  keyframes: [{ name: "fade", css: "@keyframes fade {}" }],
}

test("uploads one parts file next to the styles file and returns its summary", async () => {
  const uploads: { key: string; body: Buffer | string; type: string }[] = []
  const api = { upload: async (key: string, body: Buffer | string, type: string) => (uploads.push({ key, body, type }), key) }
  const summary = await uploadStyleParts(api, "refs/r/a/p0/styles.gz.json", styles)
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0]!.key, "refs/r/a/p0/styles-parts.gzm")
  assert.equal(summary?.parts.key, "refs/r/a/p0/styles-parts.gzm")
  assert.equal(summary?.elements, 2)
  const body = uploads[0]!.body as Buffer
  const [at, len] = summary!.parts.index
  assert.deepEqual(JSON.parse(gunzipSync(body.subarray(at, at + len)).toString()), [["nav > a", "pricing"], ["main", null]])
})

test("a failed upload leaves the page without a summary, but a gone job still stops the capture", async () => {
  assert.equal(await uploadStyleParts({ upload: async () => { throw new Error("500") } }, "refs/r/a/p0/styles.json", styles), undefined)
  await assert.rejects(uploadStyleParts({ upload: async () => { throw new JobGoneError() } }, "refs/r/a/p0/styles.json", styles), JobGoneError)
})
