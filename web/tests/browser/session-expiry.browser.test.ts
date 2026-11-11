// A 401 from any API call means the session is over: api.ts notices it and App goes to the signed-out state.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { reference, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

async function open(state: Parameters<App["session"]>[0] = {}) {
  const t = await app.session(state)
  // The harness mocks every URL containing /auth/, which also catches the sign-in page's own source file.
  await t.page.route(/\/src\//, (route) => route.continue())
  return t
}

const where = (page: { url(): string }) => new URL(page.url()).pathname + new URL(page.url()).search

test("a 401 while using the app goes to sign-in and remembers the page", async () => {
  const t = await open({ state: { references: { ref1: reference({ id: "ref1", title: "Poll Target", status: "capturing", progress: "Capturing 1/3: /" }) } }, clock: true })
  const { page } = t
  let signedOut = false
  t.on("GET", /^\/api\//, () => (signedOut ? { status: 401, json: {} } : undefined))
  await t.goto("/r/ref1?tab=tokens")
  await page.getByRole("heading", { name: "Poll Target" }).waitFor()

  signedOut = true
  await page.clock.fastForward(4500)
  await page.getByRole("heading", { name: "Sign in to Snip" }).waitFor()
  assert.equal(where(page), `/sign-in?next=${encodeURIComponent("/r/ref1?tab=tokens")}`)
  assert.equal(await page.getByText("Not signed in").isVisible(), false)
})

test("the bookmarklet's /add opened signed out goes to sign-in and comes back to it", async () => {
  const t = await open()
  const { page } = t
  t.on("GET", "/api/me", () => ({ status: 401, json: {} }))
  const add = "/add?url=" + encodeURIComponent("https://aaa.example.com/pricing?x=1")
  await t.goto(add)
  await page.getByRole("heading", { name: "Sign in to Snip" }).waitFor()
  assert.equal(where(page), `/sign-in?next=${encodeURIComponent(add)}`)
})

test("the home page opened signed out stays the landing page", async () => {
  const t = await open()
  const { page } = t
  t.on("GET", "/api/me", () => ({ status: 401, json: {} }))
  await t.goto("/")
  await until("the session check", () => t.count("GET", "/api/me") >= 1)
  await page.getByRole("link", { name: /sign in/i }).first().waitFor()
  assert.equal(where(page), "/")
})
