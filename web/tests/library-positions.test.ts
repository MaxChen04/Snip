import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { importLocal } from "../../desktop/provision/deploy.cjs"
import { columnsFromDump, comparableTables, splitSqlStatements } from "../../desktop/provision/lib.cjs"
import type { LibraryPosition, LibraryPositionsSnapshot } from "../shared/types"
import { app } from "../worker/app"
import { applyMigrations } from "./helpers/d1"

const base = "/api/library-positions"
const migration = "0021_library_positions.sql"

async function setup(t: TestContext) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ["DB", "COPY"],
    r2Buckets: ["FILES"],
  }))
  t.after(() => mf.dispose())
  const db = (await mf.getD1Database("DB")) as unknown as D1Database
  const copy = (await mf.getD1Database("COPY")) as unknown as D1Database
  const env = {
    DB: db,
    FILES: await mf.getR2Bucket("FILES"),
    DEV_LOGIN: "fixture-owner",
    SESSION_SECRET: "fixture-session-secret",
    TRANSFER_TOKEN: "fixture-transfer-token",
  } as unknown as Env
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
  const call = (method = "GET", path = base, body?: unknown, opts?: { origin?: string; headers?: Record<string, string>; database?: D1Database }) =>
    app.request(`${opts?.origin ?? "http://localhost"}${path}`, {
      method,
      headers: { "content-type": "application/json", ...opts?.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { ...env, DB: opts?.database ?? db }, ctx)
  const request = async (...args: Parameters<typeof call>): Promise<LibraryPositionsSnapshot> => {
    const res = await call(...args)
    assert.equal(res.status, 200, await res.clone().text())
    assert.equal(res.headers.get("cache-control"), "private, no-store")
    return res.json()
  }
  return { db, copy, call, request }
}

test("library position migration adds empty storage without affecting old library rows", async (t) => {
  const { db, request } = await setup(t)
  await applyMigrations(db, (file) => file < migration)
  await db.prepare("INSERT INTO collections (id, name, created_at) VALUES ('legacy', 'Old board', '2026-01-01')").run()
  await applyMigrations(db, (file) => file === migration)
  assert.deepEqual(await request(), { version: 0, positions: [] })
  assert.equal(await db.prepare("SELECT name FROM collections WHERE id = 'legacy'").first("name"), "Old board")
})

test("library position seeding is insert-only and version-checked moves are atomic", async (t) => {
  const { db, copy, call, request } = await setup(t)
  await applyMigrations(db)
  await applyMigrations(copy)

  assert.equal((await call("GET", base, undefined, { origin: "https://example.test" })).status, 401)
  const page = { kind: "page", id: "p1", x: -5.125, y: 32.75 } as const
  const image = { kind: "image", id: "p1", x: 200, y: -100 } as const
  const section = { kind: "section", id: "p1:0", x: 50, y: 0 } as const
  assert.equal((await call("POST", `${base}/seed`, { version: 0, positions: [page] }, { headers: { origin: "https://example.test" } })).status, 403)
  assert.equal((await call("PUT", base, { version: 0, positions: [page] }, { origin: "https://example.test" })).status, 401)
  const seed = (version: number, positions: LibraryPosition[]) => request("POST", `${base}/seed`, { version, positions })
  assert.deepEqual(await seed(0, [page]), { version: 1, positions: [page] })
  assert.deepEqual(await seed(1, [{ ...page, x: 99 }, image]), { version: 2, positions: [image, page] })
  assert.deepEqual(await seed(2, [{ ...page, x: 99 }]), { version: 2, positions: [image, page] })
  assert.deepEqual(await request("GET", base, undefined, { database: copy }), { version: 0, positions: [] })

  const moves = [[{ ...image, y: 42 }, { ...page, x: 17 }, section], [{ ...image, y: -42 }, { ...page, x: -17 }]]
  const replies = await Promise.all(moves.map((positions) => call("PUT", base, { version: 2, positions })))
  assert.deepEqual(replies.map((res) => res.status).sort(), [200, 409])
  const winner = replies.findIndex((res) => res.ok)
  const moved = { version: 3, positions: moves[winner] }
  assert.deepEqual(await replies[winner]!.json(), moved)
  assert.deepEqual(await request(), moved)

  const invalid = [
    { version: -1, positions: [page] },
    { version: 3, positions: [] },
    { version: 3, positions: [page, { ...page, y: 99 }] },
    { version: 3, positions: [page, { ...image, x: null }] },
    { version: 3, positions: [{ ...page, y: 1e10 }] },
    { version: 3, positions: [{ ...page, kind: "note" }] },
  ]
  for (const body of invalid) assert.equal((await call("PUT", base, body)).status, 400)
  assert.deepEqual(await request(), moved)
})

test("large canvas batches stay under D1 binding limits", async (t) => {
  const { db, call, request } = await setup(t)
  await applyMigrations(db)
  const positions = Array.from({ length: 2000 }, (_, i): LibraryPosition => ({
    kind: "website", id: `fixture-${i.toString().padStart(4, "0")}`, x: i, y: 0,
  }))
  assert.equal((await call("POST", `${base}/seed`, { version: 0, positions: [...positions, { ...positions[0], id: "overflow" }] })).status, 400)
  assert.deepEqual(await request("POST", `${base}/seed`, { version: 0, positions }), { version: 1, positions })
  const moved = positions.map((p) => ({ ...p, y: 100 }))
  assert.deepEqual(await request("PUT", base, { version: 1, positions: moved }), { version: 2, positions: moved })
})

test("a stale seed cannot place a new tile where another client just moved an existing tile", async (t) => {
  const { db, call, request } = await setup(t)
  await applyMigrations(db)
  const x = { kind: "image", id: "x", x: 0, y: 0 } as const
  const y = { kind: "image", id: "y", x: 0, y: 256 } as const
  const seed = (version: number, positions: LibraryPosition[]) => call("POST", `${base}/seed`, { version, positions })
  assert.equal((await seed(0, [x])).status, 200)
  const clientA = await request()
  const moved = { ...x, y: 256 }
  assert.deepEqual(await request("PUT", base, { version: clientA.version, positions: [moved] }), { version: 2, positions: [moved] })

  assert.equal((await seed(clientA.version, [y])).status, 409)
  const refreshed = await request()
  assert.deepEqual(refreshed, { version: 2, positions: [moved] }, "a stale seed writes neither tiles nor a new version")
  const relocated = { ...y, y: 512 }
  assert.equal((await seed(refreshed.version, [relocated])).status, 200)
  assert.deepEqual(await request(), { version: 3, positions: [moved, relocated] })
})

test("desktop library transfer imports position rows and their current version", async (t) => {
  const { db, copy, call, request } = await setup(t)
  await applyMigrations(db)
  await applyMigrations(copy)
  const pos: LibraryPosition = { kind: "image", id: "fixture-image", x: 486.25, y: -19.5 }
  await request("POST", `${base}/seed`, { version: 0, positions: [{ ...pos, y: 0 }] })
  const saved = await request("PUT", base, { version: 1, positions: [pos] })
  const manifest = await call("GET", "/transfer/manifest", undefined, { headers: { authorization: "Bearer fixture-transfer-token" } })
  assert.equal(manifest.status, 200)
  const { tables, excluded } = await manifest.json() as { tables: Record<string, number>; excluded: string[] }
  assert.equal(tables.library_positions, 1)
  assert.equal(tables.library_position_version, 1)
  assert.ok(comparableTables(tables, excluded).includes("library_positions"))
  assert.ok(comparableTables(tables, excluded).includes("library_position_version"))

  const [dump] = await db.prepare("PRAGMA miniflare_d1_export(?,?,?);").bind(true, false).raw<string[]>()
  const sql = dump!.join("\n")
  assert.deepEqual(columnsFromDump(sql).library_positions, ["kind", "id", "x", "y"])
  const dir = await mkdtemp(join(tmpdir(), "snip-library-positions-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await importLocal({
    async run(args: string[]) {
      const staged = await readFile(args[args.indexOf("--file") + 1]!, "utf-8")
      await copy.batch(splitSqlStatements(staged).map((statement: string) => copy.prepare(statement)))
      return { ok: true }
    },
  }, { dataRoot: dir, persistTo: dir, statements: splitSqlStatements(sql) })
  assert.deepEqual(await request("GET", base, undefined, { database: copy }), saved)
  assert.equal((await call("PUT", base, { version: 1, positions: [pos] }, { database: copy })).status, 409)
})
