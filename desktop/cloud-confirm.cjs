// Deleting a snapshot directory is guarded by a stale-record interlock, not a typed
// secret: the renderer forwards the basename of the record it rendered, and main passes
// it to the engine verbatim. Deriving it here would defeat the check (contracts v3.13).

const DELETING = new Set(["delete", "delete-export"])

function basename(value) {
  return typeof value === "string" ? value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "" : ""
}

/** `{ ok: true, flags }` or `{ error, code }`. Never reads cloud state. */
function snapshotFlags(action, confirm) {
  if (!["restore", "delete", "delete-export"].includes(action)) return { error: "Unknown snapshot action.", code: "UNSUPPORTED" }
  if (!DELETING.has(action)) return { ok: true, flags: {} }
  const value = typeof confirm === "string" ? confirm.trim() : ""
  if (!value) return { error: "confirm required", code: "CONFIRM_MISSING" }
  // A path here means the caller did not send the rendered basename.
  if (value !== basename(value) || value === "." || value === "..") return { error: "This item changed. Refresh and try again.", code: "CONFIRM_MISMATCH" }
  return { ok: true, flags: { confirm: value } }
}

module.exports = { snapshotFlags, basename }
