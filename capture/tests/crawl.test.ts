import { test } from "node:test"
import assert from "node:assert/strict"
import { duplicateOf } from "../src/capture"

const root = new URL("https://vercel.com")
const visited = ["https://vercel.com/", "https://vercel.com/pricing", "https://vercel.com/home"]

test("a page whose canonical URL was already visited is a duplicate", () => {
  assert.equal(duplicateOf("https://vercel.com/home", "https://vercel.com/home", "https://vercel.com", root, visited), "https://vercel.com/")
  assert.equal(duplicateOf("https://vercel.com/home", "https://www.vercel.com/home", "https://vercel.com/pricing/?ref=x#top", root, visited), "https://vercel.com/pricing")
})

test("a page that redirected to an already visited URL is a duplicate", () => {
  assert.equal(duplicateOf("https://vercel.com/old", "https://vercel.com/pricing/", null, root, visited), "https://vercel.com/pricing")
})

test("a page is kept when its canonical is itself, unvisited, off-site or missing", () => {
  const keep = (final: string, canonical: string | null) => duplicateOf("https://vercel.com/about", final, canonical, root, visited)
  assert.equal(keep("https://vercel.com/about", "https://vercel.com/about/"), null)
  assert.equal(keep("https://vercel.com/about", "https://vercel.com/company"), null)
  assert.equal(keep("https://vercel.com/about", "https://example.com/"), null)
  assert.equal(keep("https://login.example.com/", null), null)
  assert.equal(keep("https://vercel.com/about", null), null)
  assert.equal(keep("https://vercel.com/about", "not a url"), null)
})
