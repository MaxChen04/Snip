import { Hono } from "hono"
import type { CaptureMode, JobComplete, PageUpload } from "../shared/types"
import {
  type AppEnv,
  finishLogin,
  getSessionLogin,
  logout,
  requireCaptureToken,
  requireSession,
  startLogin,
  verifyFileSig,
} from "./auth"
import * as db from "./db"

export const app = new Hono<AppEnv>()

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: err.message || "Internal error" }, 500)
})

// ---------- Auth ----------

app.get("/auth/login", (c) => startLogin(c))
app.get("/auth/callback", (c) => finishLogin(c))
app.get("/auth/logout", (c) => logout(c))

// ---------- MCP OAuth consent ----------
// MCP clients are sent here by the OAuth provider. Max signs in with the same
// GitHub session as the web app, then approves the client explicitly.

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!)

app.get("/authorize", async (c) => {
  const login = await getSessionLogin(c)
  if (!login) {
    const url = new URL(c.req.url)
    return c.redirect(`/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`)
  }
  const authReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw)
  const consent = await c.env.OAUTH_PROVIDER.describeConsent(authReq)
  const { handle, headers } = await c.env.OAUTH_PROVIDER.beginConsent(authReq)
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Snip</title>
<style>
  body{font-family:Inter,system-ui,sans-serif;background:#fcfcfc;color:#222;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
  .card{background:#fff;border:1px solid #0001;border-radius:14px;padding:28px;max-width:420px;box-shadow:0 10px 15px -3px #0000000f}
  h1{font-size:18px;margin:0 0 8px} p{font-size:14px;color:#555;line-height:1.5}
  code{background:#0000000a;padding:2px 6px;border-radius:6px}
  .row{display:flex;gap:8px;margin-top:20px}
  button{font:inherit;font-size:13px;font-weight:500;border-radius:8px;padding:8px 14px;cursor:pointer;border:1px solid #0002;background:#fff}
  button.primary{background:oklch(0.585 0.233 277.117);color:#fff;border-color:transparent}
  @media (prefers-color-scheme: dark){body{background:#111;color:#eee}.card{background:#1b1b1b;border-color:#fff2}p{color:#aaa}button{background:#222;color:#eee;border-color:#fff3}}
</style></head><body><form class="card" method="post" action="/authorize">
<h1>Allow ${escapeHtml(consent.clientName || "this app")} to use Snip?</h1>
<p>Signed in as <code>${escapeHtml(login)}</code>. The client will be able to search, read and add design references and collections.</p>
<p>It will be redirected to <code>${escapeHtml(consent.redirectHost)}</code>.</p>
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<div class="row"><button class="primary" name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></div>
</form></body></html>`
  return new Response(html, { headers: new Headers([...headers, ["content-type", "text/html; charset=utf-8"]]) })
})

app.post("/authorize", async (c) => {
  const login = await getSessionLogin(c)
  if (!login) return c.text("Not signed in", 401)
  const form = await c.req.formData()
  const handle = String(form.get("handle") ?? "")
  if (form.get("decision") !== "approve") {
    const denied = await c.env.OAUTH_PROVIDER.denyConsent(c.req.raw, handle)
    return new Response(null, { status: 302, headers: denied.headers })
  }
  const approved = await c.env.OAUTH_PROVIDER.approveConsent(c.req.raw, handle)
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: approved.request,
    userId: login,
    metadata: { label: login },
    scope: approved.request.scope,
    props: { login },
  })
  const headers = new Headers(approved.headers)
  headers.set("location", redirectTo)
  return new Response(null, { status: 302, headers })
})

// ---------- Files (R2) ----------

const KEY_RE = /^refs\/[a-z0-9]+\/[A-Za-z0-9._\/-]+$/

app.get("/files/*", async (c) => {
  const key = decodeURIComponent(c.req.path.slice("/files/".length))
  if (!KEY_RE.test(key) || key.includes("..")) return c.notFound()
  const signedOk = await verifyFileSig(c.env, key, c.req.query("exp"), c.req.query("sig"))
  if (!signedOk && !(await getSessionLogin(c))) return c.json({ error: "unauthorized" }, 401)
  const obj = await c.env.FILES.get(key)
  if (!obj) return c.notFound()
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set("etag", obj.httpEtag)
  headers.set("cache-control", "private, max-age=86400, immutable")
  headers.set("x-content-type-options", "nosniff")
  if (key.endsWith(".html")) {
    // Captured third-party HTML: no scripts, opaque origin, no access to our cookies.
    headers.set("content-security-policy", "sandbox allow-popups; script-src 'none'; object-src 'none'; base-uri *")
  }
  if (key.endsWith(".json") && c.req.query("download")) {
    headers.set("content-disposition", `attachment; filename="${key.split("/").slice(-2).join("-")}"`)
  }
  return new Response(obj.body, { headers })
})

// ---------- Web API ----------

const api = new Hono<AppEnv>()
api.use("*", requireSession)

api.get("/me", (c) => c.json({ login: c.get("login") }))

const listFilter = (q: Record<string, string>): db.ListFilter => ({
  q: q.q || undefined,
  collectionId: q.collection || undefined,
  domain: q.domain || undefined,
  status: q.status || undefined,
  sort: (q.sort as db.SortOrder) || "newest",
  limit: q.limit ? Number(q.limit) : undefined,
  cursor: q.cursor || null,
})

api.get("/references", async (c) => c.json(await db.listReferences(c.env.DB, listFilter(c.req.query()))))
api.get("/pages", async (c) => c.json(await db.listPages(c.env.DB, listFilter(c.req.query()))))
api.get("/animations", async (c) => c.json(await db.listAnimations(c.env.DB, listFilter(c.req.query()))))

api.post("/references", async (c) => {
  const body = await c.req.json<{ url: string; mode: CaptureMode; maxPages?: number; collectionIds?: string[] }>()
  if (!body.url) return c.json({ error: "url is required" }, 400)
  try {
    const ref = await db.createReference(c.env.DB, {
      url: body.url,
      mode: body.mode === "crawl" ? "crawl" : "single",
      maxPages: body.maxPages,
      collectionIds: body.collectionIds,
    })
    return c.json(ref, 201)
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

api.get("/references/:id", async (c) => {
  const r = await db.getReference(c.env.DB, c.req.param("id"))
  return r ? c.json(r) : c.json({ error: "not found" }, 404)
})

api.post("/references/:id/recapture", async (c) => {
  const id = c.req.param("id")
  // Old files are removed when the capture worker claims the job.
  await db.requeueReference(c.env.DB, id)
  return c.json({ ok: true })
})

api.delete("/references/:id", async (c) => {
  await db.deleteReference(c.env.DB, c.env.FILES, c.req.param("id"))
  return c.json({ ok: true })
})

api.put("/references/:id/collections/:cid", async (c) => {
  await db.setReferenceCollection(c.env.DB, c.req.param("id"), c.req.param("cid"), true)
  return c.json({ ok: true })
})
api.delete("/references/:id/collections/:cid", async (c) => {
  await db.setReferenceCollection(c.env.DB, c.req.param("id"), c.req.param("cid"), false)
  return c.json({ ok: true })
})

api.get("/collections", async (c) => c.json(await db.listCollections(c.env.DB)))
api.post("/collections", async (c) => {
  const { name, description } = await c.req.json<{ name: string; description?: string }>()
  if (!name?.trim()) return c.json({ error: "name is required" }, 400)
  return c.json({ id: await db.createCollection(c.env.DB, name, description) }, 201)
})
api.patch("/collections/:id", async (c) => {
  const { name, description } = await c.req.json<{ name: string; description?: string }>()
  await db.updateCollection(c.env.DB, c.req.param("id"), name, description)
  return c.json({ ok: true })
})
api.delete("/collections/:id", async (c) => {
  await db.deleteCollection(c.env.DB, c.req.param("id"))
  return c.json({ ok: true })
})

app.route("/api", api)

// ---------- Capture agent API (bearer CAPTURE_TOKEN) ----------

const agent = new Hono<AppEnv>()
agent.use("*", requireCaptureToken)

agent.post("/jobs/claim", async (c) => {
  const job = await db.claimJob(c.env.DB)
  // Rows from any earlier attempt are gone, so drop its files; the new attempt writes under its own folder.
  // Awaited so it can't race the new attempt's uploads.
  if (job) await db.deletePrefix(c.env.FILES, `refs/${job.id}/`).catch((e) => console.error("cleanup failed", e))
  await db.touchPresence(c.env.DB, job ? "busy" : "idle", job?.id ?? null)
  return job ? c.json(job) : c.body(null, 204)
})

// Sent while a capture is running, so long pages don't make a busy worker look offline.
agent.post("/heartbeat", async (c) => {
  const { jobId } = await c.req.json<{ jobId?: string | null }>().catch(() => ({ jobId: null }))
  await db.touchPresence(c.env.DB, jobId ? "busy" : "idle", jobId ?? null)
  return c.json({ ok: true })
})

agent.post("/jobs/:id/progress", async (c) => {
  const { message } = await c.req.json<{ message: string }>()
  await Promise.all([db.setProgress(c.env.DB, c.req.param("id"), message), db.touchPresence(c.env.DB, "busy", c.req.param("id"))])
  return c.json({ ok: true })
})

agent.put("/files/*", async (c) => {
  const key = c.req.path.slice("/agent/files/".length)
  if (!KEY_RE.test(key) || key.includes("..")) return c.json({ error: "bad key" }, 400)
  if (!(await db.isCapturing(c.env.DB, key.split("/")[1]!))) return c.json({ error: "job is gone" }, 410)
  const contentType = c.req.header("content-type") ?? "application/octet-stream"
  await c.env.FILES.put(key, c.req.raw.body, { httpMetadata: { contentType } })
  return c.json({ key })
})

agent.post("/jobs/:id/pages", async (c) => {
  if (!(await db.isCapturing(c.env.DB, c.req.param("id")))) return c.json({ error: "job is gone" }, 410)
  const page = await c.req.json<PageUpload>()
  const pageId = await db.addPage(c.env.DB, c.req.param("id"), page)
  return c.json({ id: pageId })
})

agent.post("/jobs/:id/complete", async (c) => {
  await db.completeJob(c.env.DB, c.req.param("id"), await c.req.json<JobComplete>())
  await db.touchPresence(c.env.DB, "idle", null)
  return c.json({ ok: true })
})

agent.post("/jobs/:id/fail", async (c) => {
  const { error } = await c.req.json<{ error: string }>()
  await db.failJob(c.env.DB, c.req.param("id"), error)
  await db.touchPresence(c.env.DB, "idle", null)
  return c.json({ ok: true })
})

app.route("/agent", agent)
