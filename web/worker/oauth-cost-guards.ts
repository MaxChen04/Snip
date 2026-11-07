// These guards run before the OAuth provider can read/write KV or contact GitHub.
// Native counters are approximate and local to each Cloudflare location, not a spend cap.
export type OAuthCostGuardBindings = Partial<Record<
  "OAUTH_REGISTER_LIMITER" | "OAUTH_TOKEN_LIMITER" | "OAUTH_LOGIN_LIMITER" | "OAUTH_AUTHORIZE_LIMITER",
  RateLimit
>>

const RETRY_AFTER_SECONDS = "60" // All configured windows are at most 60 seconds.

export async function guardOAuthRequest(request: Request, env: OAuthCostGuardBindings): Promise<Response | undefined> {
  if (request.method === "OPTIONS") return // Preserve OAuth/MCP CORS preflights.
  const url = new URL(request.url)
  let limiter: RateLimit | undefined
  switch (url.pathname) {
    case "/register": limiter = env.OAUTH_REGISTER_LIMITER; break
    case "/token": limiter = env.OAUTH_TOKEN_LIMITER; break
    case "/auth/login":
    case "/auth/callback":
    // Passkey sign-in and the owner link are unauthenticated and write to D1 (challenges, nonces),
    // so anonymous traffic could otherwise spend the free plan's daily D1 writes.
    case "/auth/passkey/login/options":
    case "/auth/passkey/login/verify":
    case "/auth/owner": limiter = env.OAUTH_LOGIN_LIMITER; break
    case "/authorize": limiter = env.OAUTH_AUTHORIZE_LIMITER; break
    default: return
  }

  // Existing desktop/local configs have no rate-limit bindings.
  // On hosted requests, a missing binding fails closed until the deploy config is upgraded.
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return
  if (!limiter) return unavailable(request, url.pathname)

  // Before login there is no trusted user id. Cloudflare sets this header at the edge;
  // client-supplied ids, query strings and X-Forwarded-For must not create new buckets.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown"
  try {
    const { success } = await limiter.limit({ key: `${url.pathname}:${ip}` })
    if (success) return
  } catch {
    return unavailable(request, url.pathname)
  }
  return errorResponse(request, url.pathname, 429, "temporarily_unavailable", "Too many sign-in requests. Wait a minute, then try again.")
}

function unavailable(request: Request, path: string) {
  return errorResponse(request, path, 503, "temporarily_unavailable", "Sign-in protection is unavailable. Please try again in a minute.")
}

function errorResponse(request: Request, path: string, status: number, error: string, description: string) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "retry-after": RETRY_AFTER_SECONDS,
  })
  // These endpoints support browser OAuth clients. Let them read the backoff response
  // just as they can read the provider's normal responses, without ambient credentials.
  if (path === "/register" || path === "/token") {
    const origin = request.headers.get("origin")
    if (origin) {
      headers.set("access-control-allow-origin", origin)
      headers.set("access-control-expose-headers", "Retry-After")
      headers.set("vary", "Origin")
    }
  }
  return new Response(JSON.stringify({ error, error_description: description }), { status, headers })
}
