// The cloud window's error page, loaded the way main loads it: a file with a query.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const { pathToFileURL } = require("node:url")
const { chromium } = require("playwright")

const PAGE = pathToFileURL(path.join(__dirname, "..", "cloud-unreachable.html")).href
const CLOUD = "https://snip.tester.workers.dev/"

test("Try again loads the cloud library, not the error page again", async t => {
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.route("https://**", route => route.fulfill({ contentType: "text/html", body: "<title>Library</title>" }))
  await page.goto(`${PAGE}?url=${encodeURIComponent(CLOUD)}`)
  await page.click("#retry")
  await page.waitForURL(CLOUD)
  assert.equal(await page.title(), "Library")
})

test("Try again is not offered without an https address to load", async t => {
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage()
  for (const url of ["", "javascript:alert(1)", "http://snip.tester.workers.dev/"]) {
    await page.goto(`${PAGE}?url=${encodeURIComponent(url)}`)
    assert.equal(await page.locator("#retry").count(), 0, url)
    assert.equal(await page.locator("a.primary").count(), 1)
  }
})
