// Bug 4 (UI half): multi-account setup. The engine asks for key "account" with `options`
// (full account ids behind friendly labels) and ends with result NEEDS_INPUT.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { Browser, Page } from "playwright"
import { calls, launch, openSettings, pageTextOutsideToasts, sim, startVite, toastTexts, watch, watched, type Server } from "./harness"

const ID_A = "aaaaaaaa11111111aaaaaaaa11111111"
const ID_B = "bbbbbbbb22222222bbbbbbbb22222222"

let server: Server
let browser: Browser
before(async () => {
  server = await startVite()
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await server?.stop()
})

async function reachAccountQuestion(page: Page) {
  // An interrupted setup (mode "enabling") with Resume on screen: the usual way back in,
  // and the window is already in its progress view, so a state() round trip is all it
  // takes for an error card to show or not.
  await page.locator("main").getByRole("button", { name: "Resume" }).click()
  await page.waitForFunction(() => (window as any).__sim.run?.command === "setup")
  await sim(page, "step", "preflight", "started")
  await sim(page, "step", "preflight", "ok")
  await sim(page, "step", "cloudflare-auth", "ok")
  await sim(page, "step", "account", "started")
  await sim(page, "emit", {
    v: 1,
    event: "needs_input",
    keys: [
      {
        key: "account",
        label: "Cloudflare account (Personal aaaaaaaa…, Work bbbbbbbb…)",
        secret: false,
        options: [
          { value: ID_A, label: "Personal" },
          { value: ID_B, label: "Work" },
        ],
      },
    ],
  })
  await sim(page, "result", { ok: false, code: "NEEDS_INPUT", mode: "enabling" })
  await sim(page, "exit", { code: 2 })
}

test("the account question shows no red error card or error toast next to the input card", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "enabling", stateDelayMs: 400 })
  try {
    // A red error card is any text outside toasts other than the input card's own copy;
    // an error toast is any toast at all (the only log main sends here is level "error").
    await watch(page, "errorCard", `Array.from(document.querySelectorAll('main [class*="red-3"]')).some(function (el) { return /one more choice/.test(el.textContent || "") })`)
    await watch(page, "errorToast", `document.querySelectorAll("[data-sonner-toast][data-type='error']").length > 0`)
    await reachAccountQuestion(page)
    await page.getByText("Snip needs one more thing before it can continue.").waitFor()
    await page.waitForTimeout(1500)
    const card = await watched(page, "errorCard")
    const toast = await watched(page, "errorToast")
    assert.ok(!card && !toast, `input card is up, but errorCard=${card} errorToast=${toast} (toasts: ${JSON.stringify(await toastTexts(page))})`)
  } finally {
    await close()
  }
})

test("the account question lets the person pick Personal or Work and sends the full id", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "enabling", stateDelayMs: 400 })
  try {
    await reachAccountQuestion(page)
    await page.getByText("Snip needs one more thing before it can continue.").waitFor()
    const main = page.locator("main")
    const freeText = await main.locator("input[type=text], input:not([type])").count()
    // Accept a native <select>, radios, a listbox, or buttons.
    const select = main.locator("select")
    let picked = false
    if (await select.count()) {
      await select.first().selectOption({ label: "Work" })
      picked = true
    } else {
      for (const role of ["radio", "option", "menuitemradio", "button", "tab"] as const) {
        const target = main.getByRole(role, { name: /Work/ })
        if (await target.count()) {
          await target.first().click()
          picked = true
          break
        }
      }
    }
    assert.ok(picked && freeText === 0, `expected a choice built from options (found: pickable=${picked}, free-text inputs=${freeText})`)
    await main.getByRole("button", { name: "Continue" }).click()
    await page.waitForTimeout(300)
    const answers = await calls(page, "answer")
    assert.ok(
      answers.some(entry => entry.args[1] === ID_B),
      `expected answer(<key>, "${ID_B}"); got ${JSON.stringify(answers.map(entry => entry.args))}`,
    )
  } finally {
    await close()
  }
})
