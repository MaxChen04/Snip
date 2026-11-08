// The window a request comes from decides whether it is trusted. These tests pin the
// split the spec asks for: the local gallery bridge, the Settings bundle on snip://,
// and the cloud window that deliberately has no bridge at all.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const { parse, originOf, isAppRoute, isGallery, isCloudUi, isSettingsUrl, allowsNavigation, trustedSender } = require("../window-origin.cjs")

const LOCAL = "http://localhost:5173"
const CLOUD = "https://snip.max.workers.dev"
const localPin = { role: "local", origin: LOCAL }
const cloudPin = { role: "cloud", origin: CLOUD }
const settingsPin = { role: "settings", origin: "snip://settings" }

const sender = overrides => ({ pin: localPin, localOrigin: LOCAL, senderMatches: true, frameIsMain: true, frameUrl: `${LOCAL}/`, ...overrides })

test("origins parse for both the app and the custom settings scheme", () => {
  assert.equal(originOf(`${LOCAL}/r/abc`), LOCAL)
  assert.equal(originOf(CLOUD), CLOUD)
  // Node reports "null" for a non-special scheme; Snip names the origin itself.
  assert.equal(new URL("snip://settings/index.html").origin, "null")
  assert.equal(originOf("snip://settings/index.html"), "snip://settings")
  assert.equal(parse("not a url"), null)
})

test("only the gallery routes are the local UI", () => {
  assert.equal(isGallery(`${LOCAL}/`, LOCAL), true)
  assert.equal(isGallery(`${LOCAL}/guide`, LOCAL), true)
  assert.equal(isGallery(`${LOCAL}/r/ab12`, LOCAL), true)
  assert.equal(isGallery(`${LOCAL}/settings`, LOCAL), false)
  assert.equal(isGallery(`${LOCAL}/api/references`, LOCAL), false)
  assert.equal(isGallery(`http://localhost:9999/`, LOCAL), false)
  assert.equal(isGallery(`${LOCAL}/`, null), false)
  assert.equal(isAppRoute(`${CLOUD}/r/ab12`, CLOUD), true)
  assert.equal(isCloudUi(`${CLOUD}/anything`, CLOUD), true)
  assert.equal(isCloudUi(`${CLOUD}/`, LOCAL), false)
  assert.equal(isSettingsUrl("snip://settings/index.html"), true)
  assert.equal(isSettingsUrl(`${LOCAL}/`), false)
})

test("a gallery sender is trusted only from the pinned main frame", () => {
  assert.equal(trustedSender(sender()), true)
  assert.equal(trustedSender(sender({ frameUrl: `${LOCAL}/r/ab12` })), true)
  assert.equal(trustedSender(sender({ senderMatches: false })), false)
  assert.equal(trustedSender(sender({ frameIsMain: false })), false)
  assert.equal(trustedSender(sender({ frameUrl: `${LOCAL}/settings` })), false)
  assert.equal(trustedSender(sender({ frameUrl: "http://127.0.0.1:5173/" })), false)
  assert.equal(trustedSender(sender({ frameUrl: undefined })), false)
})

test("a Settings sender cannot borrow the gallery pin, and the reverse is also false", () => {
  const fromSettings = { pin: settingsPin, localOrigin: LOCAL, senderMatches: true, frameIsMain: true, frameUrl: "snip://settings/index.html" }
  assert.equal(trustedSender(fromSettings), true)
  // A localhost page inside the Settings window (or a spoofed frame) is not Settings.
  assert.equal(trustedSender({ ...fromSettings, frameUrl: `${LOCAL}/` }), false)
  // The gallery pin rejects the Settings origin outright.
  assert.equal(trustedSender({ ...sender(), pin: localPin, frameUrl: "snip://settings/index.html" }), false)
  // A Settings window with a gallery pin cannot pass.
  assert.equal(trustedSender({ ...fromSettings, pin: localPin }), false)
})

test("the cloud window has no preload, so it is never a trusted sender", () => {
  assert.equal(trustedSender({ pin: cloudPin, localOrigin: LOCAL, senderMatches: true, frameIsMain: true, frameUrl: CLOUD }), false)
  assert.equal(trustedSender({ pin: cloudPin, localOrigin: LOCAL, senderMatches: true, frameIsMain: true, frameUrl: `${LOCAL}/` }), false)
})

test("navigation stays inside a window's own origin", () => {
  assert.equal(allowsNavigation(localPin, `${LOCAL}/r/ab12`), true)
  assert.equal(allowsNavigation(localPin, CLOUD), false)
  assert.equal(allowsNavigation(cloudPin, `${CLOUD}/r/ab12`), true)
  assert.equal(allowsNavigation(cloudPin, `${LOCAL}/`), false)
  assert.equal(allowsNavigation(settingsPin, "snip://settings/index.html?x=1"), true)
  assert.equal(allowsNavigation(settingsPin, `${LOCAL}/`), false)
  assert.equal(allowsNavigation(null, `${LOCAL}/`), false)
})
