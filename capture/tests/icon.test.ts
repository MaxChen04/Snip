import { test } from "node:test"
import assert from "node:assert/strict"
import { iconType } from "../src/capture"

test("a site's icon is recognised by its bytes, not by what the site called it", () => {
  const bytes = (...b: number[]) => Buffer.from(b)
  assert.equal(iconType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.ext, "png")
  assert.equal(iconType(bytes(0, 0, 1, 0, 1, 0))?.ext, "ico")
  assert.equal(iconType(Buffer.from("GIF89a"))?.ext, "gif")
  assert.equal(iconType(bytes(0xff, 0xd8, 0xff, 0xe0))?.ext, "jpg")
  assert.equal(iconType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))?.ext, "webp")
  assert.equal(iconType(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))?.type, "image/svg+xml")
  assert.equal(iconType(Buffer.from("<svg viewBox='0 0 1 1'/>"))?.ext, "svg")
  // A soft 404 served for the icon URL is a page, not an icon, even when it contains inline SVG.
  assert.equal(iconType(Buffer.from("<!doctype html><html><body><svg></svg>Not found</body></html>")), null)
  assert.equal(iconType(Buffer.from("")), null)
})
