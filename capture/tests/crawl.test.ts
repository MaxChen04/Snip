import { test } from "node:test"
import assert from "node:assert/strict"
import { duplicateOf, rankLinks } from "../src/capture"

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

test("links are ranked: pricing and enterprise early, login and legal last but kept", () => {
  const paths = [
    "/home", "/passport", "/connect", "/eve", "/security", "/cdn", "/products/ai", "/products/previews", "/products/rendering",
    "/for/startups", "/for/agencies", "/partners/aws", "/contact/sales", "/login", "/signup", "/docs", "/blog", "/legal/terms",
    "/privacy-policy", "/careers", "/templates", "/customers", "/changelog", "/help", "/pricing", "/enterprise", "/new", "/news",
  ]
  const ranked = rankLinks(paths.map((href) => ({ href: `https://vercel.com${href}`, nav: true }))).map((l) => new URL(l.href).pathname)
  assert.deepEqual([...ranked].sort(), [...paths].sort())
  assert.ok(ranked.indexOf("/pricing") < 10 && ranked.indexOf("/enterprise") < 10)
  assert.deepEqual(ranked.slice(-6), ["/login", "/signup", "/privacy-policy", "/careers", "/new", "/legal/terms"])
  assert.ok(ranked.indexOf("/news") < ranked.indexOf("/login"), "/news is not /new")
})

test("link ranking keeps nav links ahead of body links and DOM order for ties", () => {
  const link = (href: string, nav: boolean) => ({ href: `https://example.com${href}`, nav })
  const ranked = rankLinks([link("/zeta", false), link("/beta", true), link("/alpha", true), link("/deep/page", true), link("/top", false)])
  assert.deepEqual(ranked.map((l) => new URL(l.href).pathname), ["/beta", "/alpha", "/deep/page", "/zeta", "/top"])
})
