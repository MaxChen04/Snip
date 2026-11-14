import type { Context, MiddlewareHandler } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider"
import { safeNext } from "../shared/safe-next"

// Web sessions, stored as an HMAC-signed cookie.
//
// A session names the owner identity, how it signed in, and the "sign out everywhere" epoch it
// was minted at. The owner link and passkeys are the owner's own path in; GitHub remains the path
// for a second person, keeping its multi-login allowlist.
//
// Payload: "owner:<ownerId>|<expMs>|<method>|<epoch>"
// Legacy (before owner identity): "<login>|<expMs>", still accepted so a deploy signs nobody out.

export type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers; DEV_LOGIN?: string }
export type AppEnv = { Bindings: Bindings; Variables: { login: string; session: Session } }

export type SessionMethod = "owner" | "passkey" | "github"
export type Session = { ownerId: string; label: string; method: SessionMethod; epoch: number }

export const SESSION_COOKIE = "rs_session"
export const STATE_COOKIE = "rs_oauth_state"
const SESSION_DAYS = 30

const enc = new TextEncoder()

function b64url(buf: ArrayBuffer | Uint8Array) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** base64url of a SHA-256 digest, without padding. */
export async function sha256B64(text: string) {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(text)))
}

// Imported once per isolate; signing a page of file URLs otherwise re-imports it for every URL.
const keys = new Map<string, Promise<CryptoKey>>()
const hmacKey = (secret: string) => {
  let key = keys.get(secret)
  if (!key) {
    key = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    keys.set(secret, key)
  }
  return key
}

async function hmac(secret: string, data: string) {
  const key = await hmacKey(secret)
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)))
}

export function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function sign(secret: string, payload: string) {
  return `${payload}.${await hmac(secret, payload)}`
}

export async function verify(secret: string, signed: string | undefined | null): Promise<string | null> {
  if (!signed) return null
  const i = signed.lastIndexOf(".")
  if (i < 0) return null
  const payload = signed.slice(0, i)
  const sig = signed.slice(i + 1)
  return timingSafeEqual(sig, await hmac(secret, payload)) ? payload : null
}

/** Placeholder shipped in the example config. It never matches a real GitHub login. */
export const LOGIN_PLACEHOLDER = "your-github-login"

/** GitHub logins allowed to sign in. Empty (fail closed) until the owner sets their own. */
export function allowedLogins(env: Env) {
  return String(env.ALLOWED_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== LOGIN_PLACEHOLDER)
}

const NO_LOGINS =
  "This Snip instance has no allowed GitHub logins yet. Set ALLOWED_GITHUB_LOGINS to your GitHub login in the Worker's variables, then deploy again. Only an install that already configured GitHub sign-in reaches this page; a new install signs in with a passkey."

export function isLocalOrigin(url: string) {
  const h = new URL(url).hostname
  return h === "localhost" || h === "127.0.0.1"
}

// ---------- Owner identity ----------

const isMethod = (m: string): m is SessionMethod => m === "owner" || m === "passkey" || m === "github"

type ParsedSession = { session: Session; exp: number }

function parseSessionPayload(payload: string): ParsedSession | null {
  const [head, expRaw, ...rest] = payload.split("|")
  if (!head || !expRaw) return null
  const exp = Number(expRaw)
  if (!Number.isFinite(exp)) return null
  if (head.startsWith("owner:")) {
    const ownerId = head.slice("owner:".length)
    const method = rest[0]
    const epoch = Number(rest[1])
    if (!ownerId || !method || !isMethod(method) || rest.length !== 2 || !Number.isInteger(epoch)) return null
    return { session: { ownerId, label: ownerId, method, epoch }, exp }
  }
  // Legacy payload: "<login>|<exp>". Never invalidated by a deploy; epoch 0 is what a fresh
  // owners row holds until "sign out everywhere" bumps it.
  if (rest.length) return null
  return { session: { ownerId: head, label: head, method: "github", epoch: 0 }, exp }
}

/** The highest sessions_epoch across owners rows; 0 when there is no owner yet. */
export async function currentEpoch(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT max(sessions_epoch) AS epoch FROM owners`).first<{ epoch: number | null }>()
  return row?.epoch ?? 0
}

/** Epoch plus the stored label for one identity, in a single round trip. */
async function ownerState(db: D1Database, ownerId: string): Promise<{ epoch: number; label: string | null }> {
  const row = await db
    .prepare(`SELECT (SELECT max(sessions_epoch) FROM owners) AS epoch, (SELECT label FROM owners WHERE id = ?) AS label`)
    .bind(ownerId)
    .first<{ epoch: number | null; label: string | null }>()
  return { epoch: row?.epoch ?? 0, label: row?.label ?? null }
}

function sessionPayload(session: Session, exp: number) {
  return `owner:${session.ownerId}|${exp}|${session.method}|${session.epoch}`
}

/** The signed cookie value, also used as the loopback handoff token. */
export async function sessionToken(env: Env, session: Session, ttlMs = SESSION_DAYS * 86_400_000) {
  return sign(env.SESSION_SECRET, sessionPayload(session, Date.now() + ttlMs))
}

function sessionCookieOptions(req: Request) {
  return {
    httpOnly: true,
    secure: !isLocalOrigin(req.url),
    sameSite: "Lax" as const,
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  }
}

/** Sets the cookie from an already-minted token, so the fragment and the cookie are byte-identical. */
export function setSessionTokenCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c.req.raw))
}

export async function setSessionCookie(c: Context<AppEnv>, session: Session) {
  setSessionTokenCookie(c, await sessionToken(c.env, session))
}

/**
 * The signed-in owner, or null. DEV_LOGIN short-circuits on localhost and reports epoch -1,
 * which means "never check the epoch".
 */
export async function getSession(c: Context<AppEnv>): Promise<Session | null> {
  const devLogin = c.env.DEV_LOGIN
  if (devLogin && isLocalOrigin(c.req.url)) return { ownerId: devLogin, label: "Local", method: "owner", epoch: -1 }
  const payload = await verify(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE))
  if (!payload) return null
  const parsed = parseSessionPayload(payload)
  if (!parsed || parsed.exp < Date.now()) return null
  // The allowlist that let a GitHub login in also decides whether its session still stands.
  if (parsed.session.method === "github" && !allowedLogins(c.env).includes(parsed.session.ownerId.toLowerCase())) return null
  if (parsed.session.epoch === -1) return parsed.session
  const state = await ownerState(c.env.DB, parsed.session.ownerId)
  // A session minted before "sign out everywhere" carries an older epoch and stops here.
  if (parsed.session.epoch !== state.epoch) return null
  return state.label ? { ...parsed.session, label: state.label } : parsed.session
}

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: "unauthorized" }, 401)
  c.set("login", session.ownerId)
  c.set("session", session)
  await next()
}

/**
 * Creates the owner row on first sign-in, or updates the existing one in place.
 *
 * Contracts §4.2.1: this is an upsert on `id` that **never changes `sessions_epoch`** — signing in
 * again must not un-revoke sessions the owner ended — and it never touches `passkeys` or any
 * other table. A brand-new row inherits `max(sessions_epoch)` so it cannot reset a sign-out-all
 * either, and an existing label or secret hash is only replaced when a new value is supplied
 * (`owner rotate` sends one; a plain link does not).
 */
export async function ensureOwner(env: Env, ownerId: string, label?: string | null, secretHash?: string | null) {
  await env.DB.prepare(
    `INSERT INTO owners (id, label, created_at, sessions_epoch, owner_secret_hash)
     VALUES (?, ?, ?, (SELECT coalesce(max(sessions_epoch), 0) FROM owners), ?)
     ON CONFLICT (id) DO UPDATE SET
       label = coalesce(owners.label, excluded.label),
       owner_secret_hash = coalesce(excluded.owner_secret_hash, owners.owner_secret_hash)`,
  )
    .bind(ownerId, label || ownerId, new Date().toISOString(), secretHash ?? null)
    .run()
}

/**
 * Increments the revocation counter for every identity. With no owners row yet, the caller's own
 * identity becomes the row first, so the bump has somewhere to land and epoch-0 sessions stop working.
 */
export async function signOutAll(env: Env, session: Session): Promise<number> {
  const bumped = await env.DB.prepare(`UPDATE owners SET sessions_epoch = sessions_epoch + 1`).run()
  if (!bumped.meta.changes) {
    await ensureOwner(env, session.ownerId, session.label)
    if (!(await env.DB.prepare(`UPDATE owners SET sessions_epoch = sessions_epoch + 1`).run()).meta.changes) {
      throw new Error("Could not revoke sessions")
    }
  }
  return currentEpoch(env.DB)
}

// ---------- Owner link ----------
//
// The engine mints https://<url>/auth/owner?t=<signed payload>. The payload is
// "snip-owner-v1|<ownerId>|<expEpochSeconds>|<nonceHex32>|<port>" and the signature is the same
// HMAC form as a session, keyed by OWNER_LINK_SECRET so rotating SESSION_SECRET does not break
// a link that is still on screen.

export const OWNER_LINK_PREFIX = "snip-owner-v1"
export const OWNER_LINK_TTL_SECONDS = 600

export type OwnerLink = { ownerId: string; exp: number; nonce: string; port: number }

export type OwnerLinkCheck = { ok: true; link: OwnerLink } | { ok: false; reason: "invalid" | "expired" }

export async function verifyOwnerLink(env: Env, token: string | null | undefined): Promise<OwnerLinkCheck> {
  if (!token || !env.OWNER_LINK_SECRET) return { ok: false, reason: "invalid" }
  const payload = await verify(env.OWNER_LINK_SECRET, token)
  if (!payload) return { ok: false, reason: "invalid" }
  const parts = payload.split("|")
  if (parts.length !== 5) return { ok: false, reason: "invalid" }
  const [prefix, ownerId, expRaw, nonce, portRaw] = parts as [string, string, string, string, string]
  if (prefix !== OWNER_LINK_PREFIX || !ownerId || !/^[0-9a-f]{32}$/i.test(nonce)) return { ok: false, reason: "invalid" }
  const exp = Number(expRaw)
  const port = Number(portRaw)
  if (!Number.isInteger(exp) || !Number.isInteger(port) || port < 0 || port > 65535) return { ok: false, reason: "invalid" }
  if (exp * 1000 < Date.now()) return { ok: false, reason: "expired" }
  return { ok: true, link: { ownerId, exp, nonce: nonce.toLowerCase(), port } }
}

/** Test and tooling helper; the engine mints its own links in Node. */
export async function mintOwnerLink(env: Env, options: { ownerId: string; port?: number; nonce?: string; exp?: number; ttlSeconds?: number }) {
  const nonce = options.nonce ?? [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")
  const exp = options.exp ?? Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? OWNER_LINK_TTL_SECONDS)
  const payload = `${OWNER_LINK_PREFIX}|${options.ownerId}|${exp}|${nonce}|${options.port ?? 0}`
  return { token: await sign(env.OWNER_LINK_SECRET!, payload), payload, nonce, exp }
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** Single use: D1's INSERT ... ON CONFLICT DO NOTHING tells exactly one redeemer that it won. */
export async function burnOwnerNonce(env: Env, nonce: string, exp: number): Promise<boolean> {
  await env.DB.prepare(`DELETE FROM owner_nonces WHERE exp < ?`).bind(nowSeconds()).run()
  const res = await env.DB.prepare(`INSERT INTO owner_nonces (nonce, exp) VALUES (?, ?) ON CONFLICT DO NOTHING`).bind(nonce, exp).run()
  return res.meta.changes === 1
}

/** The public handle the engine compares against its local OWNER_LINK_SECRET (drift detection). */
export async function ownerSecretHash(secret: string | undefined) {
  if (!secret) return null
  return (await sha256B64(`snip-owner-hash-v1|${secret}`)).slice(0, 16)
}

// ---------- Capture token and cross-site writes ----------

export const requireCaptureToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization") ?? ""
  const token = header.replace(/^Bearer\s+/i, "")
  if (!c.env.CAPTURE_TOKEN || !token || !timingSafeEqual(token, c.env.CAPTURE_TOKEN)) {
    return c.json({ error: "unauthorized" }, 401)
  }
  await next()
}

/**
 * Blocks cross-site writes. A local install signs in with DEV_LOGIN and needs no cookie, so any
 * website open in the browser could otherwise send a simple (no-preflight) POST to localhost.
 * Requiring JSON forces a CORS preflight, and a foreign Origin or Sec-Fetch-Site is refused.
 *
 * `allowNullOrigin` exists for the owner link: Chromium sends `Origin: null` for a form
 * submission from a document served with `Referrer-Policy: no-referrer`, which that page must
 * keep. There the token in the form body is the credential, and it is single use, so a request
 * without a usable origin is still authenticated.
 */
export function crossSiteWrite(req: Request, { json = true, allowNullOrigin = false } = {}): string | null {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null
  const origin = req.headers.get("origin")
  const opaque = allowNullOrigin && origin === "null"
  if (origin && !opaque && origin !== new URL(req.url).origin) return "cross-origin request refused"
  const site = req.headers.get("sec-fetch-site")
  if (site && site !== "same-origin" && site !== "none") return "cross-site request refused"
  if (json && req.headers.get("content-length") !== "0" && req.body !== null) {
    const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase()
    if (type !== "application/json") return "expected a JSON request body"
  }
  return null
}

// ---------- GitHub (the second-person path) ----------

/**
 * Mounted only when both halves exist (contracts §5.2). A client id without its secret cannot
 * complete a sign-in, and reporting GitHub as an available method in that state would send a
 * second person to a dead end.
 */
export const githubEnabled = (env: Env) => !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)

// The GitHub flow's `next` is imported from `web/shared/safe-next`, the same function the passkey
// page uses before it navigates, so there is one rule and no way for the two to drift apart.
export { safeNext }

export async function startLogin(c: Context<AppEnv>) {
  if (!githubEnabled(c.env)) return c.notFound()
  if (!allowedLogins(c.env).length) return c.text(NO_LOGINS, 503)
  const next = safeNext(c.req.query("next"))
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)))
  setCookie(c, STATE_COOKIE, await sign(c.env.SESSION_SECRET, `${state}|${next}`), {
    httpOnly: true,
    secure: !isLocalOrigin(c.req.url),
    sameSite: "Lax",
    path: "/auth",
    maxAge: 600,
  })
  const origin = new URL(c.req.url).origin
  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: `${origin}/auth/callback`,
    scope: "read:user",
    state,
    allow_signup: "false",
  })
  return c.redirect(`https://github.com/login/oauth/authorize?${params}`)
}

export async function finishLogin(c: Context<AppEnv>) {
  if (!githubEnabled(c.env)) return c.notFound()
  if (!allowedLogins(c.env).length) return c.text(NO_LOGINS, 503)
  const payload = await verify(c.env.SESSION_SECRET, getCookie(c, STATE_COOKIE))
  deleteCookie(c, STATE_COOKIE, { path: "/auth" })
  const [state, next] = (payload ?? "").split("|")
  const code = c.req.query("code")
  if (!state || state !== c.req.query("state") || !code) return c.text("Login expired. Please try again.", 400)

  const origin = new URL(c.req.url).origin
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${origin}/auth/callback`,
    }),
  })
  const token = (await tokenRes.json()) as { access_token?: string; error_description?: string }
  if (!token.access_token) return c.text(`GitHub login failed: ${token.error_description ?? "no token"}`, 400)

  const userRes = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token.access_token}`, "user-agent": "snip", accept: "application/vnd.github+json" },
  })
  const user = (await userRes.json()) as { login?: string }
  if (!user.login || !allowedLogins(c.env).includes(user.login.toLowerCase())) {
    return c.text(`GitHub user ${user.login ?? "unknown"} is not allowed to use this app.`, 403)
  }

  // A second person keeps their own identity but shares the install's revocation counter, so
  // "sign out everywhere" signs them out too.
  await setSessionCookie(c, { ownerId: user.login, label: user.login, method: "github", epoch: await currentEpoch(c.env.DB) })
  return c.redirect(safeNext(next))
}

export function logout(c: Context<AppEnv>) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" })
  return c.redirect("/")
}

// Signed, expiring file URLs so MCP clients can fetch screenshots without a cookie.

export async function signFileUrl(env: Env, origin: string, key: string, ttlSeconds = 60 * 60 * 24) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const sig = await hmac(env.SESSION_SECRET, `file|${key}|${exp}`)
  return `${origin}/files/${key}?exp=${exp}&sig=${sig}`
}

export async function verifyFileSig(env: Env, key: string, exp: string | undefined, sig: string | undefined) {
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) return false
  return timingSafeEqual(sig, await hmac(env.SESSION_SECRET, `file|${key}|${exp}`))
}
