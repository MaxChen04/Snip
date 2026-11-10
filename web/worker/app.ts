import { Hono, type Context } from "hono"
import type { CaptureMode, CrawlState, JobComplete, PageUpload } from "../shared/types"
import {
  type AppEnv,
  finishLogin,
  getSession,
  githubEnabled,
  logout,
  requireCaptureToken,
  crossSiteWrite,
  requireSession,
  signOutAll,
  startLogin,
  verifyFileSig,
} from "./auth"
import * as db from "./db"
import { canvas } from "./canvas"
import { signInPath } from "../shared/safe-next"
import { loginOptions, loginVerify, registerOptions, registerVerify, listDevices, removeDevice } from "./passkeys"
import { ownerLinkPage, ownerLinkSubmit } from "./owner"
import { transfer } from "./transfer"
import { WORKER_VERSION } from "./version"
import { cachedStorageUsage } from "./storage-usage"

export const app = new Hono<AppEnv>()

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: err.message || "Internal error" }, 500)
})

// ---------- Auth ----------

// GitHub stays mounted whenever credentials exist, but it is optional: a passkeys-only install has
// no GitHub App, and an MCP client authorizes through `/sign-in` instead (see `/authorize` below).
// On an install that configures it, `/sign-in` still offers it as the fallback.
app.get("/auth/login", (c) => startLogin(c))
app.get("/auth/callback", (c) => finishLogin(c))
app.get("/auth/logout", (c) => logout(c))

// The owner link: GET renders the form and burns nothing, POST burns the nonce and signs in.
app.get("/auth/owner", (c) => ownerLinkPage(c))
app.post("/auth/owner", (c) => ownerLinkSubmit(c))

// Passkeys: registration is owner-only, sign-in is anonymous, both single-use in D1.
app.get("/auth/passkey/register/options", (c) => registerOptions(c))
app.post("/auth/passkey/register/verify", (c) => registerVerify(c))
app.get("/auth/passkey/login/options", (c) => loginOptions(c))
app.post("/auth/passkey/login/verify", (c) => loginVerify(c))

/**
 * What this install can sign in with, for the anonymous sign-in page. It needs both facts to avoid
 * offering a dead end: a passkey button when none is registered, or a GitHub link on a passkeys-only
 * install. Nothing here is secret — the login page already reveals the same two things by trying.
 */
app.get("/auth/methods", async (c) => c.json({ github: githubEnabled(c.env), hasPasskeys: await db.hasPasskeys(c.env.DB) }))

// ---------- Transfer (TRANSFER_TOKEN only; 404 when unset) ----------
// Mounted before /api and outside its middleware: a move must not inherit session auth.
app.route("/transfer", transfer)

// ---------- MCP OAuth consent ----------
// MCP clients are sent here by the OAuth provider. Max signs in with the same
// GitHub session as the web app, then approves the client explicitly.

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!)

app.get("/authorize", async (c) => {
  const session = await getSession(c)
  if (!session) {
    // Sign in first, then come back here. `/sign-in` is the passkey page — the one route that works
    // on a passkeys-only install with no GitHub App — and it returns to this exact URL, query
    // included, so the client's authorization request survives the detour.
    const url = new URL(c.req.url)
    return c.redirect(signInPath(url.pathname + url.search))
  }
  const login = session.ownerId
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
  return new Response(html, {
    headers: new Headers([
      ...headers,
      ["content-type", "text/html; charset=utf-8"],
      // The consent page must never be framed (clickjacking).
      ["content-security-policy", "frame-ancestors 'none'"],
      ["x-frame-options", "DENY"],
    ]),
  })
})

app.post("/authorize", async (c) => {
  const refused = crossSiteWrite(c.req.raw, { json: false })
  if (refused) return c.text(refused, 403)
  const session = await getSession(c)
  if (!session) return c.text("Not signed in", 401)
  const form = await c.req.formData()
  const handle = String(form.get("handle") ?? "")
  if (form.get("decision") !== "approve") {
    const denied = await c.env.OAUTH_PROVIDER.denyConsent(c.req.raw, handle)
    return new Response(null, { status: 302, headers: denied.headers })
  }
  const approved = await c.env.OAUTH_PROVIDER.approveConsent(c.req.raw, handle)
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: approved.request,
    // Grants are bound to the owner identity, not to whichever method signed in.
    userId: session.ownerId,
    metadata: { label: session.label },
    scope: approved.request.scope,
    props: { ownerId: session.ownerId },
  })
  const headers = new Headers(approved.headers)
  headers.set("location", redirectTo)
  return new Response(null, { status: 302, headers })
})

// ---------- Files (R2) ----------

// Capture files. The agent may only write these.
const KEY_RE = /^refs\/[a-z0-9]+\/[A-Za-z0-9._\/-]+$/
// Served files: capture files plus the owner's uploaded images.
const FILE_KEY_RE = /^(refs|uploads)\/[a-z0-9]+\/[A-Za-z0-9._\/-]+$/

app.get("/files/*", async (c) => {
  const key = decodeURIComponent(c.req.path.slice("/files/".length))
  if (!FILE_KEY_RE.test(key) || key.includes("..")) return c.notFound()
  const signedOk = await verifyFileSig(c.env, key, c.req.query("exp"), c.req.query("sig"))
  if (!signedOk && !(await getSession(c))) return c.json({ error: "unauthorized" }, 401)
  // Byte ranges, which Safari needs before it will play a video. R2 reads the Range header itself.
  const ranged = c.req.header("range")?.startsWith("bytes=")
  // A range R2 can't satisfy is ignored and the whole file sent, which HTTP allows.
  const obj = ranged ? await c.env.FILES.get(key, { range: c.req.raw.headers }).catch(() => c.env.FILES.get(key)) : await c.env.FILES.get(key)
  if (!obj) return c.notFound()
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set("etag", obj.httpEtag)
  headers.set("accept-ranges", "bytes")
  headers.set("cache-control", "private, max-age=86400, immutable")
  headers.set("x-content-type-options", "nosniff")
  if (key.endsWith(".html") || key.endsWith(".svg")) {
    // Captured third-party HTML, or a site's SVG icon opened on its own: no scripts, opaque origin, no access to our cookies.
    headers.set("content-security-policy", "sandbox allow-popups; script-src 'none'; object-src 'none'; base-uri *")
  }
  if (key.endsWith(".json") && c.req.query("download")) {
    headers.set("content-disposition", `attachment; filename="${key.split("/").slice(-2).join("-")}"`)
  }
  const range = ranged && obj.body ? obj.range : undefined
  if (range) {
    // Runtimes differ in which keys they set (some set suffix: undefined), so check values, not keys.
    const r = range as { offset?: number; length?: number; suffix?: number }
    const start = typeof r.suffix === "number" ? Math.max(0, obj.size - r.suffix) : (r.offset ?? 0)
    const length = Math.min(obj.size - start, typeof r.suffix === "number" ? obj.size - start : (r.length ?? obj.size - start))
    headers.set("content-range", `bytes ${start}-${start + length - 1}/${obj.size}`)
    headers.set("content-length", String(length))
    return new Response(obj.body, { status: 206, headers })
  }
  return new Response(obj.body, { headers })
})

// ---------- Web API ----------

const api = new Hono<AppEnv>()
api.use("*", async (c, next) => {
  // An image upload is multipart, so it skips the JSON-only rule. It is still refused from any
  // other origin or site, and the Lax session cookie never rides a cross-site POST.
  const upload = c.req.method === "POST" && c.req.path === "/api/images"
  const refused = crossSiteWrite(c.req.raw, { json: !upload })
  if (refused) return c.json({ error: refused }, 403)
  // Without the JSON rule, an upload must prove it comes from this origin rather than merely not deny it.
  if (upload && c.req.header("origin") !== new URL(c.req.url).origin && c.req.header("sec-fetch-site") !== "same-origin")
    return c.json({ error: "upload must come from this site" }, 403)
  await next()
})
api.use("*", requireSession)

api.get("/me", (c) => {
  const session = c.get("session")
  return c.json({ login: session.ownerId, ownerId: session.ownerId, method: session.method })
})

// Signs every device out: the counter in the owners row moves and every cookie minted before it
// stops verifying. MCP tokens live in OAUTH_KV and are deliberately not affected.
api.post("/sign-out-all", async (c) => c.json({ ok: true, epoch: await signOutAll(c.env, c.get("session")) }))

// The owner's signed-in devices (passkeys only; GitHub sign-ins leave no device row).
api.get("/passkeys", (c) => listDevices(c))
api.delete("/passkeys/:id", (c) => removeDevice(c))

api.get("/cloud-status", async (c) => {
  const [owner, passkeys, presence, counts] = await Promise.all([
    db.firstOwner(c.env.DB),
    db.hasPasskeys(c.env.DB),
    db.getPresence(c.env.DB),
    db.libraryCounts(c.env.DB),
  ])
  const methods: ("passkey" | "github")[] = []
  if (passkeys) methods.push("passkey")
  if (githubEnabled(c.env)) methods.push("github")
  return c.json({
    version: WORKER_VERSION,
    hasOwner: !!owner,
    ownerId: owner?.id ?? null,
    methods,
    counts,
    lastCapture: { at: presence.lastSeenAt, activity: presence.activity, stale: presence.freshness !== "recent" },
  })
})

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
  const body = await c.req.json<{ url: string; mode: CaptureMode; maxPages?: number; collectionIds?: string[]; notes?: string; options?: unknown; allowDuplicate?: boolean }>()
  if (!body.url) return c.json({ error: "url is required" }, 400)
  try {
    if (!body.allowDuplicate) {
      const existing = await db.findReferenceByUrl(c.env.DB, body.url)
      if (existing) return c.json({ error: "This URL is already saved", existing }, 409)
    }
    const ref = await db.createReference(c.env.DB, {
      url: body.url,
      mode: body.mode === "crawl" ? "crawl" : "single",
      maxPages: body.maxPages,
      collectionIds: body.collectionIds,
      notes: body.notes,
      options: db.cleanOptions(body.options),
    })
    return c.json(ref, 201)
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

api.patch("/references/:id", async (c) => {
  const body = await c.req.json<{ notes?: unknown }>().catch(() => ({}) as { notes?: unknown })
  if (!("notes" in body)) return c.json({ error: "notes is required" }, 400)
  if (typeof body.notes === "string" && body.notes.length > db.MAX_NOTES) return c.json({ error: `Notes are limited to ${db.MAX_NOTES} characters` }, 400)
  return (await db.setNotes(c.env.DB, c.req.param("id"), body.notes)) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)
})

api.get("/agent", async (c) => c.json(await db.getPresence(c.env.DB)))
api.get("/storage", async (c) => {
  c.header("cache-control", "private, no-store")
  return c.json(await cachedStorageUsage({ files: c.env.FILES, requestUrl: c.req.url, sessionSecret: c.env.SESSION_SECRET }))
})

api.get("/references/:id", async (c) => {
  const r = await db.getReference(c.env.DB, c.req.param("id"))
  return r ? c.json(r) : c.json({ error: "not found" }, 404)
})

api.post("/references/:id/recapture", async (c) => {
  const id = c.req.param("id")
  // Retire the current file namespace and schedule its cleanup.
  await db.requeueReference(c.env.DB, id)
  c.executionCtx.waitUntil(db.cleanupRetiredFiles(c.env.DB, c.env.FILES))
  return c.json({ ok: true })
})

// Pause, resume and stop take effect between pages: the page being captured always finishes.
const control = (action: (database: D1Database, id: string) => Promise<boolean>) => async (c: Context<AppEnv>) => {
  const id = c.req.param("id")!
  if (!(await action(c.env.DB, id))) return c.json({ error: "This capture can't do that right now" }, 409)
  const ref = await db.getReference(c.env.DB, id)
  return c.json(ref?.reference ?? null)
}
api.post("/references/:id/pause", control(db.requestPause))
api.post("/references/:id/resume", control(db.resumeReference))
api.post("/references/:id/stop", control(db.requestStop))

api.delete("/references/:id", async (c) => {
  await db.deleteReference(c.env.DB, c.req.param("id"))
  c.executionCtx.waitUntil(db.cleanupRetiredFiles(c.env.DB, c.env.FILES))
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

// Save selected pages to a collection, or take them out. Pages keep their files and their website.
api.post("/collections/:cid/pages", async (c) => {
  const body = await c.req.json<{ pageIds?: unknown; member?: unknown }>().catch(() => ({}) as { pageIds?: unknown; member?: unknown })
  const pageIds = Array.isArray(body.pageIds) ? body.pageIds.filter((x): x is string => typeof x === "string") : []
  if (!pageIds.length) return c.json({ error: "pageIds is required" }, 400)
  if (pageIds.length > db.MAX_PAGES_PER_CHANGE) return c.json({ error: `At most ${db.MAX_PAGES_PER_CHANGE} pages at a time` }, 400)
  let changed: number | null
  try {
    changed = await db.setPageCollection(c.env.DB, c.req.param("cid"), pageIds, body.member !== false)
  } catch (e) {
    if (e instanceof db.StalePagesError) return c.json({ error: e.message, missingPageIds: e.missing }, 409)
    throw e
  }
  return changed === null ? c.json({ error: "collection not found" }, 404) : c.json({ ok: true, changed })
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

// Images, sections, counts and board canvases.
api.route("/", canvas)

app.route("/api", api)

// ---------- Capture agent API (bearer CAPTURE_TOKEN) ----------

const agent = new Hono<AppEnv>()
agent.use("*", requireCaptureToken)
agent.use("*", async (c, next) => {
  if (c.req.header("x-snip-capture-protocol") !== "3") return c.json({ error: "Capture agent upgrade required. Install the latest Snip capture agent." }, 426)
  await next()
})

const attemptFrom = (c: { req: { header(name: string): string | undefined } }) => c.req.header("x-snip-capture-attempt") ?? ""
const validAttempt = (attempt: string) => /^[a-f0-9]{32}$/.test(attempt)

// Lets `npm run doctor` check the URL and token without claiming a job or touching presence.
agent.get("/ping", (c) => c.json({ ok: true }))

agent.post("/jobs/claim", async (c) => {
  const job = await db.claimJob(c.env.DB)
  c.executionCtx.waitUntil(db.cleanupRetiredFiles(c.env.DB, c.env.FILES))
  await db.touchPresence(c.env.DB, job ? "busy" : "idle", job?.id ?? null)
  // Advertise on every claim, including resumed jobs: the destination may have been upgraded since the last one.
  return job ? c.json({ ...job, recordingFormats: ["gif", "webm"], features: ["sections", "live", "schemes", "icon"] }) : c.body(null, 204)
})

agent.post("/heartbeat", async (c) => {
  const { jobId } = await c.req.json<{ jobId?: string | null }>().catch(() => ({ jobId: null }))
  const attempt = attemptFrom(c)
  if (jobId && (!validAttempt(attempt) || !(await db.renewLease(c.env.DB, jobId, attempt)))) return c.json({ error: "job is gone" }, 410)
  await db.touchPresence(c.env.DB, jobId ? "busy" : "idle", jobId ?? null)
  return c.json({ ok: true })
})

agent.post("/jobs/:id/progress", async (c) => {
  const attempt = attemptFrom(c)
  const { message } = await c.req.json<{ message: string }>()
  if (!validAttempt(attempt) || !(await db.setProgress(c.env.DB, c.req.param("id"), attempt, message))) return c.json({ error: "job is gone" }, 410)
  await db.touchPresence(c.env.DB, "busy", c.req.param("id"))
  return c.json({ ok: true })
})

agent.get("/jobs/:id/control", async (c) => {
  const attempt = attemptFrom(c)
  const result = validAttempt(attempt) ? await db.getControl(c.env.DB, c.req.param("id"), attempt) : null
  return result ? c.json(result) : c.json({ error: "job is gone" }, 410)
})

agent.post("/jobs/:id/pause", async (c) => {
  const attempt = attemptFrom(c)
  if (!validAttempt(attempt)) return c.json({ error: "job is gone" }, 410)
  const state = await c.req.json<CrawlState>()
  const result = await db.pauseJob(c.env.DB, c.req.param("id"), attempt, state)
  if (result === "gone") return c.json({ error: "job is gone" }, 410)
  if (result === "changed") return c.json({ error: "pause no longer requested" }, 409)
  await db.touchPresence(c.env.DB, "idle", null)
  return c.json({ ok: true })
})

agent.put("/files/*", async (c) => {
  const key = c.req.path.slice("/agent/files/".length)
  const attempt = attemptFrom(c)
  if (!KEY_RE.test(key) || key.includes("..")) return c.json({ error: "bad key" }, 400)
  const parts = key.split("/")
  if (!validAttempt(attempt) || parts[2] !== attempt) return c.json({ error: "job is gone" }, 410)
  const upload = await db.beginUpload(c.env.DB, parts[1]!, attempt, key)
  if (!upload) return c.json({ error: "job is gone" }, 410)
  const contentType = c.req.header("content-type") ?? "application/octet-stream"
  // Keep the durable intent if the write, postcheck or stale-key deletion fails.
  await c.env.FILES.put(key, c.req.raw.body, { httpMetadata: { contentType } })
  if (!(await db.isCapturing(c.env.DB, parts[1]!, attempt))) {
    await c.env.FILES.delete(key)
    await db.finishUpload(c.env.DB, upload)
    return c.json({ error: "job is gone" }, 410)
  }
  await db.finishUpload(c.env.DB, upload)
  return c.json({ key })
})

const num = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0
/** Sections as the agent sends them: the viewer and MCP position clips and crops from these numbers. */
function validSections(sections: unknown): sections is NonNullable<PageUpload["sections"]> {
  return Array.isArray(sections) && sections.length <= 64 && sections.every((s) =>
    s && typeof s === "object" && typeof s.key === "string" && typeof s.label === "string" && s.label.length <= 200 &&
    ["header", "hero", "section", "footer"].includes(s.kind) && num(s.y) && num(s.height) &&
    (s.live === undefined || (s.live && typeof s.live.key === "string" && num(s.live.height) && num(s.live.durationMs) && (s.live.y === undefined || num(s.live.y)))))
}

agent.post("/jobs/:id/pages", async (c) => {
  const id = c.req.param("id")
  const attempt = attemptFrom(c)
  if (!validAttempt(attempt)) return c.json({ error: "job is gone" }, 410)
  const page = await c.req.json<PageUpload>()
  const prefix = `refs/${id}/${attempt}/`
  if (page.sections !== undefined && !validSections(page.sections)) return c.json({ error: "bad sections" }, 400)
  const alt = page.altScheme
  if (alt !== undefined && !(alt && (alt.scheme === "light" || alt.scheme === "dark") && typeof alt.desktopKey === "string" && typeof alt.desktopThumbKey === "string" &&
    num(alt.desktopWidth) && num(alt.desktopHeight) && Array.isArray(alt.sectionKeys) && alt.sectionKeys.length <= 64 && alt.sectionKeys.every((k) => k === null || typeof k === "string")))
    return c.json({ error: "bad altScheme" }, 400)
  const keys = [page.desktopKey, page.desktopThumbKey, page.mobileKey, page.mobileThumbKey, page.snapshotKey, page.stylesKey, ...(page.sections ?? []).flatMap((s) => [s.key, s.live?.key]), alt?.desktopKey, alt?.desktopThumbKey, ...(alt?.sectionKeys ?? []), ...page.animations.flatMap((a) => [a.gifKey, a.sheetKey])]
  if (keys.some((key) => key && !key.startsWith(prefix))) return c.json({ error: "bad file key" }, 400)
  const pageId = await db.addPage(c.env.DB, id, attempt, page)
  return pageId ? c.json({ id: pageId }) : c.json({ error: "job is gone" }, 410)
})

agent.post("/jobs/:id/complete", async (c) => {
  const id = c.req.param("id")
  const attempt = attemptFrom(c)
  const body = await c.req.json<JobComplete>()
  const prefix = `refs/${id}/${attempt}/`
  if (body.coverKey && !body.coverKey.startsWith(prefix)) return c.json({ error: "bad file key" }, 400)
  // Only an icon saved with this capture is kept. An older agent sends the site's icon URL instead, which Snip never loads.
  if (!body.favicon?.startsWith(prefix)) body.favicon = null
  if (!validAttempt(attempt) || !(await db.completeJob(c.env.DB, id, attempt, body))) return c.json({ error: "job is gone" }, 410)
  await db.touchPresence(c.env.DB, "idle", null)
  return c.json({ ok: true })
})

agent.post("/jobs/:id/fail", async (c) => {
  const attempt = attemptFrom(c)
  const { error } = await c.req.json<{ error: string }>()
  if (!validAttempt(attempt) || !(await db.failJob(c.env.DB, c.req.param("id"), attempt, error))) return c.json({ error: "job is gone" }, 410)
  await db.touchPresence(c.env.DB, "idle", null)
  return c.json({ ok: true })
})

app.route("/agent", agent)
