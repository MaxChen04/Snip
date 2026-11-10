// Offline retrieval check: runs every task's query through the search an agent gets (search_pages) and
// through the substring filter it replaced, and scores where the right page lands. No model involved.
//
//   node --import tsx qa/discovery/retrieval.ts
//
// Prints one row per task and the totals. The same numbers back web/tests/discovery-search.test.ts.

import * as db from "../../web/worker/db"
import { searchPages } from "../../web/worker/search"
import { LIBRARY } from "./library"
import { loadLibrary, migratedDatabase } from "./load"
import { answers, TASKS, type DiscoveryTask } from "./tasks"

export interface TaskScore {
  id: string
  kind: DiscoveryTask["kind"]
  /** 1-based rank of the first right page, or null when it is not in the top 10. */
  rank: number | null
  baselineRank: number | null
  /** The expected section was the hit's best section (null when the task names no section or the page wasn't found). */
  section: boolean | null
}

export interface Summary {
  tasks: number
  hit1: number
  hit5: number
  mrr: number
  sectionAccuracy: number | null
  baselineHit1: number
  baselineHit5: number
}

const siteOf = new Map(LIBRARY.map((s) => [s.url.replace(/^https?:\/\//, ""), s.url]))

const rankOf = (task: DiscoveryTask, hits: { domain: string; path: string }[]) => {
  const i = hits.findIndex((h) => answers(task, siteOf.get(h.domain) ?? "", h.path))
  return i < 0 ? null : i + 1
}

export async function scoreRetrieval(database: D1Database, tasks = TASKS): Promise<{ scores: TaskScore[]; summary: Summary }> {
  const scores: TaskScore[] = []
  for (const task of tasks) {
    const res = await searchPages(database, { q: task.query, limit: 10 })
    const rank = rankOf(task, res.items.map((h) => ({ domain: h.reference.domain, path: h.page.path })))
    const base = await db.listPages(database, { q: task.query, limit: 10 })
    const baselineRank = rankOf(task, base.items.map((p) => ({ domain: p.reference.domain, path: p.path })))
    const hit = rank ? res.items[rank - 1] : null
    scores.push({
      id: task.id,
      kind: task.kind,
      rank,
      baselineRank,
      section: task.expect.section && hit ? hit.section?.label === task.expect.section : null,
    })
  }
  const n = scores.length
  const withSection = scores.filter((s) => s.section != null)
  return {
    scores,
    summary: {
      tasks: n,
      hit1: scores.filter((s) => s.rank === 1).length / n,
      hit5: scores.filter((s) => s.rank != null && s.rank <= 5).length / n,
      mrr: scores.reduce((a, s) => a + (s.rank ? 1 / s.rank : 0), 0) / n,
      sectionAccuracy: withSection.length ? withSection.filter((s) => s.section).length / withSection.length : null,
      baselineHit1: scores.filter((s) => s.baselineRank === 1).length / n,
      baselineHit5: scores.filter((s) => s.baselineRank != null && s.baselineRank <= 5).length / n,
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { mf, database, files } = await migratedDatabase()
  try {
    await loadLibrary(database, files)
    const { scores, summary } = await scoreRetrieval(database)
    console.table(scores.map((s) => ({ task: s.id, kind: s.kind, rank: s.rank ?? "-", "substring rank": s.baselineRank ?? "-", section: s.section ?? "" })))
    const pct = (x: number | null) => (x == null ? "n/a" : `${Math.round(x * 100)}%`)
    console.log(`search_pages: hit@1 ${pct(summary.hit1)}, hit@5 ${pct(summary.hit5)}, MRR ${summary.mrr.toFixed(2)}, right section ${pct(summary.sectionAccuracy)}`)
    console.log(`substring filter (before): hit@1 ${pct(summary.baselineHit1)}, hit@5 ${pct(summary.baselineHit5)}`)
  } finally {
    await mf.dispose()
  }
}
