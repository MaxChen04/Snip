import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import { sign } from "../../worker/auth.ts"

// Screenshots of every browser page this branch adds, in light and dark.
// Needs the dev server on :5199 with web/.dev.vars present (DEV_LOGIN=max, seeded passkeys):
//   node --import tsx web/tests/screenshots/passkeys.mjs

const BASE = process.env.BASE ?? "http://localhost:5199"
const OUT = process.env.OUT ?? "/Users/Maxsc/.factory/worktrees/98cfc78f/screenshots/worker"
const OWNER_LINK_SECRET = process.env.OWNER_LINK_SECRET ?? "dev-owner-link-secret"

mkdirSync(OUT, { recursive: true })

/** The engine mints this in Node; the page needs the same signed payload the Worker verifies. */
async function ownerLink({ port = 43111, ownerId = "max" } = {}) {
  const exp = Math.floor(Date.now() / 1000) + 600
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")
  const payload = `snip-owner-v1|${ownerId}|${exp}|${nonce}|${port}`
  return `${payload}.${(await sign(OWNER_LINK_SECRET, payload)).split(".")[1]}`
}

async function shoot(page, name, { fullPage = false, wait = 400 } = {}) {
  await page.waitForTimeout(wait)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage })
  console.log(`${name}.png`)
}

async function main() {
  const browser = await chromium.launch()

  for (const scheme of ["light", "dark"]) {
    // A fresh link per pass: a link works exactly once, which is the point of the nonce.
    // Port 0 means "no desktop app is listening", so the POST redirects to the library instead of
    // a loopback. The browser then holds a real rs_session cookie set by the real route.
    const token = await ownerLink({ port: 0 })

    // The owner landing auto-submits on load, so it is captured with scripting off: the page is
    // static HTML and CSS, and what a person sees before the redirect is exactly this.
    const staticContext = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2, javaScriptEnabled: false, colorScheme: scheme })
    const staticPage = await staticContext.newPage()
    await staticPage.goto(`${BASE}/auth/owner?t=${encodeURIComponent(token)}`)
    await staticPage.waitForSelector("#snip-owner")
    await shoot(staticPage, `owner-link-${scheme}`)
    await staticContext.close()

    // Signed out first, for the passkey sign-in page.
    const anon = await browser.newContext({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 2, colorScheme: scheme })
    const anonPage = await anon.newPage()
    await anonPage.goto(`${BASE}/sign-in`)
    await anonPage.waitForFunction(() => !!document.querySelector("[data-slot=button]"), null, { timeout: 15_000 }).catch(() => {})
    await shoot(anonPage, `passkey-sign-in-${scheme}`, { wait: 900 })
    await anon.close()

    // Now sign in through the real owner link, which is what a browser does.
    const context = await browser.newContext({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 2, colorScheme: scheme })
    const page = await context.newPage()
    await page.goto(`${BASE}/auth/owner?t=${encodeURIComponent(token)}`)
    await page.waitForURL((url) => !url.pathname.startsWith("/auth/owner"), { timeout: 15_000 })

    await page.goto(`${BASE}/passkeys`)
    await page.waitForSelector("text=Your devices")
    await page.waitForSelector("text=MacBook Pro")
    await shoot(page, `passkeys-${scheme}`, { fullPage: true })

    const remove = page.getByRole("button", { name: /^Remove / }).first()
    await remove.click()
    await page.waitForSelector("text=Remove this passkey?")
    await shoot(page, `passkeys-remove-${scheme}`, { wait: 250 })
    await page.keyboard.press("Escape")
    await page.waitForTimeout(200)

    await page.getByRole("button", { name: "Sign out all devices" }).click()
    await page.waitForSelector("text=Sign out all devices?")
    await shoot(page, `passkeys-sign-out-all-${scheme}`, { wait: 250 })
    await page.keyboard.press("Escape")

    // Narrow viewport: the device list and the dialogs have to hold at phone width.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${BASE}/passkeys`)
    await page.waitForSelector("text=Your devices")
    await shoot(page, `passkeys-mobile-${scheme}`, { fullPage: true })

    await context.close()
  }

  await browser.close()
}

await main()
