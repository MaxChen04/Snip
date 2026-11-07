// Synthetic test values.
//
// Every id and object key here is deliberately patterned so that a reader — or a
// secret scanner — can tell at a glance that it never came from a live install:
// zeros carrying a small tag, or one repeated digit. Nothing below has to resemble
// a real Cloudflare account, D1 database, KV namespace, R2 key or library id; the
// tests only care that the values are unique and that they satisfy the validators
// (a ref id is [a-z0-9]{16}, and a key after it may hold letters, digits, dots,
// underscores and slashes).
//
// Keep this file the single source for these values so a new test cannot quietly
// paste in something that looks real.

const ACCOUNT_ID = "00000000000000000000000000000a01";
const LIBRARY_ID = "00000000000000a001";
const DATABASE_ID = "00000000-0000-4000-8000-00000000a001";
const NAMESPACE_ID = "00000000000000000000000000000a02";
const ATTEMPT_ID = "00000000000000000000000000000a01";

// A ref id shaped like the real one, but spelt out.
const refId = (n) => `testref${String(n).padStart(9, "0")}`;

// refs/<ref>/<attempt>/<page>, the key layout the transfer routes accept.
const fileKey = (ref, page) => `refs/${refId(ref)}/${ATTEMPT_ID}/${page}`;

module.exports = { ACCOUNT_ID, LIBRARY_ID, DATABASE_ID, NAMESPACE_ID, ATTEMPT_ID, refId, fileKey };
