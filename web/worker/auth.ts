import type { Context, MiddlewareHandler } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider"

// Web sessions: a GitHub OAuth login, stored as an HMAC-signed cookie.
// Only logins listed in ALLOWED_GITHUB_LOGINS may sign in.

export type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers; DEV_LOGIN?: string }
export type AppEnv = { Bindings: Bindings; Variables: { login: string } }

const SESSION_COOKIE = "rs_session"
const STATE_COOKIE = "rs_oauth_state"
const SESSION_DAYS = 30

const enc = new TextEncoder()

function b64url(buf: ArrayBuffer | Uint8Array) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
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

export function allowedLogins(env: Env) {
  return String(env.ALLOWED_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function isLocal(url: string) {
  const h = new URL(url).hostname
  return h === "localhost" || h === "127.0.0.1"
}

/** Returns the signed-in GitHub login, or null. */
export async function getSessionLogin(c: Context<AppEnv>): Promise<string | null> {
  const devLogin = c.env.DEV_LOGIN
  if (devLogin && isLocal(c.req.url)) return devLogin
  const payload = await verify(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE))
  if (!payload) return null
  const [login, exp] = payload.split("|")
  if (!login || Number(exp) < Date.now()) return null
  if (!allowedLogins(c.env).includes(login.toLowerCase())) return null
  return login
}

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const login = await getSessionLogin(c)
  if (!login) return c.json({ error: "unauthorized" }, 401)
  c.set("login", login)
  await next()
}

export const requireCaptureToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization") ?? ""
  const token = header.replace(/^Bearer\s+/i, "")
  if (!c.env.CAPTURE_TOKEN || !token || !timingSafeEqual(token, c.env.CAPTURE_TOKEN)) {
    return c.json({ error: "unauthorized" }, 401)
  }
  await next()
}

const safeNext = (next: string | undefined | null) => (next && next.startsWith("/") && !next.startsWith("//") ? next : "/")

export async function startLogin(c: Context<AppEnv>) {
  const next = safeNext(c.req.query("next"))
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)))
  setCookie(c, STATE_COOKIE, await sign(c.env.SESSION_SECRET, `${state}|${next}`), {
    httpOnly: true,
    secure: !isLocal(c.req.url),
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
    headers: { authorization: `Bearer ${token.access_token}`, "user-agent": "refshelf", accept: "application/vnd.github+json" },
  })
  const user = (await userRes.json()) as { login?: string }
  if (!user.login || !allowedLogins(c.env).includes(user.login.toLowerCase())) {
    return c.text(`GitHub user ${user.login ?? "unknown"} is not allowed to use this app.`, 403)
  }

  const exp = Date.now() + SESSION_DAYS * 86_400_000
  setCookie(c, SESSION_COOKIE, await sign(c.env.SESSION_SECRET, `${user.login}|${exp}`), {
    httpOnly: true,
    secure: !isLocal(c.req.url),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  })
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
