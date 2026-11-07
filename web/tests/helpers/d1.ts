import { readdir, readFile } from "node:fs/promises"

/** Applies every migration in web/migrations to a fresh D1 database, in order. */
export async function applyMigrations(database: D1Database) {
  const dir = new URL("../../migrations/", import.meta.url)
  for (const migration of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(migration, dir), "utf8")
    const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
    await database.batch(statements.map((statement) => database.prepare(statement)))
  }
}
