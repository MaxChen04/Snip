import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { parseCreatedId, publicUrlFrom, readValues, renderDeployConfig, TRACKED_CONFIG } from "../../scripts/cloudflare.mjs"

const tracked = fs.readFileSync(TRACKED_CONFIG, "utf8")

test("the tracked config ships placeholders only", () => {
  assert.deepEqual(readValues(tracked), { d1: null, kv: null, login: null, url: null })
})

test("the deploy config fills in this install's values and keeps the rest", () => {
  const values = { d1: "0f0e0d0c-0b0a-0908-0706-050403020100", kv: "a1b2c3d4e5f60718293a4b5c6d7e8f90", login: "octocat", url: "https://snip.octo.workers.dev/" }
  const out = renderDeployConfig(tracked, values)
  assert.deepEqual(readValues(out), { ...values, url: "https://snip.octo.workers.dev" })
  assert.match(out, /"migrations_dir": "migrations"/)
  assert.match(out, /Gitignored/)
})

test("public URLs from a subdomain, host or URL", () => {
  assert.equal(publicUrlFrom("octo"), "https://snip.octo.workers.dev")
  assert.equal(publicUrlFrom("snip.example.com"), "https://snip.example.com")
  assert.equal(publicUrlFrom("https://snip.example.com/path/"), "https://snip.example.com")
  assert.equal(publicUrlFrom(" "), null)
})

test("ids printed by wrangler create commands", () => {
  assert.equal(parseCreatedId(`[[d1_databases]]\nbinding = "DB"\ndatabase_name = "snip"\ndatabase_id = "0f0e0d0c-0b0a-0908-0706-050403020100"`, "database_id"), "0f0e0d0c-0b0a-0908-0706-050403020100")
  assert.equal(parseCreatedId(`{\n  "d1_databases": [{ "binding": "DB", "database_id": "0f0e0d0c-0b0a-0908-0706-050403020100" }]\n}`, "database_id"), "0f0e0d0c-0b0a-0908-0706-050403020100")
  assert.equal(parseCreatedId(`"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90" }]`, "id"), "a1b2c3d4e5f60718293a4b5c6d7e8f90")
})
