// A page the capture agent flagged ("blank" or "truncated") says so: on the capture card's result, and under the page on the website's page.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { reference, savedPage, startApp, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

const BLANK = "It looks blank: the site may not have loaded."
const TRUNCATED = "The page was taller than Snip captures and was cut off."

/** The website's page, with the pages the Worker returns for it. */
const website = async (pages: ReturnType<typeof savedPage>[]) => {
  const r = reference({ id: "ref1", pageCount: pages.length })
  const t = await app.session({ state: { references: { ref1: r } } })
  t.on("GET", /^\/api\/references\/ref1$/, () => ({ json: { reference: r, pages, animations: [] } }))
  return t
}

/** The home page just after a capture finished: it is adopted as a running one and the first poll reads it as ready. */
const card = async (pages: ReturnType<typeof savedPage>[]) => {
  const t = await website(pages)
  t.on("GET", "/api/references", (req) => (req.query.get("status") === "queued" ? { json: { items: [{ ...t.state.references.ref1, status: "queued" }], nextCursor: null } } : undefined))
  await t.goto("/")
  return t.page.locator("form")
}

test("the capture card says a saved page looks blank", async () => {
  const c = await card([savedPage({ warnings: ["blank"] })])
  await c.getByText(`Saved 1 page. ${BLANK}`).waitFor()
})

test("the capture card says a saved page was cut off, and both when it is both", async () => {
  const cut = await card([savedPage({ warnings: ["truncated"] })])
  await cut.getByText(`Saved 1 page. ${TRUNCATED}`).waitFor()
  const both = await card([savedPage({ warnings: ["blank", "truncated"] })])
  await both.getByText(`Saved 1 page. ${BLANK} ${TRUNCATED}`).waitFor()
})

test("a crawl with several flagged pages points at the website, and a clean one says nothing", async () => {
  const flagged = await card([savedPage({ id: "a", warnings: ["blank"] }), savedPage({ id: "b", path: "/b", warnings: ["truncated"] }), savedPage({ id: "c", path: "/c" })])
  await flagged.getByText("Saved 3 pages. 2 of 3 pages have a warning. Open the website to see which.").waitFor()

  const clean = await card([savedPage()])
  await clean.getByText("Saved 1 page from example.com").waitFor()
  assert.equal(await clean.getByText("blank").count(), 0)
})

test("the website's page puts the notice under the page it is about, and only that page", async () => {
  const t = await website([
    savedPage({ id: "a", path: "/", title: "Home", warnings: ["blank"] }),
    savedPage({ id: "b", path: "/pricing", title: "Pricing" }),
    savedPage({ id: "c", path: "/long", title: "Long read", warnings: ["truncated"] }),
  ])
  await t.goto("/r/ref1")
  const tile = (title: string) => t.page.locator("div.group", { has: t.page.getByRole("button", { name: title }) })
  await tile("Home").getByText(BLANK).waitFor()
  await tile("Long read").getByText(TRUNCATED).waitFor()
  assert.equal(await tile("Pricing").locator("p").count(), 0)
  assert.equal(await tile("Home").getByText(TRUNCATED).count(), 0)
})
