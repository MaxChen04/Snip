import { isGzipKey } from "../shared/types"

/**
 * The one place that knows a stored file may be gzipped. Every Worker read of a capture file goes through here, and a
 * key from `gzipKey` comes back with `body` already unzipped; any other key is R2's bytes untouched, which is how
 * everything captured before gzip existed is read.
 *
 * The unzip is done here, never left to a `Content-Encoding` header. Local workerd compresses a response again when it
 * carries that header (measured: a stored gzip object served with it reached the client gzipped twice), and what the
 * deployed edge does with an R2 stream behind it is not something this code can check. A plain response is the same on
 * every runtime, and the edge still compresses text on the way out.
 *
 * `object` is R2's own record: for a gzipped file its `size` and `httpEtag` describe the stored (compressed) bytes, and
 * `range` is not meaningful, so callers must not pass one for such a key (see `isGzipKey`).
 */
export async function getFile(bucket: R2Bucket, key: string, options?: R2GetOptions) {
  const object = await bucket.get(key, options)
  if (!object) return null
  return { object, body: isGzipKey(key) ? object.body.pipeThrough(new DecompressionStream("gzip")) : object.body }
}

/** A stored file as text, or null when it is not there. */
export async function readText(bucket: R2Bucket, key: string) {
  const file = await getFile(bucket, key)
  return file ? new Response(file.body).text() : null
}
