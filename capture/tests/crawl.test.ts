import { test } from "node:test"
import assert from "node:assert/strict"
import { duplicateOf, leftSite, promoteLinks, rankLinks, skipReason } from "../src/capture"

const root = new URL("https://vercel.com")

test("a page that redirected to another site has left the site", () => {
  const linear = new URL("https://linear.app")
  assert.equal(leftSite("https://linearcustomers.slack.com/join/shared_invite/abc", linear), "linearcustomers.slack.com")
  assert.equal(leftSite("https://app.linear.app/login", linear), "app.linear.app")
  assert.equal(leftSite("https://linear.app/join-slack", linear), null)
  assert.equal(leftSite("https://www.linear.app/join-slack", linear), null)
  assert.equal(leftSite("about:blank", linear), null)
  assert.equal(leftSite("not a url", linear), null)
})

test("a crawled link is skipped when it errored or left the site, not otherwise", () => {
  const linear = new URL("https://linear.app")
  assert.equal(skipReason("https://linear.app/javascript:openCookies()/", 404, linear), "returned 404")
  assert.equal(skipReason("https://linear.app/boom", 500, linear), "returned 500")
  assert.equal(skipReason("https://linearcustomers.slack.com/join/x", 200, linear), "left the site (linearcustomers.slack.com)")
  assert.equal(skipReason("https://linear.app/pricing", 200, linear), null)
  assert.equal(skipReason("https://linear.app/pricing", 304, linear), null)
  assert.equal(skipReason("https://linear.app/pricing", null, linear), null)
})
const visited = ["https://vercel.com/", "https://vercel.com/pricing", "https://vercel.com/home"]

const titles = new Map([
  ["https://vercel.com/", "Vercel: Build and deploy"],
  ["https://vercel.com/pricing", "Pricing - Vercel"],
])

test("a page whose canonical page was captured with the same title is a duplicate", () => {
  const home = "Vercel: Build and deploy"
  assert.equal(duplicateOf("https://vercel.com/home", "https://vercel.com/home", "https://vercel.com", home, root, visited, titles), "https://vercel.com/")
  assert.equal(duplicateOf("https://vercel.com/home", "https://www.vercel.com/home", "https://vercel.com/?ref=x#top", home, root, visited, titles), "https://vercel.com/")
})

test("a canonical shared by pages with different titles does not make them duplicates", () => {
  assert.equal(duplicateOf("https://vercel.com/about", "https://vercel.com/about", "https://vercel.com/", "About - Vercel", root, visited, titles), null)
  assert.equal(duplicateOf("https://vercel.com/about", "https://vercel.com/about", "https://vercel.com/", null, root, visited, titles), null)
  // After a resume the titles are gone, so a canonical alone never skips a page.
  assert.equal(duplicateOf("https://vercel.com/home", "https://vercel.com/home", "https://vercel.com/", "Vercel: Build and deploy", root, visited, new Map()), null)
})

test("a page that redirected to an already visited URL is a duplicate, whatever its title", () => {
  assert.equal(duplicateOf("https://vercel.com/old", "https://vercel.com/pricing/", null, "Old", root, visited, titles), "https://vercel.com/pricing")
  assert.equal(duplicateOf("https://vercel.com/old", "https://vercel.com/pricing/", null, "Old", root, visited, new Map()), "https://vercel.com/pricing")
})

test("a page is kept when its canonical is itself, uncaptured, off-site or missing", () => {
  const keep = (final: string, canonical: string | null) => duplicateOf("https://vercel.com/about", final, canonical, "Pricing - Vercel", root, visited, titles)
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
    "/for/startups", "/for/agencies", "/partners/aws", "/contact/sales", "/customers/openai", "/login", "/signup", "/docs", "/blog", "/legal/terms",
    "/privacy-policy", "/careers", "/templates", "/customers", "/changelog", "/help", "/pricing", "/enterprise", "/new", "/news",
  ]
  const ranked = rankLinks(paths.map((href) => ({ href: `https://vercel.com${href}`, nav: true }))).map((l) => new URL(l.href).pathname)
  assert.deepEqual([...ranked].sort(), [...paths].sort())
  assert.ok(ranked.indexOf("/pricing") < 10 && ranked.indexOf("/enterprise") < 10)
  assert.deepEqual(ranked.slice(-6), ["/login", "/signup", "/privacy-policy", "/careers", "/new", "/legal/terms"])
  assert.ok(ranked.indexOf("/news") < ranked.indexOf("/login"), "/news is not /new")
  assert.ok(ranked.indexOf("/customers") < ranked.indexOf("/docs") && ranked.indexOf("/docs") < ranked.indexOf("/customers/openai"), "only the top-level /customers is boosted")
  assert.ok(ranked.indexOf("/docs") < ranked.indexOf("/products/ai"), "only the top-level /products is boosted")
})

test("link ranking keeps nav links ahead of body links and DOM order for ties", () => {
  const link = (href: string, nav: boolean) => ({ href: `https://example.com${href}`, nav })
  const ranked = rankLinks([link("/zeta", false), link("/beta", true), link("/alpha", true), link("/deep/page", true), link("/top", false)])
  assert.deepEqual(ranked.map((l) => new URL(l.href).pathname), ["/beta", "/alpha", "/deep/page", "/zeta", "/top"])
})

test("the first page's links go ahead of a sitemap queue and low-value pages stay last", () => {
  const at = (path: string) => `https://linear.app${path}`
  const asLinks = (list: string[], nav: boolean) => list.map((path) => ({ href: at(path), nav }))
  const paths = (urls: string[]) => urls.map((u) => new URL(u).pathname)
  // The sitemap seed as capturePages ranks it ("/" is the page being captured), then the first page's ranked links.
  const queue = rankLinks(asLinks(["/about", "/agents", "/ai", "/careers", "/changelog", "/enterprise", "/pricing", "/login"], false)).map((l) => l.href)
  assert.deepEqual(paths(queue), ["/about", "/enterprise", "/pricing", "/agents", "/ai", "/changelog", "/careers", "/login"])
  const links = rankLinks(asLinks(["/", "/pricing", "/enterprise", "/homepage", "/login", "/features", "/signup"], true)).map((l) => l.href)

  const merged = promoteLinks(queue, links, [at("/")])
  // Queued links move up, visited "/" is not re-added, /login stays behind the other queued pages, unqueued /signup goes last.
  assert.deepEqual(paths(merged), ["/pricing", "/enterprise", "/features", "/homepage", "/about", "/agents", "/ai", "/changelog", "/careers", "/login", "/signup"])
})
