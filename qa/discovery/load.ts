import { readdir, readFile } from "node:fs/promises"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import * as db from "../../web/worker/db"
import { distractors, LIBRARY, pageUpload } from "./library"

// A 1x1 JPEG, stored under every screenshot key so tools that inline images have something to return.
const PIXEL = Uint8Array.from(atob("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="), (c) => c.charCodeAt(0))

export interface LoadedLibrary {
  /** Site URL -> reference id. */
  refs: Map<string, string>
  /** "<site URL><path>" -> page id. */
  pages: Map<string, string>
}

/** Captures every fixture site (plus `extra` filler websites) into a migrated, empty D1 (and R2, when given) the way the capture agent would. */
export async function loadLibrary(database: D1Database, files?: R2Bucket, extra = 0): Promise<LoadedLibrary> {
  const refs = new Map<string, string>()
  const pages = new Map<string, string>()
  // Filler first, so the task sites are not simply the newest.
  for (const site of [...distractors(extra), ...LIBRARY]) {
    const ref = await db.createReference(database, { url: site.url, mode: "crawl", notes: site.notes ?? null })
    const job = (await db.claimJob(database))!
    for (const [ord, page] of site.pages.entries()) {
      const upload = pageUpload(ref.id, job.attempt, page, ord, site.url)
      if (files) for (const key of [upload.desktopKey, upload.desktopThumbKey, ...(upload.sections ?? []).map((s) => s.key)]) if (key) await files.put(key, PIXEL, { httpMetadata: { contentType: "image/jpeg" } })
      const id = await db.addPage(database, ref.id, job.lease, upload)
      if (!id) throw new Error(`Fixture capture lost its lease while saving ${site.url}${page.path}`)
      pages.set(site.url + page.path, id!)
    }
    await db.completeJob(database, ref.id, job.lease, { title: site.title, description: site.description, favicon: null, coverKey: null, tokens: null })
    refs.set(site.url, ref.id)
  }
  return { refs, pages }
}

/** A fresh in-memory D1 and R2 with every migration applied. */
export async function migratedDatabase() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  const database = (await mf.getD1Database("DB")) as unknown as D1Database
  const files = (await mf.getR2Bucket("FILES")) as unknown as R2Bucket
  const dir = new URL("../../web/migrations/", import.meta.url)
  for (const migration of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(migration, dir), "utf8")
    const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
    await database.batch(statements.map((statement) => database.prepare(statement)))
  }
  return { mf, database, files }
}
