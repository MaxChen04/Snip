import { test } from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import { SESSION_COOKIE, STATE_COOKIE, sign, verify } from "../worker/auth"
import { mcpApiHandler } from "../worker/mcp"
import { safeNext, signInPath } from "../shared/safe-next"
import { createAssertion, createCredential, type Credential } from "./helpers/webauthn"

// An MCP client authorizing on a passkeys-only install: /authorize → /sign-in → passkey → back to
// /authorize → consent → code. This is the path a v1 install with no GitHub App depends on.

const PUBLIC_URL = "https://snip.test"
const RP_ID = "snip.test"
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

type EnvOverrides = Record<string, unknown>

/** Just enough of OAuthProvider to drive the consent pages without a real grant store. */
function oauthStub() {
  const calls = { completed: [] as Record<string, unknown>[] }
  const provider = {
    async parseAuthRequest() {
      return { clientId: "mcp-client", scope: ["references"] }
    },
    async describeConsent() {
      return { clientName: "Claude", redirectHost: "claude.ai" }
    },
    async beginConsent() {
      return { handle: "handle-1", headers: new Headers({ "set-cookie": "prov=1; Path=/" }) }
    },
    async approveConsent() {
      return { request: { scope: ["references"] }, headers: new Headers() }
    },
    async denyConsent() {
      return { headers: new Headers({ location: "https://claude.ai/callback?error=access_denied&state=xyz" }) }
    },
    async completeAuthorization(options: Record<string, unknown>) {
      calls.completed.push(options)
      return { redirectTo: "https://claude.ai/callback?code=abc123&state=xyz" }
    },
  }
  return { provider, calls }
}

async function setup() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"] }))
  const db = (await mf.getD1Database("DB")) as unknown as D1Database
  const dir = new URL("../migrations/", import.meta.url)
  for (const migration of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(migration, dir), "utf8")
    const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
    await db.batch(statements.map((statement) => db.prepare(statement)))
  }
  await db.prepare(`INSERT INTO owners (id, label, created_at) VALUES ('max', 'Max', '2026-01-01T00:00:00Z')`).run()
  const env = { DB: db, SESSION_SECRET: "session-secret", OWNER_LINK_SECRET: "owner-link-secret", PUBLIC_URL } as unknown as Env

  const { provider, calls } = oauthStub()
  const call = (path: string, init: RequestInit = {}, overrides: EnvOverrides = {}) =>
    app.request(`${PUBLIC_URL}${path}`, init, { ...env, OAUTH_PROVIDER: provider, ...overrides } as Env, ctx)
  /** localhost is where DEV_LOGIN applies, standing in for the owner already having a session. */
  const local = (path: string, init: RequestInit = {}, overrides: EnvOverrides = {}) =>
    app.request(`http://localhost${path}`, init, { ...env, OAUTH_PROVIDER: provider, ...overrides } as Env, ctx)

  return { mf, db, env, call, local, calls, provider }
}

type Ctx = Awaited<ReturnType<typeof setup>>

async function withWorker(fn: (ctx: Ctx) => Promise<void>) {
  const ctx = await setup()
  try {
    await fn(ctx)
  } finally {
    await ctx.mf.dispose()
  }
}

/** Enrols one passkey through the real routes, as the owner link flow does. */
async function registerPasskey(ctx: Ctx): Promise<Credential> {
  const options = (await (await ctx.local("/auth/passkey/register/options", {}, { DEV_LOGIN: "max" })).json()) as { challenge: string }
  const { response, credential } = await createCredential({ rpID: RP_ID, origin: PUBLIC_URL, challenge: options.challenge })
  const res = await ctx.local(
    "/auth/passkey/register/verify",
    { method: "POST", body: JSON.stringify({ response, deviceLabel: "MacBook Pro" }), headers: { "content-type": "application/json" } },
    { DEV_LOGIN: "max" },
  )
  assert.equal(res.status, 200, await res.clone().text())
  return credential
}

/** Signs in with that passkey and returns the session cookie. */
async function passkeySignIn(ctx: Ctx, credential: Credential): Promise<string> {
  const options = (await (await ctx.call("/auth/passkey/login/options")).json()) as { challenge: string }
  const assertion = await createAssertion({ rpID: RP_ID, origin: PUBLIC_URL, challenge: options.challenge, credential })
  const res = await ctx.call("/auth/passkey/login/verify", {
    method: "POST",
    body: JSON.stringify({ response: assertion.response }),
    headers: { "content-type": "application/json" },
  })
  assert.equal(res.status, 200, await res.clone().text())
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  assert.ok(cookie, "passkey sign-in sets a session")
  return cookie!.split(";")[0]!
}

// The authorization request a client makes, with a query worth preserving.
const AUTHORIZE = "/authorize?client_id=mcp-client&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcallback&response_type=code&state=xyz&code_challenge=abc"

// ---------- The passkeys-only journey ----------

test("an unauthenticated MCP client is sent to the passkey page and comes back to consent", () =>
  withWorker(async (ctx) => {
    const credential = await registerPasskey(ctx)

    // 1. No session: /authorize must not send the client to the GitHub route.
    const first = await ctx.call(AUTHORIZE)
    assert.equal(first.status, 302)
    const location = first.headers.get("location")!
    assert.match(location, /^\/sign-in\?next=/, "to the passkey page, not /auth/login")
    assert.equal(location.includes("/auth/login"), false)

    const next = new URL(location, PUBLIC_URL).searchParams.get("next")!
    assert.equal(next, AUTHORIZE, "the whole authorize URL survives, query included")

    // 2. The passkey page is served by the SPA, but its supporting method is anonymous and honest.
    const methods = (await (await ctx.call("/auth/methods")).json()) as { github: boolean; hasPasskeys: boolean }
    assert.deepEqual(methods, { github: false, hasPasskeys: true }, "a passkeys-only install offers no GitHub link")

    // 3. Passkey sign-in.
    const cookie = await passkeySignIn(ctx, credential)

    // 4. Back to exactly where the client asked, now signed in: consent.
    const consent = await ctx.call(next, { headers: { cookie } })
    assert.equal(consent.status, 200)
    const html = await consent.text()
    assert.match(html, /Allow Claude to use Snip\?/)
    assert.match(html, /Signed in as <code>max<\/code>/)

    // 5. Approve, and the client gets its code for the owner identity.
    const approved = await ctx.call("/authorize", {
      method: "POST",
      body: new URLSearchParams({ handle: "handle-1", decision: "approve" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    })
    assert.equal(approved.status, 302)
    assert.equal(approved.headers.get("location"), "https://claude.ai/callback?code=abc123&state=xyz")
    assert.equal(ctx.calls.completed.length, 1)
    assert.deepEqual(ctx.calls.completed[0]!.userId, "max", "the grant belongs to the owner identity")
    assert.deepEqual(ctx.calls.completed[0]!.props, { ownerId: "max", epoch: 0 }, "the grant records the sign-out epoch it was minted at")
  }))

test("an already signed-in client skips the page and lands on consent directly", () =>
  withWorker(async (ctx) => {
    await registerPasskey(ctx)
    const cookie = `${SESSION_COOKIE}=${await sign(ctx.env.SESSION_SECRET, `owner:max|${Date.now() + 86_400_000}|passkey|0`)}`
    const res = await ctx.call(AUTHORIZE, { headers: { cookie } })
    assert.equal(res.status, 200)
    assert.match(await res.text(), /Allow Claude to use Snip\?/)
  }))

test("denying consent still redirects to the client and issues no code", () =>
  withWorker(async (ctx) => {
    const cookie = `${SESSION_COOKIE}=${await sign(ctx.env.SESSION_SECRET, `owner:max|${Date.now() + 86_400_000}|passkey|0`)}`
    const denied = await ctx.call("/authorize", {
      method: "POST",
      body: new URLSearchParams({ handle: "handle-1", decision: "deny" }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    })
    assert.equal(denied.status, 302)
    assert.equal(ctx.calls.completed.length, 0)
  }))

// ---------- Open redirects ----------

test("the next path refuses every shape of open redirect", () => {
  const hostile = [
    "https://evil.example",
    "http://evil.example/path",
    "//evil.example",
    "///evil.example",
    "/\\evil.example",
    "/%5Cevil.example",
    "/%2F%2Fevil.example",
    "\\evil.example",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "/ok\n/evil.example",
    "/ok\r/evil",
    "/ok\u0000",
    "",
    "   ",
    "evil.example",
    "?next=//evil.example",
    "#//evil.example",
    null,
    undefined,
    42,
    {},
  ]
  for (const value of hostile) {
    assert.equal(safeNext(value), "/", `${JSON.stringify(value)} must not escape the origin`)
    assert.equal(signInPath(value as string | null).includes("next="), false, `${JSON.stringify(value)} must be dropped`)
  }

  // A long value is a probe, not a redirect.
  assert.equal(safeNext(`/${"a".repeat(3000)}`), "/")
})

test("the next path keeps every same-origin path the app actually uses", () => {
  for (const value of ["/", "/guide", "/r/abc123", "/passkeys", AUTHORIZE, "/?collection=abc", "/guide#setup", "/a%20b"]) {
    assert.equal(safeNext(value), value, value)
  }
  // Percent-encoded characters inside a legitimate path are preserved as written.
  assert.equal(safeNext("/r/a%2Fb"), "/r/a%2Fb")
  // An unparseable escape is not trusted through unchanged.
  assert.equal(safeNext("/%zz"), "/")
})

test("the sign-in path omits the parameter when there is nowhere to go back to", () => {
  assert.equal(signInPath("/"), "/sign-in")
  assert.equal(signInPath(null), "/sign-in")
  assert.equal(signInPath(undefined), "/sign-in")
  assert.equal(signInPath("/guide"), "/sign-in?next=%2Fguide")
  assert.equal(new URL(signInPath(AUTHORIZE), PUBLIC_URL).searchParams.get("next"), AUTHORIZE)
})

test("/authorize never emits a redirect that leaves the origin, whatever the query", () =>
  withWorker(async (ctx) => {
    // A client's own parameters may legitimately name other hosts (`redirect_uri` is one); what
    // must never happen is the *navigation* leaving the origin, or an attacker-supplied `next` /
    // `return` becoming the destination.
    const probes = [
      "/authorize?client_id=x&redirect_uri=https%3A%2F%2Fevil.example",
      "/authorize?next=//evil.example",
      "/authorize?next=https://evil.example",
      "/authorize?redirect_uri=%2F%2Fevil.example&client_id=x",
      "/authorize?client_id=x&next=%2F%2Fevil.example",
    ]
    for (const path of probes) {
      const res = await ctx.call(path)
      assert.equal(res.status, 302)
      const location = res.headers.get("location")!
      const asUrl = new URL(location, PUBLIC_URL)
      assert.equal(asUrl.origin, PUBLIC_URL, `${path} must stay on this origin, got ${location}`)

      // The destination the page will navigate to is path-only, and re-validating it changes nothing.
      const target = asUrl.searchParams.get("next")
      assert.ok(target, `${path} must carry a next path`)
      assert.ok(target!.startsWith("/") && !target!.startsWith("//"), `${path} → ${target}`)
      assert.equal(safeNext(target), target, "the next path is already in its safe form")
    }
  }))

test("the GitHub flow's next is validated before it is ever handed to GitHub", () =>
  withWorker(async (ctx) => {
    const github = { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", ALLOWED_GITHUB_LOGINS: "max" }
    // The state cookie is what the callback later obeys, so the hostile value must not survive into
    // it. Verify with the same function `finishLogin` uses, not a reimplementation.
    const nextOf = async (path: string) => {
      const res = await ctx.call(path, {}, github)
      assert.equal(res.status, 302)
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${STATE_COOKIE}=`))
      assert.ok(cookie, "the round trip carries a signed state")
      const payload = await verify(ctx.env.SESSION_SECRET, decodeURIComponent(cookie!.split(";")[0]!.slice(STATE_COOKIE.length + 1)))
      assert.ok(payload, "the state is signed with SESSION_SECRET")
      return payload!.split("|").slice(1).join("|")
    }

    assert.equal(await nextOf(`/auth/login?next=${encodeURIComponent("//evil.example/steal")}`), "/")
    assert.equal(await nextOf(`/auth/login?next=${encodeURIComponent("https://evil.example")}`), "/")
    assert.equal(await nextOf(`/auth/login?next=${encodeURIComponent("/\\evil.example")}`), "/")
    assert.equal(await nextOf("/auth/login?next=%2Fpasskeys"), "/passkeys", "a legitimate next is preserved")
    assert.equal(await nextOf("/auth/login?next=%2Fauthorize%3Fclient_id%3Dx%26state%3Dy"), "/authorize?client_id=x&state=y")
  }))

test("the SPA serves /sign-in on a direct navigation", async () => {
  // The detour is only worth anything if the browser can actually load the page. `/sign-in` is a
  // client route, so it must resolve through the asset layer's SPA fallback and must NOT be listed
  // in run_worker_first, where the Worker would answer it instead (and 404).
  const raw = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")
  // Every comment in this file is a full-line comment, so dropping those lines leaves plain JSON.
  const config = JSON.parse(
    raw
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n"),
  ) as { assets: { not_found_handling: string; run_worker_first: string[] } }

  assert.equal(config.assets.not_found_handling, "single-page-application", "unknown paths fall through to index.html")

  // Match the same way the asset layer does: a rule ending in `/*` is a prefix, anything else is exact.
  const intercepted = (path: string) =>
    config.assets.run_worker_first.some((rule) => (rule.endsWith("/*") ? path === rule.slice(0, -2) || path.startsWith(rule.slice(0, -1)) : path === rule))

  for (const path of ["/sign-in", "/passkeys", "/guide", "/"]) {
    assert.equal(intercepted(path), false, `${path} is a client route and must be left to the SPA`)
  }
  // The routes that must reach the Worker still do, so this is not a vacuous assertion.
  for (const path of ["/authorize", "/api/me", "/auth/passkey/login/options", "/auth/methods"]) {
    assert.equal(intercepted(path), true, `${path} must reach the Worker`)
  }
})

// ---------- A legacy GitHub-configured install ----------

test("a GitHub-configured install still signs in, and still offers the fallback", () =>
  withWorker(async (ctx) => {
    const github = { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", ALLOWED_GITHUB_LOGINS: "max" }

    const methods = (await (await ctx.call("/auth/methods", {}, github)).json()) as { github: boolean; hasPasskeys: boolean }
    assert.deepEqual(methods, { github: true, hasPasskeys: false }, "the page is told GitHub is available")

    const login = await ctx.call("/auth/login?next=%2Fauthorize%3Fclient_id%3Dx", {}, github)
    assert.equal(login.status, 302)
    const toGitHub = new URL(login.headers.get("location")!)
    assert.equal(toGitHub.origin, "https://github.com")
    assert.equal(toGitHub.searchParams.get("client_id"), "id")
    assert.equal(toGitHub.searchParams.get("redirect_uri"), `${PUBLIC_URL}/auth/callback`)

    // A GitHub session reaches consent exactly as before: the detour change does not affect it,
    // because a signed-in request never takes the detour.
    const cookie = `${SESSION_COOKIE}=${await sign(ctx.env.SESSION_SECRET, `owner:max|${Date.now() + 86_400_000}|github|0`)}`
    const consent = await ctx.call(AUTHORIZE, { headers: { cookie } }, github)
    assert.equal(consent.status, 200)
    assert.match(await consent.text(), /Allow Claude to use Snip\?/)

    // And an unauthenticated client on that install still goes through the passkey page, which the
    // page pairs with a GitHub link because /auth/methods reports it.
    const detached = await ctx.call(AUTHORIZE, {}, github)
    assert.equal(detached.status, 302)
    assert.match(detached.headers.get("location")!, /^\/sign-in\?next=/)
  }))

test("a half-configured install offers neither dead end", () =>
  withWorker(async (ctx) => {
    // A client id with no secret cannot complete a sign-in (§5.2), so GitHub is not offered.
    const methods = (await (await ctx.call("/auth/methods", {}, { GITHUB_CLIENT_ID: "id" })).json()) as { github: boolean }
    assert.equal(methods.github, false)
    assert.equal((await ctx.call("/auth/login", {}, { GITHUB_CLIENT_ID: "id" })).status, 404)
  }))

/** One MCP request as the OAuth provider hands it over: the token is already validated and the grant's props ride on ctx. */
function mcpCall(env: Env, props: Record<string, unknown>) {
  const request = new Request(`${PUBLIC_URL}/mcp`, {
    method: "POST",
    // The MCP handler validates the Host header, which a bare Request does not populate.
    headers: { host: RP_ID, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } }),
  })
  return mcpApiHandler.fetch(request, env, { waitUntil() {}, props } as unknown as ExecutionContext)
}

const signOutEverywhere = (ctx: Ctx, cookie: string) => ctx.call("/api/sign-out-all", { method: "POST", body: "{}", headers: { cookie, "content-type": "application/json" } })
const ownerCookie = async (ctx: Ctx, epoch: number) => `${SESSION_COOKIE}=${await sign(ctx.env.SESSION_SECRET, `owner:max|${Date.now() + 86_400_000}|owner|${epoch}`)}`

test("sign out everywhere disconnects an agent that was already connected", () =>
  withWorker(async (ctx) => {
    const cookie = await ownerCookie(ctx, 0)
    const approve = (headers: Record<string, string>) =>
      ctx.call("/authorize", { method: "POST", body: new URLSearchParams({ handle: "handle-1", decision: "approve" }), headers: { ...headers, "content-type": "application/x-www-form-urlencoded" } })
    assert.equal((await approve({ cookie })).status, 302)
    const grant = ctx.calls.completed[0]!.props as Record<string, unknown>
    assert.equal((await mcpCall(ctx.env, grant)).status, 200, "the agent is connected")

    assert.equal((await signOutEverywhere(ctx, cookie)).status, 200)
    const refused = await mcpCall(ctx.env, grant)
    assert.equal(refused.status, 401, "the same grant is refused after sign out everywhere")
    assert.deepEqual(await refused.json(), { error: "unauthorized" })

    // Connecting again mints a grant at the new epoch, and that one works.
    assert.equal((await approve({ cookie: await ownerCookie(ctx, 1) })).status, 302)
    const again = ctx.calls.completed[1]!.props as Record<string, unknown>
    assert.deepEqual(again, { ownerId: "max", epoch: 1 })
    assert.equal((await mcpCall(ctx.env, again)).status, 200)
  }))

test("a grant minted before grants carried an epoch works until the first sign out everywhere", () =>
  withWorker(async (ctx) => {
    const legacy = { ownerId: "max" }
    assert.equal((await mcpCall(ctx.env, legacy)).status, 200)
    assert.equal((await signOutEverywhere(ctx, await ownerCookie(ctx, 0))).status, 200)
    assert.equal((await mcpCall(ctx.env, legacy)).status, 401)
  }))

test("a dev session's grant records the real epoch, so it is revoked like any other", () =>
  withWorker(async (ctx) => {
    await ctx.db.prepare(`UPDATE owners SET sessions_epoch = 3`).run()
    const approved = await ctx.local(
      "/authorize",
      { method: "POST", body: new URLSearchParams({ handle: "handle-1", decision: "approve" }), headers: { "content-type": "application/x-www-form-urlencoded" } },
      { DEV_LOGIN: "max" },
    )
    assert.equal(approved.status, 302)
    const grant = ctx.calls.completed[0]!.props as Record<string, unknown>
    assert.deepEqual(grant, { ownerId: "max", epoch: 3 })
    assert.equal((await mcpCall(ctx.env, grant)).status, 200)
    await ctx.db.prepare(`UPDATE owners SET sessions_epoch = sessions_epoch + 1`).run()
    assert.equal((await mcpCall(ctx.env, grant)).status, 401)
  }))
