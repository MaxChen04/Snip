import { Hono } from "hono"
import { ownerSecretHash, timingSafeEqual } from "./auth"
import * as db from "./db"

// The transfer surface exists only while TRANSFER_TOKEN is set: the provisioning engine sets it
// before a move or a pull and deletes it afterwards. It is mounted outside /api so it inherits
// neither sameOriginWrites nor requireSession, and every body is streamed — a move can carry
// gigabytes through it.

export const WORKER_VERSION = "1.0.0"
export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024

const KEY_RE = /^refs\/[a-z0-9]+\/[A-Za-z0-9._\/-]+$/
const validKey = (key: string) => KEY_RE.test(key) && !key.includes("..")
const keyFromPath = (path: string) => decodeURIComponent(path.slice("/transfer/file/".length))

export const transfer = new Hono<{ Bindings: Env }>()

transfer.use("*", async (c, next) => {
  if (!c.env.TRANSFER_TOKEN) return c.notFound()
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "")
  if (!token || !timingSafeEqual(token, c.env.TRANSFER_TOKEN)) return c.json({ error: "unauthorized" }, 401)
  await next()
})

transfer.get("/status", async (c) => {
  const owner = await db.firstOwner(c.env.DB)
  return c.json({
    version: WORKER_VERSION,
    hasOwner: !!owner,
    ownerId: owner?.id ?? null,
    counts: await db.libraryCounts(c.env.DB),
    ownerSecretHash: await ownerSecretHash(c.env.OWNER_LINK_SECRET),
  })
})

// `finish` resumes the captures `quiesce` paused, so a crawl that was running when the user
// enabled cloud continues on this side. The engine has no browser cookie at that point and must
// not get one, so the resume rides the same short-lived bearer as the copy.
//
// Semantics are the app's own Resume button: db.resumeReference and nothing else. `skipped` is
// not a failure — a capture that finished during the move is already in the wanted state — so a
// second call returns the same set and changes nothing.
const REF_ID_RE = /^[a-z0-9]{16}$/
export const MAX_RESUME_IDS = 100

transfer.post("/resume", async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null)
  const ids = body?.ids
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_RESUME_IDS || !ids.every((id): id is string => typeof id === "string" && REF_ID_RE.test(id))) {
    return c.json({ error: `ids must be 1 to ${MAX_RESUME_IDS} reference ids` }, 400)
  }
  let resumed = 0
  const skipped: string[] = []
  for (const id of ids) {
    if (await db.resumeReference(c.env.DB, id)) resumed++
    else skipped.push(id)
  }
  return c.json({ resumed, skipped })
})

/**
 * The manifest is built by listing the bucket, never by querying D1: orphaned objects are
 * legitimate (cleanup can give up on a delete) and a move has to carry them too.
 *
 * Pull-based so the listing runs as the consumer reads, which keeps a library with tens of
 * thousands of objects inside the Worker's memory budget and needs no background writer.
 */
function manifestStream(bucket: R2Bucket, tables: Record<string, number>) {
  const encoder = new TextEncoder()
  let cursor: string | undefined
  let listing = true
  let first = true
  let totalBytes = 0

  /**
   * R2's list() carries httpMetadata, but some local runtimes return an empty object there.
   * A missing content type is looked up with HEAD so a local library still round-trips its
   * images, and only then; on R2 the listing already has the value and no extra call happens.
   */
  const contentTypeOf = async (object: R2Object) => {
    if (object.httpMetadata?.contentType) return object.httpMetadata.contentType
    const head = await bucket.head(object.key)
    return head?.httpMetadata?.contentType ?? "application/octet-stream"
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`{"version":1,"tables":${JSON.stringify(tables)},"keys":[`))
    },
    async pull(controller) {
      try {
        if (!listing) {
          controller.enqueue(encoder.encode(`],"totalBytes":${totalBytes}}`))
          controller.close()
          return
        }
        const page = await bucket.list({ cursor, limit: 1000 })
        let chunk = ""
        for (const object of page.objects) {
          totalBytes += object.size
          chunk += `${first ? "" : ","}${JSON.stringify({ key: object.key, size: object.size, contentType: await contentTypeOf(object) })}`
          first = false
        }
        cursor = page.truncated ? page.cursor : undefined
        listing = !!cursor
        if (chunk) controller.enqueue(encoder.encode(chunk))
      } catch (error) {
        controller.error(error)
      }
    },
  })
}

transfer.get("/manifest", async (c) => {
  const tables = await db.tableCounts(c.env.DB)
  return new Response(manifestStream(c.env.FILES, tables), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
})

transfer.on("HEAD", "/file/*", async (c) => {
  const key = keyFromPath(c.req.path)
  if (!validKey(key)) return c.json({ error: "bad key" }, 400)
  const object = await c.env.FILES.head(key)
  if (!object) return c.body(null, 404)
  return c.body(null, 200, {
    "content-length": String(object.size),
    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    etag: object.httpEtag,
  })
})

// A pull has to read the bytes and holds only TRANSFER_TOKEN, never a session cookie. Streamed
// like the upload; no Range support, whole object only.
transfer.get("/file/*", async (c) => {
  const key = keyFromPath(c.req.path)
  if (!validKey(key)) return c.json({ error: "bad key" }, 400)
  const object = await c.env.FILES.get(key)
  if (!object) return c.body(null, 404)
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "content-length": String(object.size),
      etag: object.httpEtag,
      "cache-control": "no-store",
    },
  })
})

/** Counts bytes as they pass, so an upload without a content-length is still bounded. */
function guardSize(body: ReadableStream<Uint8Array>) {
  let total = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength
        if (total > MAX_TRANSFER_BYTES) controller.error(new Error(TOO_LARGE))
        else controller.enqueue(chunk)
      },
    }),
  )
}

const TOO_LARGE = `files are limited to ${MAX_TRANSFER_BYTES} bytes`

transfer.put("/file/*", async (c) => {
  const key = keyFromPath(c.req.path)
  if (!validKey(key)) return c.json({ error: "bad key" }, 400)
  const declared = Number(c.req.header("content-length") ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_TRANSFER_BYTES) return c.json({ error: TOO_LARGE }, 413)
  if (!c.req.raw.body) return c.json({ error: "expected a request body" }, 400)
  if (c.req.query("overwrite") !== "1" && (await c.env.FILES.head(key))) return c.json({ error: "key already exists" }, 409)
  // R2 takes a request body as-is when its length is known; only a chunked upload needs the
  // counting wrapper, because the size cap has to be enforced somewhere.
  const body = Number.isFinite(declared) ? c.req.raw.body : guardSize(c.req.raw.body)
  try {
    const object = await c.env.FILES.put(key, body, {
      httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" },
    })
    if (!object) return c.json({ error: "upload failed" }, 500)
    return c.json({ ok: true, size: object.size })
  } catch (error) {
    if (error instanceof Error && error.message === TOO_LARGE) return c.json({ error: TOO_LARGE }, 413)
    throw error
  }
})
