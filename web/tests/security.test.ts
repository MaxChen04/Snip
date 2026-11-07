import { test } from "node:test"
import assert from "node:assert/strict"
import { app } from "../worker/app"
import { allowedLogins, crossSiteWrite } from "../worker/auth"

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

test("no GitHub login is allowed until the owner sets one", async () => {
  assert.deepEqual(allowedLogins({ ALLOWED_GITHUB_LOGINS: "" } as Env), [])
  assert.deepEqual(allowedLogins({ ALLOWED_GITHUB_LOGINS: "your-github-login" } as Env), [])
  assert.deepEqual(allowedLogins({ ALLOWED_GITHUB_LOGINS: " Alice, your-github-login ,bob" } as Env), ["alice", "bob"])
  // Both GitHub credentials are present, so the routes mount and the allowlist is what refuses (§5.2).
  const env = { ALLOWED_GITHUB_LOGINS: "your-github-login", SESSION_SECRET: "s", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" } as unknown as Env
  const res = await app.request("https://snip.test/auth/login", {}, env, ctx)
  assert.equal(res.status, 503)
  assert.match(await res.text(), /ALLOWED_GITHUB_LOGINS/)
})

test("cross-site writes to the local API are refused", async () => {
  const req = (init: RequestInit) => new Request("http://localhost:5173/api/collections", { method: "POST", ...init })
  assert.equal(crossSiteWrite(req({ body: "{}", headers: { "content-type": "application/json", origin: "http://localhost:5173" } })), null)
  assert.equal(crossSiteWrite(req({ body: "{}", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" } })), null)
  assert.ok(crossSiteWrite(req({ body: "{}", headers: { "content-type": "text/plain" } })), "simple text/plain POST")
  assert.ok(crossSiteWrite(req({ body: "{}", headers: { "content-type": "application/json", origin: "https://evil.example" } })))
  assert.ok(crossSiteWrite(req({ headers: { "sec-fetch-site": "same-site" } })), "another localhost port is same-site, not same-origin")
  assert.equal(crossSiteWrite(new Request("http://localhost:5173/api/me", { headers: { origin: "https://evil.example" } })), null, "reads are left to CORS")

  const env = { DEV_LOGIN: "max", SESSION_SECRET: "s" } as unknown as Env
  const res = await app.request("http://localhost/api/collections", { method: "POST", body: JSON.stringify({ name: "x" }), headers: { "content-type": "text/plain" } }, env, ctx)
  assert.equal(res.status, 403)
})
