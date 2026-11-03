import { test } from "node:test"
import assert from "node:assert/strict"
import { referenceViewUrl } from "../src/hooks/use-desktop-state"

test("reference view URL records the latest tab and page for reopening", () => {
  const path = "/r/ref-1"
  const opened = referenceViewUrl(path, "tab=animations&source=gallery", "page", "page-2")
  assert.equal(opened, "/r/ref-1?tab=animations&source=gallery&page=page-2")
  const closed = referenceViewUrl(path, opened.split("?")[1]!, "page", null)
  assert.equal(closed, "/r/ref-1?tab=animations&source=gallery")
  assert.equal(referenceViewUrl(path, closed.split("?")[1]!, "tab", "pages"), "/r/ref-1?source=gallery")
})
