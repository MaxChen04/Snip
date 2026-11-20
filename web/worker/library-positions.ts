import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import type { LibraryPosition, LibraryPositionsSnapshot } from "../shared/types"
import type { AppEnv } from "./auth"

const coordinate = z.number().min(-1e9).max(1e9)
const position = z.object({
  kind: z.enum(["page", "section", "animation", "image", "website"]),
  id: z.string().regex(/^[a-zA-Z0-9_:-]{1,128}$/),
  x: coordinate,
  y: coordinate,
})
const positions = z.array(position).min(1).max(2000).superRefine((items, ctx) => {
  const keys = new Set(items.map(({ kind, id }) => `${kind}:${id}`))
  if (keys.size !== items.length) ctx.addIssue({ code: "custom", message: "Duplicate tile" })
})
const writeBody = z.object({ positions, version: z.int().min(0) })

const currentVersion = "(SELECT coalesce((SELECT version FROM library_position_version WHERE id = 1), 0))"
const incoming = `WITH incoming AS (
  SELECT value ->> '$.kind' AS kind, value ->> '$.id' AS id, value ->> '$.x' AS x, value ->> '$.y' AS y
  FROM json_each(?1)
)`
const advanceVersion = `INSERT INTO library_position_version (id, version)
  SELECT 1, ${currentVersion} + 1`
const setVersion = "ON CONFLICT (id) DO UPDATE SET version = excluded.version"
const insertPositions = "INSERT INTO library_positions (kind, id, x, y) SELECT kind, id, x, y FROM incoming"

type SnapshotRow = { version: number } & (LibraryPosition | { kind: null; id: null; x: null; y: null })

function readSnapshot(db: D1Database) {
  return db.prepare(`SELECT v.version, p.kind, p.id, p.x, p.y
    FROM (SELECT ${currentVersion} AS version) v LEFT JOIN library_positions p ON TRUE
    ORDER BY p.kind, p.id`)
}

function snapshot(rows: SnapshotRow[]): LibraryPositionsSnapshot {
  return {
    version: rows[0]!.version,
    positions: rows.flatMap(({ kind, id, x, y }) => kind === null ? [] : [{ kind, id, x, y }]),
  }
}

export const libraryPositions = new Hono<AppEnv>()
libraryPositions.use("*", async (c, next) => {
  c.header("cache-control", "private, no-store")
  await next()
})

libraryPositions.get("/", async (c) => {
  return c.json(snapshot((await readSnapshot(c.env.DB).all<SnapshotRow>()).results))
})

const limitBody = bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: "Too many position bytes" }, 413) })

libraryPositions.post("/seed", limitBody, async (c) => {
  const parsed = writeBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "Invalid library positions" }, 400)
  const db = c.env.DB
  const { positions, version } = parsed.data
  const [before, , , read] = await db.batch<SnapshotRow>([
    db.prepare(`SELECT ${currentVersion} AS version`),
    db.prepare(`${incoming} ${insertPositions} WHERE ${currentVersion} = ?2
      ON CONFLICT (kind, id) DO NOTHING`).bind(JSON.stringify(positions), version),
    db.prepare(`${advanceVersion} WHERE ${currentVersion} = ?1 AND changes() > 0 ${setVersion}`).bind(version),
    readSnapshot(db),
  ])
  if (before!.results[0]!.version !== version) return c.json({ error: "The library layout changed" }, 409)
  return c.json(snapshot(read!.results))
})

libraryPositions.put("/", limitBody, async (c) => {
  const parsed = writeBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "Invalid library positions or version" }, 400)
  const db = c.env.DB
  const { version, positions } = parsed.data
  const [, advanced, read] = await db.batch<SnapshotRow>([
    db.prepare(`${incoming} ${insertPositions} WHERE ${currentVersion} = ?2
      ON CONFLICT (kind, id) DO UPDATE SET x = excluded.x, y = excluded.y`).bind(JSON.stringify(positions), version),
    db.prepare(`${advanceVersion} WHERE ${currentVersion} = ?1 ${setVersion}`).bind(version),
    readSnapshot(db),
  ])
  if (!advanced!.meta.changes) return c.json({ error: "The library layout changed" }, 409)
  return c.json(snapshot(read!.results))
})
