import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import * as db from "../worker/db"
import { applyMigrations } from "./helpers/d1"

test("the scheduled handler sweeps retired capture files, and the config gives it a cron trigger", { timeout: 120_000 }, async () => {
  // The real entrypoint, bundled the way gzip-files.test.ts does it.
  const { build } = createRequire(import.meta.resolve("wrangler"))("esbuild")
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../worker/index.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser",
    conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"],
  })
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"],
    kvNamespaces: ["OAUTH_KV"], d1Databases: ["DB"], r2Buckets: ["FILES"],
    bindings: { PUBLIC_URL: "http://localhost", SESSION_SECRET: "test-secret" },
  }))
  try {
    const database = await mf.getD1Database("DB") as unknown as D1Database
    const files = await mf.getR2Bucket("FILES") as unknown as R2Bucket
    await applyMigrations(database)
    const ref = await db.createReference(database, { url: "https://example.com", mode: "single" })
    const key = `refs/${ref.id}/p0/desktop.jpg`
    await files.put(key, "retired")
    await db.deleteReference(database, ref.id)
    assert.ok(await files.get(key), "nothing has swept it yet")

    const result = await (await mf.getWorker()).scheduled({ cron: "0 * * * *" })
    assert.equal(result.outcome, "ok")
    assert.equal(await files.get(key), null)
    assert.equal((await database.prepare("SELECT count(*) AS n FROM capture_cleanup").first<{ n: number }>())!.n, 0)

    assert.match(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"), /^\s*"triggers":\s*\{\s*"crons":\s*\["[^"]+"\]/m)
  } finally {
    await mf.dispose()
  }
})
