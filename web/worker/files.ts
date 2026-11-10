import { isGzipKey } from "../shared/types"

/**
 * The one place that knows a stored file may be gzipped. Every Worker read of a capture file goes through here, and a
 * key from `gzipKey` comes back with `body` already unzipped unless the caller passes `unzip: false`; any other key is
 * R2's bytes untouched, which is how everything captured before gzip existed is read.
 *
 * Reading depends on the name alone, never on what the claim advertises. Once a Worker has read gzip, every later
 * version must keep this reader and the `reads` entry in /transfer/status: to stop writing gzip, take "gzip" out of the
 * claim's features and nothing else, or every file already stored that way becomes unreadable. Builds from before
 * Worker 1.4.0 serve these files as raw gzip bytes and cannot be changed (docs/storage-usage.md).
 *
 * Only `/files/*` may take `unzip: false`, and only for a client that accepts gzip (`acceptsGzip`): it sends the
 * stored bytes with `Content-Encoding: gzip` and `encodeBody: "manual"`. Without "manual" the runtime gzips such a
 * body again (measured in local workerd; a one-off test on Cloudflare saw the same). Text read inside the Worker (the
 * MCP tools) always unzips.
 *
 * `object` is R2's own record: for a gzipped file its `size` and `httpEtag` describe the stored (compressed) bytes, and
 * `range` is not meaningful, so callers must not pass one for such a key (see `isGzipKey`). Never store a
 * `contentEncoding` in R2's httpMetadata: `writeHttpMetadata` would copy it onto unzipped responses.
 */
export async function getFile(bucket: R2Bucket, key: string, options?: R2GetOptions, { unzip = true } = {}) {
  const object = await bucket.get(key, options)
  if (!object) return null
  return { object, body: unzip && isGzipKey(key) ? object.body.pipeThrough(new DecompressionStream("gzip")) : object.body }
}

/** A stored file as text, or null when it is not there. */
export async function readText(bucket: R2Bucket, key: string) {
  const file = await getFile(bucket, key)
  return file ? new Response(file.body).text() : null
}

/**
 * Whether the client said it takes a gzip body. On Cloudflare the Worker sees a rewritten Accept-Encoding ("gzip, br"
 * for everyone); the client's own value is `cf.clientAcceptEncoding`, absent locally. `*`, `x-gzip` and `gzip;q=0`
 * count as no, and the file is unzipped, which every client can read.
 */
export function acceptsGzip(request: Request) {
  const value = request.cf?.clientAcceptEncoding ?? request.headers.get("accept-encoding") ?? ""
  return String(value).split(",").some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(";").map((s) => s.trim())
    return coding === "gzip" && !params.some((p) => /^q=0(\.0{0,3})?$/.test(p))
  })
}

/**
 * One gzip member of a split styles file (shared/style-parts.ts), parsed, or null when the file or the range is
 * missing or doesn't decode: the caller then reads the full styles file instead. The file's name never matches
 * isGzipKey, so `/files/*` and getFile leave its bytes alone.
 */
export async function readStylePart<T>(bucket: R2Bucket, key: string, [offset, length]: [number, number]): Promise<T | null> {
  try {
    const object = await bucket.get(key, { range: { offset, length } })
    if (!object) return null
    return (await new Response(object.body.pipeThrough(new DecompressionStream("gzip"))).json()) as T
  } catch {
    return null
  }
}
