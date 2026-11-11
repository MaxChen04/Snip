import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The sign-in page as a client finds a passkeys-only install that has no passkey yet, reached the
// way `/authorize` sends one, so the copy that says how to get in is visible in the shot.
//   node --import tsx web/tests/screenshots/mcp-sign-in-empty.mjs

const BASE = process.env.BASE ?? "http://localhost:5199"
const OUT = process.env.OUT ?? join(tmpdir(), "snip-screenshots/worker")

mkdirSync(OUT, { recursive: true })
console.log(`Screenshots: ${OUT}`)

const clientId = async () => {
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
  if (!res.ok) throw new Error(`register failed: ${res.status}`)
  return (await res.json()).client_id
}

const authorizeUrl = (id) =>
  `${BASE}/authorize?${new URLSearchParams({
    client_id: id,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    response_type: "code",
    state: "xyz123",
    code_challenge: "E9Melhoa2OwvFrEMTJgu_CH0DiT98WKiTsBf8J4n0m0",
    code_challenge_method: "S256",
    scope: "references",
  })}`

const browser = await chromium.launch()
const id = await clientId()

for (const scheme of ["light", "dark"]) {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1100, height: 820 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
    })
    const page = await context.newPage()
    await page.goto(authorizeUrl(id))
    await page.waitForURL((url) => url.pathname === "/sign-in", { timeout: 15_000 })
    await page.waitForSelector("text=This library has no passkey yet", { timeout: 15_000 })
    await page.waitForTimeout(500)
    const name = `mcp-sign-in-no-passkey${mobile ? "-mobile" : ""}-${scheme}`
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: mobile })
    console.log(`${name}.png  ← ${page.url()}`)
    await context.close()
  }
}

await browser.close()
