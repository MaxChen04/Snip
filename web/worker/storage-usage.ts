import type { StorageUsage } from "../shared/types"
import { sign } from "./auth"
import { storageUsage } from "./db"

const CACHE_NAME = "snip-storage-usage-v1"
const CACHE_SECONDS = 5 * 60

function readUsage(value: unknown): StorageUsage | null {
  if (!value || typeof value !== "object" || !("computedAt" in value) || !("usage" in value)) return null
  if (typeof value.computedAt !== "number") return null
  const age = Date.now() - value.computedAt
  if (age < 0 || age >= CACHE_SECONDS * 1000) return null
  const usage = value.usage
  if (!usage || typeof usage !== "object") return null
  if (!("bytes" in usage) || typeof usage.bytes !== "number" || !Number.isSafeInteger(usage.bytes) || usage.bytes < 0) return null
  if (!("objects" in usage) || typeof usage.objects !== "number" || !Number.isSafeInteger(usage.objects) || usage.objects < 0) return null
  if (!("partial" in usage) || typeof usage.partial !== "boolean") return null
  if (!("freeBytes" in usage) || typeof usage.freeBytes !== "number" || !Number.isSafeInteger(usage.freeBytes) || usage.freeBytes < 0) return null
  return { bytes: usage.bytes, objects: usage.objects, partial: usage.partial, freeBytes: usage.freeBytes }
}

/** Call only after session authentication. The cache is internal, never the HTTP response. */
export async function cachedStorageUsage({ files, requestUrl, sessionSecret }: {
  files: R2Bucket
  requestUrl: string
  sessionSecret: string
}): Promise<StorageUsage> {
  let cache: Cache | undefined
  let key: string | undefined
  try {
    if (typeof caches !== "undefined" && sessionSecret) {
      // Separate origins and installations, including local libraries sharing a hostname.
      const instance = await sign(sessionSecret, CACHE_NAME)
      key = new URL(`/.snip-cache/storage-usage/${instance}`, new URL(requestUrl).origin).href
      cache = await caches.open(CACHE_NAME)
      const response = await cache.match(key)
      if (response?.ok) {
        const value: unknown = await response.json()
        const usage = readUsage(value)
        if (usage) return usage
      }
    }
  } catch {
    // Cache availability or invalid data must not prevent reading the meter.
  }

  // R2 failures propagate normally and are never written to the cache.
  const usage = await storageUsage(files)
  if (cache && key) {
    try {
      await cache.put(key, new Response(JSON.stringify({ computedAt: Date.now(), usage }), {
        headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_SECONDS}` },
      }))
    } catch {
      // This summary is still usable if the best-effort cache write fails.
    }
  }
  return usage
}
