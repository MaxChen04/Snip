import type { Context } from "hono"
import {
  type AppEnv,
  burnOwnerNonce,
  crossSiteWrite,
  currentEpoch,
  ensureOwner,
  ownerSecretHash,
  sessionToken,
  setSessionTokenCookie,
  verifyOwnerLink,
} from "./auth"

/** The loopback address the engine listens on; the token rides the fragment, never the path. */
export const connector = (port: number, token: string) => `http://127.0.0.1:${port}/done#token=${encodeURIComponent(token)}`

// The owner link is the app's own way in: the engine mints it after a deploy, the browser opens
// it, and it does two jobs — it signs this browser in (for passkey registration and reading) and
// hands a session back to the desktop app over a loopback so the app never needs WebAuthn.
//
// GET validates and renders a form; it burns nothing and sets no cookie, because a GET that
// grants a 30-day session is exactly the shape that leaks through history, referrers and link
// scanners. POST is the one that burns the D1 nonce.

const AUTO_SUBMIT = "document.getElementById('snip-owner').submit()"

// CSP hashes are standard base64; base64url's - and _ are not valid in a source expression.
let submitHash: Promise<string> | undefined
const autoSubmitHash = () =>
  (submitHash ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(AUTO_SUBMIT)).then((digest) => {
    let s = ""
    for (const b of new Uint8Array(digest)) s += String.fromCharCode(b)
    return btoa(s)
  }))

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!)

/** No store, no referrer, and no script except the one that submits the form. */
async function linkHeaders(extra: Record<string, string> = {}) {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'sha256-${await autoSubmitHash()}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    ...extra,
  })
}

function page(token: string, note: string) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to Snip</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:#fcfcfc;color:#1a1a1a;
       font:15px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}
  main{width:100%;max-width:380px;background:#fff;border:1px solid #00000014;border-radius:16px;
       padding:28px;box-shadow:0 10px 30px -12px #0000001f}
  .mark{display:flex;align-items:center;gap:9px;margin-bottom:18px}
  .mark img{width:30px;height:30px;object-fit:contain}
  .mark strong{font-size:15px;letter-spacing:-0.025em}
  h1{font-size:17px;line-height:1.3;margin:0 0 6px;letter-spacing:-0.01em;font-weight:600}
  p{font-size:13.5px;color:#666;margin:0 0 20px}
  button{width:100%;height:38px;border-radius:9px;border:0;background:#1a1a1a;color:#fff;
       font:inherit;font-size:13.5px;font-weight:500;cursor:pointer}
  button:hover{background:#000}
  .hint{font-size:12px;color:#8a8a8a;margin:14px 0 0;text-align:center}
  @media (prefers-color-scheme:dark){
    body{background:#0d0d0d;color:#ededed}
    main{background:#171717;border-color:#ffffff1a;box-shadow:0 10px 30px -12px #000}
    p{color:#9a9a9a}.hint{color:#777}
    button{background:#ededed;color:#111}button:hover{background:#fff}
  }
</style></head>
<body><main>
  <div class="mark"><img src="/logo.png" alt=""><strong>Snip</strong></div>
  <h1>Sign in to your library</h1>
  <p>${escapeHtml(note)}</p>
  <form id="snip-owner" method="post" action="/auth/owner">
    <input type="hidden" name="t" value="${escapeHtml(token)}">
    <button type="submit">Continue</button>
  </form>
  <p class="hint">This link works once and expires after 10 minutes.</p>
</main>
<script>${AUTO_SUBMIT}</script>
</body></html>`
}

export async function ownerLinkPage(c: Context<AppEnv>) {
  const check = await verifyOwnerLink(c.env, c.req.query("t"))
  if (!check.ok) {
    const expired = check.reason === "expired"
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Snip</title>
<style>body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:#fcfcfc;color:#1a1a1a;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}
main{max-width:380px;width:100%;background:#fff;border:1px solid #00000014;border-radius:16px;padding:28px}
h1{font-size:17px;margin:0 0 6px}p{font-size:13.5px;color:#666;margin:0}</style></head>
<body><main><h1>${expired ? "This link has expired" : "This link is not valid"}</h1>
<p>${expired ? "Owner links work for 10 minutes. Run" : "Ask Snip to mint a new owner link. Run"} <code>npm run setup:cloudflare -- owner link</code> to get a fresh one.</p></main></body></html>`
    return new Response(html, { status: expired ? 410 : 400, headers: await linkHeaders() })
  }
  return new Response(page(c.req.query("t")!, "Continue to sign this browser in to your Snip library."), {
    status: 200,
    headers: await linkHeaders(),
  })
}

export async function ownerLinkSubmit(c: Context<AppEnv>) {
  // The landing page must keep `Referrer-Policy: no-referrer`, and Chromium then reports the form
  // POST with `Origin: null`. The token itself is the credential here, so that is accepted.
  const refused = crossSiteWrite(c.req.raw, { json: false, allowNullOrigin: true })
  if (refused) return c.text(refused, 403)
  const form = await c.req.formData().catch(() => null)
  const submitted = form ? String(form.get("t") ?? "") : ""
  const check = await verifyOwnerLink(c.env, submitted)
  if (!check.ok) {
    return new Response(check.reason === "expired" ? "This link has expired." : "This link is not valid.", {
      status: check.reason === "expired" ? 410 : 400,
      headers: await linkHeaders({ "content-type": "text/plain; charset=utf-8" }),
    })
  }
  const { link } = check
  if (!(await burnOwnerNonce(c.env, link.nonce, link.exp))) {
    return new Response("This link has already been used. Run `npm run setup:cloudflare -- owner link` for a new one.", {
      status: 409,
      headers: await linkHeaders({ "content-type": "text/plain; charset=utf-8" }),
    })
  }

  const hash = await ownerSecretHash(c.env.OWNER_LINK_SECRET)
  await ensureOwner(c.env, link.ownerId, link.ownerId, hash)
  const session = { ownerId: link.ownerId, label: link.ownerId, method: "owner" as const, epoch: await currentEpoch(c.env.DB) }
  // One token, used for the cookie and the handoff, so the app and the browser hold the same one.
  const token = await sessionToken(c.env, session)
  setSessionTokenCookie(c, token)

  // The desktop app listens on a loopback port. The session travels in the fragment so it never
  // reaches a server log; the browser page is what Electron cannot see into, which is why the app
  // gets the value itself rather than reading Safari's cookie jar.
  // A browser link has no listener to hand off to; the passkeys page offers this browser a passkey.
  const location = link.port > 0 ? connector(link.port, token) : "/passkeys?new=1"
  // c.newResponse keeps the Set-Cookie set above; a bare Response would drop it.
  const headers = Object.fromEntries((await linkHeaders({ "content-type": "text/plain; charset=utf-8", location })).entries())
  return c.newResponse(null, 302, headers)
}
