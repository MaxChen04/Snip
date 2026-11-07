// The loopback session handoff is the one place a token crosses into main.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const { SESSION_COOKIE, sessionCookie, externalUrl, isHttpsOrigin } = require("../cloud-session.cjs")

const CLOUD = "https://snip.max.workers.dev"
const NOW = 1_760_000_000_000

test("a valid session becomes an httpOnly, secure cookie for the cloud origin", () => {
  const cookie = sessionCookie({ event: "session", token: "abc.def", url: `${CLOUD}/auth/owner?t=x` }, null, NOW)
  assert.deepEqual(cookie, {
    url: CLOUD,
    name: SESSION_COOKIE,
    value: "abc.def",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    expirationDate: Math.floor(NOW / 1000) + 30 * 24 * 60 * 60,
  })
})

test("the fallback url is used when the event has none", () => {
  assert.equal(sessionCookie({ token: "abc" }, CLOUD, NOW).url, CLOUD)
  assert.equal(sessionCookie({ token: "abc", url: "" }, `${CLOUD}/x`, NOW).url, CLOUD)
})

test("plain http, missing urls and junk tokens are refused", () => {
  assert.equal(sessionCookie({ token: "abc", url: "http://localhost:5173" }, CLOUD, NOW), null)
  assert.equal(sessionCookie({ token: "abc", url: "https://snip.max.workers.dev" }, null, NOW).url, CLOUD)
  assert.equal(sessionCookie({ token: "abc", url: "not a url" }, null, NOW), null)
  assert.equal(sessionCookie({ token: "abc" }, "http://127.0.0.1:8787", NOW), null)
  assert.equal(sessionCookie({ token: "" }, CLOUD, NOW), null)
  assert.equal(sessionCookie({ token: "has space" }, CLOUD, NOW), null)
  assert.equal(sessionCookie({ token: "line\nbreak" }, CLOUD, NOW), null)
  assert.equal(sessionCookie({ token: "x".repeat(4097) }, CLOUD, NOW), null)
  assert.equal(sessionCookie(null, CLOUD, NOW), null)
})

test("only http and https open in the browser", () => {
  assert.equal(externalUrl("https://dash.cloudflare.com/x"), "https://dash.cloudflare.com/x")
  assert.equal(externalUrl("http://example.com"), "http://example.com/")
  assert.equal(externalUrl("file:///etc/passwd"), null)
  assert.equal(externalUrl("javascript:alert(1)"), null)
  assert.equal(externalUrl("snip://settings/index.html"), null)
  assert.equal(externalUrl(undefined), null)
})

test("https detection is exact", () => {
  assert.equal(isHttpsOrigin("https://x.dev"), true)
  assert.equal(isHttpsOrigin("HTTPS://X.DEV"), true)
  assert.equal(isHttpsOrigin("http://x.dev"), false)
  assert.equal(isHttpsOrigin(""), false)
})
