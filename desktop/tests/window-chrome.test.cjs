const test = require("node:test")
const assert = require("node:assert/strict")
const { mainWindowChrome, installWindowChrome } = require("../window-chrome.cjs")

test("macOS retains native controls and reserves only the leading toolbar lane", () => {
  assert.equal(mainWindowChrome("darwin").titleBarStyle, "hiddenInset")
  assert.deepEqual(mainWindowChrome("linux"), {})
  let ready, css
  installWindowChrome({ webContents: {
    on: (event, cb) => { assert.equal(event, "dom-ready"); ready = cb },
    insertCSS: (value) => { css = value; return Promise.resolve() },
  } }, "darwin")
  ready()
  assert.match(css, /header:not\(\.snip-top-bar\)/)
  assert.match(css, /\.snip-toolbar-leading[\s\S]*env\(titlebar-area-x, 0px\)/)
  assert.match(css, /\.snip-top-bar > \.snip-toolbar-leading\s*\{\s*-webkit-app-region: drag/)
  assert.match(css, /\.snip-toolbar-leading > \*\s*\{\s*-webkit-app-region: no-drag/)
  assert.match(css, /\.snip-home-link \{ display: none/)
})

test("other platforms receive no macOS-specific CSS", () => {
  installWindowChrome({ webContents: { on: () => assert.fail("unexpected injection") } }, "win32")
})
