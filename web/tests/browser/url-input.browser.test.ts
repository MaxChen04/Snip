// What the capture card and the Add dialog accept as a web address: the one shared rule, the same sentences in both,
// and typed input that is added whole or refused whole.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { checkSiteUrl } from "../../shared/site-url.ts"
import { boardOf, openAddDialog, pasteOnPage, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

/** The sentence the shared rule gives for an address it refuses. */
const says = (input: string) => {
  const checked = checkSiteUrl(input)
  assert.ok("error" in checked, `${input} should be refused`)
  return checked.error
}
const posted = (t: Awaited<ReturnType<App["session"]>>) => t.list("POST", "/api/references").map((r) => r.body.url)

const LONG = `https://example.com/${"a".repeat(3000)}`
/** What is typed, and the part of it the shared rule refuses first: the sentence shown is the rule's for that part. */
const REFUSED = [
  ["file:///etc/passwd", "file:///etc/passwd"],
  ["ftp://example.com/file", "ftp://example.com/file"],
  ["javascript:alert(1)", "javascript:alert(1)"],
  ["https://user:pw@example.com", "https://user:pw@example.com"],
  [LONG, LONG],
  // A stray space: the first part is not an address, so nothing is captured, not even the part that is.
  ["exa mple.com", "exa"],
  ["example.com, nonsense", "nonsense"],
] as const

// ---------------------------------------------------------------- the capture card

const card = async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  await t.goto("/")
  const field = t.page.getByRole("textbox", { name: "Link to capture" })
  await field.waitFor()
  return { t, field }
}

test("the card captures localhost with a port, as the Worker does", async () => {
  const { t, field } = await card()
  await field.fill("localhost:3000")
  await field.press("Enter")
  await until("POST sent", () => t.count("POST", "/api/references") === 1)
  assert.deepEqual(posted(t), ["https://localhost:3000/"])
  assert.equal(await t.page.getByRole("alert").count(), 0)
})

test("the card says why an address is refused, with the shared sentences, and sends nothing", async () => {
  const { t, field } = await card()
  for (const [input, part] of REFUSED) {
    const sentence = says(part)
    await field.fill(input)
    await field.press("Enter")
    await t.page.getByRole("alert").filter({ hasText: sentence }).waitFor()
    assert.equal(await field.inputValue(), input, "what was typed stays to be corrected")
  }
  assert.equal(t.count("POST", "/api/references"), 0)
})

test("typed addresses are added together, and one bad one stops the lot", async () => {
  const { t, field } = await card()
  await field.fill("one.example.com two.example.com, three.example.com")
  await field.press("Enter")
  await until("three sent", () => t.count("POST", "/api/references") === 3)
  assert.deepEqual(posted(t), ["https://one.example.com/", "https://two.example.com/", "https://three.example.com/"])
})

test("a sentence pasted into the card gives up just its links", async () => {
  const { t, field } = await card()
  await field.focus()
  await t.page.evaluate(() => {
    const data = new DataTransfer()
    data.setData("text/plain", "have a look at https://aside.com/ before the meeting")
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
  })
  assert.equal(await field.inputValue(), "https://aside.com/")
  await field.press("Enter")
  await until("POST sent", () => t.count("POST", "/api/references") === 1)
  assert.deepEqual(posted(t), ["https://aside.com/"])
})

test("More options hands the typed text to the dialog as it was typed", async () => {
  const { t, field } = await card()
  await field.fill("exa mple.com")
  await t.page.getByRole("button", { name: "More options" }).click()
  const dialog = t.page.getByRole("dialog", { name: "New reference" })
  assert.equal(await dialog.getByRole("textbox", { name: "Website URL" }).inputValue(), "exa mple.com")
  await dialog.getByText(says("exa")).waitFor()
  assert.equal(await dialog.getByRole("button", { name: /Save/ }).isDisabled(), true)
})

// ---------------------------------------------------------------- the Add dialog

const dialogOnBoard = async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  await t.goto("/b/board1")
  const dialog = await openAddDialog(t.page)
  return { t, dialog, field: dialog.getByRole("textbox", { name: "Website URL" }), save: dialog.getByRole("button", { name: /Save|Crawl and save/ }) }
}

test("the dialog takes localhost with a port", async () => {
  const { t, dialog, field, save } = await dialogOnBoard()
  await field.fill("localhost:3000")
  assert.equal(await save.isEnabled(), true)
  await save.click()
  await dialog.waitFor({ state: "detached" })
  assert.deepEqual(posted(t), ["https://localhost:3000/"])
})

test("the dialog gives the same sentences as the card, and holds Save back", async () => {
  const { t, dialog, field, save } = await dialogOnBoard()
  for (const [input, part] of REFUSED) {
    await field.fill(input)
    await dialog.getByText(says(part)).waitFor()
    assert.equal(await save.isDisabled(), true, `${input} must not be sendable`)
  }
  assert.equal(t.count("POST", "/api/references"), 0)
})

test("typed addresses in the dialog are added together", async () => {
  const { t, dialog, field } = await dialogOnBoard()
  await field.fill("one.example.com two.example.com")
  await dialog.getByRole("button", { name: "Save 2 websites" }).click()
  await dialog.waitFor({ state: "detached" })
  assert.deepEqual(posted(t), ["https://one.example.com/", "https://two.example.com/"])
})

test("a refusal from the Worker shows in the dialog, not only in a toast, and clears when the address changes", async () => {
  const { t, dialog, field, save } = await dialogOnBoard()
  t.on("POST", "/api/references", () => ({ status: 400, json: { error: "That site is not allowed here" } }))
  await field.fill("blocked.example.com")
  await save.click()
  await dialog.getByText("That site is not allowed here").waitFor()
  assert.equal(await dialog.isVisible(), true, "the dialog stays open")
  assert.equal(await t.page.locator("[data-sonner-toast]").count(), 0, "no toast says it a second time")
  await field.fill("blocked.example.co")
  await dialog.getByText("That site is not allowed here").waitFor({ state: "detached" })
})

test("a sentence pasted on the page still puts just its links in the dialog", async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  await t.goto("/b/board1")
  await t.page.getByRole("button", { name: "Add website" }).first().waitFor()
  await pasteOnPage(t.page, "compare stripe.com and linear.app/pricing please")
  const dialog = t.page.getByRole("dialog", { name: "New reference" })
  await dialog.getByText("2 websites", { exact: true }).waitFor()
})
