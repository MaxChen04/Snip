import assert from "node:assert/strict"
import { test } from "node:test"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"

// The component file compiles to classic React.createElement calls under tsx.
Object.assign(globalThis, { React })
const { Progress } = await import("../src/components/ui/progress.tsx")
const { createElement } = React

const valueNow = (value: number | null) => renderToStaticMarkup(createElement(Progress, { value, label: "Pages captured" })).match(/aria-valuenow="([^"]*)"/)?.[1] ?? null

test("progress reports 100 only for a finished run, never for 199 of 200", () => {
  assert.equal(valueNow(199 / 200), "99.5")
  assert.equal(valueNow(0.9999), "99.9")
  assert.equal(valueNow(0.4), "40")
  assert.equal(valueNow(0), "0")
  assert.equal(valueNow(1), "100")
  assert.equal(valueNow(1.2), "100")
  assert.equal(valueNow(null), null, "a run with no share yet has no value")
})
