// Serves the public site's static build (dist-site/) on usesnip.dev.
// www.usesnip.dev and any other host redirect to the apex so there is one
// canonical origin; every response gets basic security headers.
interface Env {
  ASSETS: Fetcher
}

const CANONICAL_HOST = "usesnip.dev"

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.hostname === `www.${CANONICAL_HOST}`) {
      url.hostname = CANONICAL_HOST
      return Response.redirect(url.toString(), 301)
    }
    const res = await env.ASSETS.fetch(request)
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v)
    // Hashed build assets never change; everything else revalidates.
    if (url.pathname.startsWith("/assets/")) out.headers.set("Cache-Control", "public, max-age=31536000, immutable")
    return out
  },
}
