import type { SnapshotRecord } from "./types"

export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  const shown = value >= 100 || unit === 0 ? Math.round(value) : value >= 10 ? value.toFixed(0) : value.toFixed(1)
  return `${shown} ${units[unit]}`
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return ""
  try {
    return new URL(url).host
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "")
  }
}

const date = (iso: string | null, options: Intl.DateTimeFormatOptions) => {
  if (!iso) return null
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  return new Intl.DateTimeFormat("en-GB", options).format(new Date(at))
}

/** "Snapshot from 6 Nov, 10:12 — 812 MB", the one line Settings shows. */
export function snapshotLabel(snapshot: SnapshotRecord | null): string | null {
  if (!snapshot?.takenAt) return null
  const day = date(snapshot.takenAt, { day: "numeric", month: "short" })
  const time = date(snapshot.takenAt, { hour: "2-digit", minute: "2-digit", hour12: false })
  if (!day || !time) return null
  const size = formatBytes(snapshot.bytes)
  return size ? `Snapshot from ${day}, ${time} — ${size}` : `Snapshot from ${day}, ${time}`
}

/** "the snapshot from 6 Nov, 02:12 — 812 MB", for a sentence that needs an object. */
export function snapshotPhrase(snapshot: SnapshotRecord | null): string | null {
  const label = snapshotLabel(snapshot)
  return label ? `${label[0].toLowerCase()}${label.slice(1)}` : null
}

/** A short date for the detached row: "6 Nov". */
export function shortDate(iso: string | null): string | null {
  return date(iso, { day: "numeric", month: "short" })
}
