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

// ---------------------------------------------------------------- the offer right after the owner link

const where = (page: { url(): string }) => new URL(page.url()).pathname + new URL(page.url()).search
const offer = (page: Awaited<ReturnType<typeof open>>["page"]) => page.getByRole("heading", { name: "Add a passkey for this device" })

/** A device that makes passkeys: a stand-in credential, so the page's own add action runs end to end. A string, because tsx would add helpers to a function that the page does not have. */
const FAKE_AUTHENTICATOR = `
  const bytes = () => new Uint8Array(4).buffer
  const created = {
    type: "public-key",
    id: "cred1",
    rawId: bytes(),
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
    response: { clientDataJSON: bytes(), attestationObject: bytes(), getTransports: () => ["internal"] },
  }
  Object.defineProperty(navigator.credentials, "create", { value: async () => created })
`
const NO_WEBAUTHN = `Object.defineProperty(window, "PublicKeyCredential", { value: undefined })`

test("a browser the owner link just signed in is offered a passkey, and adding one is the page's own add action", async () => {
  const t = await open()
  const { page } = t
  await page.addInitScript(FAKE_AUTHENTICATOR)
  t.on("GET", "/auth/passkey/register/options", () => ({ json: { challenge: "AAAA", user: { id: "AAAA", name: "owner1", displayName: "owner1" }, rp: { name: "Snip" } } }))
  t.on("POST", "/auth/passkey/register/verify", () => ({ json: { ok: true } }))
  await t.goto("/passkeys?new=1")
  await offer(page).waitFor()
  assert.equal(await page.getByRole("heading", { name: "Your devices" }).count(), 0, "the offer is the whole screen, not the device list")

  await page.getByLabel("Device name").fill("Work laptop")
  await page.getByRole("button", { name: "Add passkey" }).click()
  // Offer over: the device list, without the marker, with the device-label the person typed.
  await page.getByRole("heading", { name: "Your devices" }).waitFor()
  assert.equal(where(page), "/passkeys")
  assert.equal(t.list("POST", "/auth/passkey/register/verify")[0]!.body.deviceLabel, "Work laptop")
})

test("Not now on the offer goes to the library and registers nothing", async () => {
  const t = await open()
  const { page } = t
  await t.goto("/passkeys?new=1")
  await offer(page).waitFor()
  await page.getByRole("button", { name: "Not now" }).click()
  await page.waitForURL((url) => url.pathname === "/")
  assert.equal(t.count("GET", "/auth/passkey/register/options"), 0)
  assert.equal(t.count("POST", "/auth/passkey/register/verify"), 0)
})

test("no offer without the marker, after a passkey sign-in, or in a browser that cannot make passkeys", async () => {
  const plain = await open()
  await plain.goto("/passkeys")
  await plain.page.getByRole("heading", { name: "Your devices" }).waitFor()
  assert.equal(await offer(plain.page).count(), 0, "a plain visit is the device list")

  const viaPasskey = await open()
  viaPasskey.on("GET", "/api/me", () => ({ json: { login: "tester", ownerId: "owner1", method: "passkey" } }))
  await viaPasskey.goto("/passkeys?new=1")
  await viaPasskey.page.getByRole("heading", { name: "Your devices" }).waitFor()
  assert.equal(await offer(viaPasskey.page).count(), 0, "a session that came from a passkey has nothing to add by marker")

  const noWebAuthn = await open()
  await noWebAuthn.page.addInitScript(NO_WEBAUTHN)
  await noWebAuthn.goto("/passkeys?new=1")
  await noWebAuthn.page.getByRole("heading", { name: "Your devices" }).waitFor()
  assert.equal(await offer(noWebAuthn.page).count(), 0, "a browser without WebAuthn is not offered one")
})
