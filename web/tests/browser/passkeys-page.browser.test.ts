// /passkeys relies on App's session check: only a real 401 says "Sign in", any other failure is the retry state.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { startApp, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

const open = async () => {
  const t = await app.session()
  t.on("GET", "/api/passkeys", () => ({ json: { devices: [{ id: "k1", label: "Chrome on Mac", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null }] } }))
  return t
}

test("a network error or a 500 on /passkeys shows the retry state, never Sign in, and Try again recovers", async () => {
  for (const reply of [{ abort: true }, { status: 500, json: { error: "boom" } }]) {
    const t = await open()
    const { page } = t
    let down = true
    t.on("GET", "/api/me", () => (down ? reply : undefined))
    await t.goto("/passkeys")
    await page.getByText("Couldn't reach Snip.").waitFor()
    assert.equal(await page.getByText("Sign in to manage passkeys").count(), 0)

    down = false
    await page.getByRole("button", { name: "Try again" }).click()
    await page.getByRole("heading", { name: "Your devices" }).waitFor()
    await page.getByText("Chrome on Mac").waitFor()
  }
})

test("a 401 on /passkeys is signed out: it asks to sign in", async () => {
  const t = await open()
  const { page } = t
  t.on("GET", "/api/me", () => ({ status: 401, json: {} }))
  await t.goto("/passkeys")
  await page.getByRole("heading", { name: "Sign in to manage passkeys" }).waitFor()
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page.waitForURL(/\/sign-in$/)
  assert.equal(await page.getByText("Couldn't reach Snip.").count(), 0)
  assert.equal(t.count("GET", "/api/passkeys"), 0, "nothing is loaded for a signed-out visitor")
})

test("signed in, /passkeys lists the devices and who is signed in", async () => {
  const t = await open()
  await t.goto("/passkeys")
  await t.page.getByRole("heading", { name: "Your devices" }).waitFor()
  await t.page.getByText("Chrome on Mac").waitFor()
  await t.page.getByText("Signed in as").waitFor()
})

test("opening /passkeys again asks nothing new, so a network blip after boot cannot sign the page out", async () => {
  const t = await open()
  const { page } = t
  let down = false
  t.on("GET", "/api/me", () => (down ? { abort: true } : undefined))
  await t.goto("/passkeys")
  await page.getByRole("heading", { name: "Your devices" }).waitFor()

  // App's check was answered at boot; from here on the network is gone. Leave and come back in the SPA.
  down = true
  await page.getByRole("link", { name: "Back to the library" }).click()
  await page.waitForURL((url) => url.pathname === "/")
  await page.goBack()
  await page.getByRole("heading", { name: "Your devices" }).waitFor()
  assert.equal(await page.getByText("Sign in to manage passkeys").count(), 0)
})
