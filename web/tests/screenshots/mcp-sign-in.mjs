import { chromium } from "playwright"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { sign } from "../../worker/auth.ts"

const base64url = (bytes) => Buffer.from(bytes).toString("base64url")

// The passkeys-only MCP journey, in a real browser with a virtual authenticator:
//   /authorize (anonymous) → /sign-in?next=… → passkey → back to /authorize consent.
// Needs the dev server on :5199 with web/.dev.vars and NO DEV_LOGIN, so the detour is real:
//   node --import tsx web/tests/screenshots/mcp-sign-in.mjs

const BASE = process.env.BASE ?? "http://localhost:5199"
const OUT = process.env.OUT ?? "/Users/Maxsc/.factory/worktrees/98cfc78f/screenshots/worker"
const OWNER_LINK_SECRET = process.env.OWNER_LINK_SECRET ?? "dev-owner-link-secret"

mkdirSync(OUT, { recursive: true })

async function ownerLink({ port = 0, ownerId = "max" } = {}) {
  const exp = Math.floor(Date.now() / 1000) + 600
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")
  const payload = `snip-owner-v1|${ownerId}|${exp}|${nonce}|${port}`
  return `${payload}.${(await sign(OWNER_LINK_SECRET, payload)).split(".")[1]}`
}

/** A client registered the way an MCP client registers itself. */
async function registerClient() {
  const res = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  })
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`)
  return (await res.json()).client_id
}

/** A PKCE pair the client would generate, so the code can actually be redeemed. */
const pkce = () => {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64url(new Uint8Array(createHash("sha256").update(verifier).digest()))
  return { verifier, challenge }
}

const authorizeUrl = (clientId, challenge) =>
  `${BASE}/authorize?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    response_type: "code",
    state: "xyz123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "references",
  })}`

async function shoot(page, name, { fullPage = false, wait = 400 } = {}) {
  await page.waitForTimeout(wait)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage })
  console.log(`${name}.png`)
}

async function main() {
  const clientId = await registerClient()
  const browser = await chromium.launch()
  const only = process.env.ONLY?.split(",").map((s) => s.trim()).filter(Boolean)
  const want = (name) => !only || only.includes(name)
  const report = {}

  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 2, colorScheme: scheme })
    const page = await context.newPage()

    // A software authenticator stands in for Touch ID. It survives the whole loop, so the passkey
    // registered now is the one that signs in below.
    const cdp = await context.newCDPSession(page)
    await cdp.send("WebAuthn.enable")
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    })

    // Enrol this device through the real owner link, as the setup flow does.
    await page.goto(`${BASE}/auth/owner?t=${encodeURIComponent(await ownerLink())}`)
    await page.waitForURL((url) => !url.pathname.startsWith("/auth/owner"), { timeout: 15_000 })
    await page.goto(`${BASE}/passkeys`)
    await page.waitForSelector("text=Your devices")
    const add = page.getByRole("button", { name: /Add (this device|passkey)/ }).first()
    await add.click()
    const enrolled = await page
      .waitForFunction(() => /MacBook|this device|passkey/i.test(document.body.innerText) && !/Waiting…/.test(document.body.innerText), null, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false)
    report[`enrolled-${scheme}`] = enrolled

    // Signed out, exactly as a client finds the install.
    await context.clearCookies()
    const challenge = pkce()

    // One navigation: /authorize must hand the client to the passkey page and the page must come back.
    await page.goto(authorizeUrl(clientId, challenge.challenge))
    await page.waitForURL((url) => url.pathname === "/sign-in", { timeout: 15_000 })
    report[`next-${scheme}`] = new URL(page.url()).searchParams.get("next")

    await page.waitForFunction(() => !!document.querySelector("[data-slot=button]"), null, { timeout: 15_000 }).catch(() => {})
    if (want("mcp-sign-in")) await shoot(page, `mcp-authorize-sign-in-${scheme}`, { wait: 900 })

    await page.getByRole("button", { name: /Sign in with a passkey/ }).click()
    await page.waitForURL((url) => url.pathname === "/authorize", { timeout: 25_000 })
    await page.waitForSelector("text=Allow Claude to use Snip?")
    report[`consent-${scheme}`] = page.url()
    if (want("mcp-consent")) await shoot(page, `mcp-authorize-consent-${scheme}`)

    // Approve, and the client gets its code for the owner identity. claude.ai cannot load here, so
    // the redirect itself is the assertion: origin, path, and an authorization code.
    const redirected = page.waitForRequest((req) => req.url().startsWith("https://claude.ai/api/mcp/auth_callback"), { timeout: 25_000 })
    await page.getByRole("button", { name: "Allow", exact: true }).click()
    const callback = new URL((await redirected).url())
    report[`code-${scheme}`] = {
      host: callback.host,
      state: callback.searchParams.get("state"),
      codeLength: (callback.searchParams.get("code") ?? "").length,
    }

    // The proof that the detour produced a usable grant: redeem the code, then call the tool.
    const code = callback.searchParams.get("code")
    const token = await fetch(`${BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_verifier: challenge.verifier,
      }),
    })
    const grant = await token.json()
    report[`token-${scheme}`] = { status: token.status, scope: grant.scope, hasToken: !!grant.access_token, error: grant.error }

    const rpc = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${grant.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
    const body = await rpc.text()
    report[`mcp-${scheme}`] = {
      status: rpc.status,
      tools: [...body.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]),
    }

    // Narrow viewport, arrived the same way.
    if (want("mcp-sign-in-mobile")) {
      await context.clearCookies()
      await page.setViewportSize({ width: 390, height: 844 })
      const mobile = pkce()
      await page.goto(authorizeUrl(clientId, mobile.challenge))
      await page.waitForURL((url) => url.pathname === "/sign-in", { timeout: 15_000 })
      await page.waitForFunction(() => !!document.querySelector("[data-slot=button]"), null, { timeout: 15_000 }).catch(() => {})
      await shoot(page, `mcp-authorize-sign-in-mobile-${scheme}`, { wait: 900, fullPage: true })
    }

    await context.close()
  }

  await browser.close()
  console.log(JSON.stringify(report, null, 2))
}

await main()
