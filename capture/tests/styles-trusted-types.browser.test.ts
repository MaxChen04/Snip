import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { chromium } from "playwright"

const STYLES_JS = readFileSync(new URL("../src/inpage/styles.js", import.meta.url), "utf8")
const launch = () => chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined })

test("styles capture works on pages whose CSP enforces Trusted Types, even with policies blocked", async () => {
  const browser = await launch()
  try {
    for (const csp of ["require-trusted-types-for 'script'", "require-trusted-types-for 'script'; trusted-types 'none'"]) {
      const page = await browser.newPage()
      await page.route("https://tt.test/", (r) =>
        r.fulfill({ contentType: "text/html", headers: { "content-security-policy": csp }, body: `<!doctype html><h1 style="color:#123456">hi</h1>` }))
      await page.goto("https://tt.test/")
      const result = (await page.evaluate(`(${STYLES_JS})({ maxElements: 100 })`)) as { tokens: { colors: { value: string }[] } }
      assert.ok(JSON.stringify(result.tokens).includes("#123456"), csp)
      await page.close()
    }
  } finally {
    await browser.close()
  }
})
