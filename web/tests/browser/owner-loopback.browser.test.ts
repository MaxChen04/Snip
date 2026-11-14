// The Mac app's side of the owner link, in a real browser: the Worker redirects to the engine's loopback
// /done page with the session and the link's nonce in the fragment, and the page posts both to /store.
// The loopback is the engine's own (desktop/provision/transfer.cjs), so the page, its CSP and the nonce check run for real.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"

type Loopback = { listening: Promise<number>; token: Promise<string>; nonce: string; close(): void; readonly closed: boolean }
const { startLoopback } = createRequire(import.meta.url)("../../../desktop/provision/transfer.cjs") as { startLoopback(options: { timeoutMs: number }): Loopback }

let browser: Browser
before(async () => void (browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })))
after(async () => browser?.close())

async function openDone(fragment: (nonce: string) => string, loopback?: Loopback) {
  const own = loopback ?? startLoopback({ timeoutMs: 30_000 })
  const port = await own.listening
  const page = await browser.newPage()
  const stores: string[] = []
  page.on("request", (request) => request.url().endsWith("/store") && stores.push(request.url()))
  await page.goto(`http://127.0.0.1:${port}/done${fragment(own.nonce)}`)
  return { loopback: own, page, stores }
}

test("the page posts the session with the nonce the Worker put in the redirect, and the loopback takes it", async () => {
  // The Worker percent-encodes the session; the page hands it over exactly as it arrived.
  const { loopback, page } = await openDone((nonce) => `#token=owner%3Amax%7C1.sig&nonce=${nonce}`)
  await page.getByText("You can close this tab and return to Snip.").waitFor()
  assert.equal(await loopback.token, "owner%3Amax%7C1.sig")
  assert.equal(new URL(page.url()).hash, "", "the fragment is dropped once it is stored")
  loopback.close()
})

test("a redirect with another link's nonce is refused: the page says so and the loopback keeps waiting for the real one", async () => {
  const loopback = startLoopback({ timeoutMs: 30_000 })
  let taken: string | null = null
  loopback.token.then((value) => (taken = value), () => {})

  const forged = await openDone(() => `#token=forged&nonce=${"f".repeat(32)}`, loopback)
  await forged.page.getByText("Sign-in could not be completed. Return to Snip and try again.").waitFor()
  assert.equal(await forged.page.getByText("You can close this tab").count(), 0, "a refused post is not reported as a sign-in")
  assert.equal(taken, null)
  assert.equal(loopback.closed, false)

  const real = await openDone((nonce) => `#token=real&nonce=${nonce}`, loopback)
  await real.page.getByText("You can close this tab and return to Snip.").waitFor()
  assert.equal(await loopback.token, "real")
  loopback.close()
})

test("a redirect with no nonce, from a Worker that was not redeployed, tells the person to update cloud and posts nothing", async () => {
  const { loopback, page, stores } = await openDone(() => "#token=abc")
  await page.getByText(/Your cloud library is older than this Snip\. In Snip, open Settings → Cloud → Update cloud library, or run npm run update\. Then sign in again\./).waitFor()
  assert.deepEqual(stores, [], "nothing is posted without a nonce")
  assert.equal(loopback.closed, false)
  loopback.close()
})
