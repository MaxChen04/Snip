// The owner link is the one URL that belongs in the Settings window: a person opens it
// in another browser (contracts §4.2, §4.2.1). This module decides what counts as one,
// so a session token can never be mistaken for it.
const test = require("node:test")
const assert = require("node:assert/strict")
const { ownerLinkFrom, LINK_NOTE, LINK_TTL_MS, OWNER_PATH } = require("../cloud-link.cjs")

const CLOUD = "https://snip.max.workers.dev"
const LINK = `${CLOUD}/auth/owner?t=${encodeURIComponent("snip-owner-v1|max|1793600400|6f1c0a9e|0")}.c2lnbmF0dXJl`

test("the link arrives as a step, a human action, or a result", () => {
  // A step's event data nests what the step returned: `{ message, data: { url } }`.
  assert.equal(ownerLinkFrom({ v: 1, event: "step", step: "owner-mint", status: "ok", data: { message: "Link ready", data: { url: LINK } } }, CLOUD), LINK)
  assert.equal(ownerLinkFrom({ v: 1, event: "step", step: "owner-mint", status: "ok", data: { url: LINK } }, CLOUD), LINK)
  assert.equal(ownerLinkFrom({ v: 1, event: "human", step: "owner-open", action: "open_url", url: LINK }, CLOUD), LINK)
  assert.equal(ownerLinkFrom({ v: 1, event: "result", ok: true, code: "OK", data: { url: LINK } }, CLOUD), LINK)
})

test("a session event is never read, even if it carries a url", () => {
  // The token and the link travel in the same run; only one of them may reach the window.
  assert.equal(ownerLinkFrom({ v: 1, event: "session", token: "secret", url: LINK }, CLOUD), null)
})

test("anything that is not a minted owner link is refused", () => {
  const refused = [
    { v: 1, event: "step", step: "preflight", status: "ok", data: { url: LINK } },
    { v: 1, event: "human", step: "r2", action: "enable_r2", url: LINK },
    { v: 1, event: "human", step: "owner-open", action: "open_url", url: `${CLOUD}/passkeys` },
    { v: 1, event: "human", step: "owner-open", action: "open_url", url: `${CLOUD}/auth/owner?t=` },
    { v: 1, event: "human", step: "owner-open", action: "open_url", url: `http://snip.max.workers.dev/auth/owner?t=x` },
    { v: 1, event: "human", step: "owner-open", action: "open_url", url: `${CLOUD}/auth/owner?t=x&evil=1` },
    { v: 1, event: "human", step: "owner-open", action: "open_url", url: "not a url" },
    { v: 1, event: "human", step: "owner-open", action: "open_url", url: `https://${"a".repeat(5000)}/auth/owner?t=x` },
    { v: 1, event: "log", level: "info", message: LINK },
  ]
  for (const event of refused) assert.equal(ownerLinkFrom(event, CLOUD), null, JSON.stringify(event).slice(0, 90))
})

test("a link minted for another library is refused", () => {
  // A stale cloud.json plus a fresh run must not produce a link for the wrong host.
  assert.equal(ownerLinkFrom({ v: 1, event: "human", action: "open_url", url: LINK }, "https://other.workers.dev"), null)
  assert.equal(ownerLinkFrom({ v: 1, event: "human", action: "open_url", url: LINK }, null), LINK)
})

test("plain http is only a link when it is this Mac's own library", () => {
  // The signature rides in the URL, so http would hand it to anyone on the path.
  // Loopback is the one host Snip serves itself, and dev libraries live there.
  const local = "http://127.0.0.1:4321/auth/owner?t=x"
  assert.equal(ownerLinkFrom({ v: 1, event: "human", action: "open_url", url: local }, "http://127.0.0.1:4321"), local)
  assert.equal(ownerLinkFrom({ v: 1, event: "human", action: "open_url", url: "http://snip.example.com/auth/owner?t=x" }, null), null)
  assert.equal(ownerLinkFrom({ v: 1, event: "human", action: "open_url", url: "http://10.0.0.5:4321/auth/owner?t=x" }, null), null)
})

test("the url is returned exactly as the engine minted it", () => {
  const decoded = `${CLOUD}${OWNER_PATH}?t=snip-owner-v1|max|1793600400|6f1c0a9e|0.c2ln`
  const event = { v: 1, event: "human", action: "open_url", url: decoded }
  assert.equal(ownerLinkFrom(event, CLOUD), new URL(decoded).href)
})

test("the note says once and ten minutes, and the ttl agrees", () => {
  assert.match(LINK_NOTE, /once/)
  assert.match(LINK_NOTE, /10 minutes/)
  // The run never sees the other device, so it must not claim a sign-in happened.
  assert.match(LINK_NOTE, /signed in and can add a passkey/)
  assert.doesNotMatch(LINK_NOTE, /Signed in/)
  assert.equal(LINK_TTL_MS, 600000)
})
