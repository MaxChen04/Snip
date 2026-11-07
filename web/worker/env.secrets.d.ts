// Runtime secrets and local-only vars, declared here so `npm run cf-typegen` cannot drop them.
//
// `worker-configuration.d.ts` is generated from wrangler.jsonc plus whatever happens to be in
// .dev.vars, so on a fresh clone it omits every secret and the build fails with names that look
// undefined. This file is committed and merges with the generated `Env` interface; duplicate
// members must keep the exact same type.
//
// `wrangler types` only knows names it sees, so .dev.vars.example lists them all — but the type
// contract lives here, not there.

interface Env {
  /** HMAC key for the owner link. Separate from SESSION_SECRET so rotating one keeps the other. */
  OWNER_LINK_SECRET: string
  /**
   * Bearer for /transfer/*, set only during a move or pull. Typed as a string because every
   * route that reads it has already refused the request when it is unset.
   */
  TRANSFER_TOKEN: string
  SESSION_SECRET: string
  CAPTURE_TOKEN: string
  /** Optional: GitHub sign-in mounts whenever a client id exists and explains a missing secret. */
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  /** Local .dev.vars only; never deployed. */
  DEV_LOGIN: string
}
