// Renders every Settings state in a real browser for design review and the PR.
// Dev tool only: it talks to `npm run dev:settings`, never to Electron or Cloudflare.
// Usage: node desktop/scripts/settings-shots.mjs [outDir]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { chromium } from "playwright"

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "snip-screenshots/desktop"))
const origin = process.env.SNIP_SETTINGS_ORIGIN ?? "http://127.0.0.1:5174"
const url = query => `${origin}/settings.html?${query}`

const shots = [
  { name: "local", query: "fake=local" },
  { name: "local-empty", query: "fake=local-empty" },
  { name: "confirm", query: "fake=local&dialog=enable" },
  { name: "confirm-empty", query: "fake=local-empty&dialog=enable" },
  { name: "progress-auth", query: "fake=enabling&step=1" },
  { name: "progress-r2", query: "fake=enabling&step=4" },
  { name: "progress-guard", query: "fake=enabling&step=5" },
  { name: "progress-import", query: "fake=enabling&step=14" },
  { name: "progress-owner", query: "fake=enabling&step=16" },
  { name: "progress-copy-back", query: "fake=pulling&step=4" },
  { name: "error", query: "fake=enabling-error&step=14" },
  { name: "cloud", query: "fake=cloud" },
  { name: "cloud-empty", query: "fake=cloud-empty" },
  { name: "cloud-adopted", query: "fake=cloud-adopted" },
  { name: "cloud-backup", query: "fake=cloud-backup" },
  { name: "choice-existing", query: "fake=choice" },
  { name: "undo-setup", query: "fake=enabling-error&step=14&dialog=abort" },
  { name: "detached", query: "fake=detached" },
  { name: "turn-off", query: "fake=cloud&dialog=turn-off" },
  { name: "sign-out", query: "fake=cloud&dialog=sign-out" },
  { name: "owner-link", query: "fake=link&dialog=owner-link" },
  { name: "owner-link-error", query: "fake=link-error&dialog=owner-link" },
  { name: "delete-resources", query: "fake=cloud&dialog=delete" },
  { name: "delete-snapshot", query: "fake=cloud-backup&dialog=snapshot-delete" },
  { name: "delete-export", query: "fake=cloud&dialog=export-delete" },
]

fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 760, height: 760 }, deviceScaleFactor: 2, colorScheme: theme })
    const page = await context.newPage()
    for (const shot of shots) {
      await page.goto(url(shot.query), { waitUntil: "networkidle" })
      await page.locator("#root").waitFor()
      // Let the fixture seed its first events and any enter transition settle. The
      // link sheet mints after the window opens, so give that one its beat.
      await page.waitForTimeout(450)
      const file = path.join(out, `settings-${shot.name}-${theme}.png`)
      await page.screenshot({ path: file })
      console.log(file)
    }
    await context.close()
  }
} finally {
  await browser.close()
}
