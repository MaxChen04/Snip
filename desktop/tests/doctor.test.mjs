import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { checks, cloudChecks, cloudOrigin, parseFlags } from "../../scripts/doctor.mjs"

const CLOUD = "https://snip.tester.workers.dev"

function dataRoot(t, writable = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snip-doctor-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, ".snip"), { recursive: true })
  if (writable.cloud !== undefined) {
    const body = typeof writable.cloud === "string" ? writable.cloud : JSON.stringify({ version: 1, ...writable.cloud })
    fs.writeFileSync(path.join(root, ".snip/cloud.json"), body)
  }
  if (writable.secrets !== false) fs.writeFileSync(path.join(root, ".snip/cloud-secrets.json"), JSON.stringify({ v: 1, ownerLinkSecret: "x", captureToken: "y" }))
  for (const dir of writable.dirs || []) fs.mkdirSync(path.join(root, dir), { recursive: true })
  return root
}

const issues = (results) => results.filter((result) => result.ok !== true)
const labels = (results) => results.map((result) => result.label)

test("a local-only install has no cloud checks at all", async (t) => {
  const root = dataRoot(t)
  assert.deepEqual(await cloudChecks({ dataRoot: root }), [])
})

test("a detached install is local and stays quiet about cloud", async (t) => {
  // mode is what decides, never the presence of a cloud record: detach leaves the
  // record behind on purpose, and the user is local again.
  const root = dataRoot(t, { cloud: { mode: "local", cloud: { url: CLOUD, accountId: "acct", detachedAt: new Date().toISOString() } } })
  assert.deepEqual(await cloudChecks({ dataRoot: root }), [])
})

test("an unfinished setup points at setup --resume with the step it stopped on", async (t) => {
  const root = dataRoot(t, {
    cloud: {
      mode: "enabling",
      cloud: { url: CLOUD, accountId: "acct" },
      steps: [{ id: "deploy", status: "failed", at: new Date().toISOString(), detail: "boom" }],
      error: { step: "deploy", code: "DEPLOY_VERIFY_FAILED", message: "The deployed Worker did not answer.", hint: null, at: new Date().toISOString() },
    },
  })
  const results = await cloudChecks({ dataRoot: root })
  assert.equal(results.length, 1)
  assert.equal(results[0].ok, null)
  assert.match(results[0].label, /Cloud setup did not finish \(stopped at deploy\)/)
  assert.match(results[0].label, /did not answer/)
  assert.match(results[0].fix, /setup --resume/)
  assert.match(results[0].fix, /abort/)
})

test("a healthy cloud install reports the library and nothing to fix", async (t) => {
  const root = dataRoot(t, {
    cloud: { mode: "cloud", cloud: { url: CLOUD, accountId: "acct", workerVersion: "1.1.3", lastDeployedAt: new Date().toISOString() } },
  })
  const results = await cloudChecks({ dataRoot: root })
  assert.deepEqual(issues(results), [])
  assert.match(labels(results)[0], /Cloud library: https:\/\/snip\.tester\.workers\.dev \(Worker 1\.1\.3\)/)
})

test("a missing deploy record and owner secret each name their own command", async (t) => {
  const root = dataRoot(t, {
    secrets: false,
    cloud: { mode: "cloud", cloud: { url: CLOUD, accountId: "acct" } },
  })
  const found = issues(await cloudChecks({ dataRoot: root }))
  assert.deepEqual(found.map((result) => result.ok), [null, null])
  assert.match(found[0].label, /No deployed Worker version/)
  assert.match(found[0].fix, /deploy/)
  assert.match(found[1].label, /no owner sign-in secret/i)
  assert.match(found[1].fix, /owner rotate/)
})

test("cloud mode with an unusable URL is reported, not crashed on", async (t) => {
  const root = dataRoot(t, { cloud: { mode: "cloud", cloud: { url: `${CLOUD}/not-an-origin`, accountId: "acct", workerVersion: "1.1.3" } } })
  const found = issues(await cloudChecks({ dataRoot: root }))
  assert.equal(found.length, 1)
  assert.equal(found[0].ok, false)
  assert.match(found[0].label, /without a usable Worker URL/)
  assert.match(found[0].fix, /setup --resume/)
})

test("a record that still says detached while the mode is cloud is called out", async (t) => {
  const root = dataRoot(t, {
    cloud: { mode: "cloud", cloud: { url: CLOUD, accountId: "acct", workerVersion: "1.1.3", detachedAt: "2026-11-06T10:12:00Z" } },
  })
  const found = issues(await cloudChecks({ dataRoot: root }))
  assert.equal(found.length, 1)
  assert.match(found[0].label, /records a detach/)
  assert.match(found[0].fix, /detach/)
})

test("snapshot paths that are gone are problems with the exact delete command", async (t) => {
  const root = dataRoot(t, {
    cloud: {
      mode: "cloud",
      cloud: { url: CLOUD, accountId: "acct", workerVersion: "1.1.3" },
      snapshot: {
        kind: "backup", path: "backups/cloud-pull-2026-11-06T10-12-00", keptLocal: false, takenAt: "2026-11-06T10:12:00Z", refs: 3,
        export: { path: "backups/cloud-export-2026-11-06T10-12-00", takenAt: "2026-11-06T10:12:00Z", refs: 3, files: 4, bytes: 10 },
      },
    },
  })
  const found = issues(await cloudChecks({ dataRoot: root }))
  assert.deepEqual(found.map((result) => result.ok), [false, false])
  assert.match(found[0].label, /The previous library is missing/)
  assert.match(found[0].fix, /snapshot delete --confirm cloud-pull-2026-11-06T10-12-00/)
  assert.match(found[1].label, /backup files are missing/)
  assert.match(found[1].fix, /snapshot delete-export --confirm cloud-export-2026-11-06T10-12-00/)
})

test("present snapshot directories are not reported", async (t) => {
  const root = dataRoot(t, {
    dirs: ["backups/cloud-pull-2026-11-06T10-12-00", "backups/cloud-export-2026-11-06T10-12-00"],
    cloud: {
      mode: "cloud",
      cloud: { url: CLOUD, accountId: "acct", workerVersion: "1.1.3" },
      snapshot: {
        kind: "backup", path: "backups/cloud-pull-2026-11-06T10-12-00", keptLocal: false, takenAt: "2026-11-06T10:12:00Z", refs: 3,
        export: { path: "backups/cloud-export-2026-11-06T10-12-00", takenAt: "2026-11-06T10:12:00Z", refs: 3 },
      },
    },
  })
  assert.deepEqual(issues(await cloudChecks({ dataRoot: root })), [])
})

test("a damaged cloud.json is reported with its path", async (t) => {
  const root = dataRoot(t, { cloud: "{ not json" })
  const found = issues(await cloudChecks({ dataRoot: root }))
  assert.equal(found.length, 1)
  assert.equal(found[0].ok, false)
  assert.match(found[0].label, /cloud setup record is unreadable/i)
})

test("a record from a newer engine is reported rather than guessed at", async (t) => {
  const root = dataRoot(t, { cloud: { version: 99, mode: "cloud" } })
  const found = issues(await cloudChecks({ dataRoot: root }))
  assert.equal(found.length, 1)
  assert.equal(found[0].ok, false)
  assert.match(found[0].label, /version this Snip does not understand/)
})

test("cloud checks stay offline unless --check is asked for", async (t) => {
  const root = dataRoot(t, {
    cloud: { mode: "cloud", cloud: { url: CLOUD, accountId: "acct", workerVersion: "1.1.3" } },
  })
  let calls = 0
  const fetchImpl = async () => { calls++; throw new Error("must not be called") }
  await cloudChecks({ dataRoot: root, fetchImpl })
  assert.equal(calls, 0, "the default is the offline view, exactly like `status`")
})

test("--check probes the cloud origin and accepts an unauthenticated answer", async (t) => {
  const root = dataRoot(t, {
    cloud: { mode: "cloud", cloud: { url: CLOUD, accountId: "acct", workerVersion: "1.1.3" } },
  })
  const seen = []
  const results = await cloudChecks({
    dataRoot: root,
    check: true,
    fetchImpl: async (url) => { seen.push(url); return { status: 401 } },
  })
  assert.deepEqual(seen, [CLOUD])
  assert.deepEqual(issues(results), [])
  assert.match(labels(results).join("\n"), /The cloud library answers \(HTTP 401\)/)
})

test("--check reports an unreachable library and points at status --check", async (t) => {
  const root = dataRoot(t, {
    cloud: { mode: "cloud", cloud: { url: CLOUD, accountId: "acct", workerVersion: "1.1.3" } },
  })
  const found = issues(await cloudChecks({ dataRoot: root, check: true, fetchImpl: async () => { throw new Error("offline") } }))
  assert.equal(found.length, 1)
  assert.equal(found[0].ok, false)
  assert.match(found[0].label, /Can't reach the cloud library/)
  assert.match(found[0].fix, /status --check/)
})

test("--check does not probe a cloud Worker that setup has not deployed yet", async (t) => {
  const root = dataRoot(t, { cloud: { mode: "enabling", cloud: { accountId: "acct" }, steps: [{ id: "url", status: "failed" }] } })
  let calls = 0
  await cloudChecks({ dataRoot: root, check: true, fetchImpl: async () => { calls++; return { status: 200 } } })
  assert.equal(calls, 0)
})

test("cloudOrigin accepts only a bare http(s) origin", () => {
  assert.equal(cloudOrigin(CLOUD), CLOUD)
  assert.equal(cloudOrigin("https://Snip.Example.com/"), "https://snip.example.com")
  assert.equal(cloudOrigin("http://127.0.0.1:8787"), "http://127.0.0.1:8787")
  for (const bad of [null, "", "nope", "ftp://x.dev", `${CLOUD}/path`, `${CLOUD}?a=1`, "https://user:pass@x.dev"]) {
    assert.equal(cloudOrigin(bad), null, `${bad} is not an origin`)
  }
})

// ---------- the whole doctor ----------

function repoFixture(t, { cloud } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snip-doctor-repo-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const token = "b".repeat(64)
  fs.mkdirSync(path.join(root, "web"), { recursive: true })
  fs.writeFileSync(path.join(root, "web/.dev.vars"), `DEV_LOGIN=local\nPUBLIC_URL=http://localhost:5173\nSESSION_SECRET=${"a".repeat(64)}\nCAPTURE_TOKEN=${token}\n`)
  fs.mkdirSync(path.join(root, "capture"), { recursive: true })
  const chromium = path.join(root, "chromium")
  fs.writeFileSync(chromium, "")
  fs.writeFileSync(path.join(root, "capture/.env"), `SNIP_URL=http://localhost:5173\nCAPTURE_TOKEN=${token}\nCHROMIUM_PATH=${chromium}\n`)
  if (cloud) {
    fs.mkdirSync(path.join(root, ".snip"), { recursive: true })
    fs.writeFileSync(path.join(root, ".snip/cloud.json"), JSON.stringify({ version: 1, ...cloud }))
  }
  return root
}

const fakeFetch = async () => ({ ok: true, status: 200 })
const runChecks = (root, extra = {}) => checks({ root, fetchImpl: fakeFetch, gitStatus: () => "", ...extra })

test("the doctor prints no cloud lines for a local-only install", async (t) => {
  const root = repoFixture(t)
  const results = await runChecks(root)
  assert.deepEqual(results.filter((result) => result.area === "cloud"), [])
})

test("the doctor reports an unfinished setup through cloud.json", async (t) => {
  const root = repoFixture(t, { cloud: { mode: "enabling", cloud: { accountId: "acct" }, steps: [{ id: "guard", status: "failed" }] } })
  const cloud = (await runChecks(root)).filter((result) => result.area === "cloud")
  assert.equal(cloud.length, 1)
  assert.match(cloud[0].label, /Cloud setup did not finish/)
  assert.match(cloud[0].fix, /npm run setup:cloudflare -- setup --resume/)
})

test("no doctor fix still sends users to the retired deploy config", async (t) => {
  const root = repoFixture(t, { cloud: { mode: "cloud", cloud: { url: CLOUD, accountId: "acct" } } })
  const results = await runChecks(root, { gitStatus: () => " M web/wrangler.jsonc\n" })
  for (const result of results) {
    assert.doesNotMatch(result.label || "", /wrangler\.deploy\.jsonc/)
    assert.doesNotMatch(result.fix || "", /wrangler\.deploy\.jsonc/)
  }
  const edits = results.find((result) => /has local edits/.test(result.label))
  assert.ok(edits, "local edits to the tracked config are still called out")
  assert.match(edits.fix, /storage-identities\.json/)
  assert.match(edits.fix, /git checkout web\/wrangler\.jsonc/)
})

test("parseFlags reads --check and --data-root", () => {
  assert.deepEqual(parseFlags([]), { check: false, dataRoot: null, help: false })
  assert.equal(parseFlags(["--check"]).check, true)
  assert.equal(parseFlags(["--data-root", "/tmp/x"]).dataRoot, "/tmp/x")
  assert.equal(parseFlags(["--data-root=/tmp/y"]).dataRoot, "/tmp/y")
  assert.equal(parseFlags(["--help"]).help, true)
  assert.equal(parseFlags(["--nonsense"]).check, false)
})
