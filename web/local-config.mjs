import fs from 'node:fs'
import path from 'node:path'

/** Local commands share this choice; hosted builds always pass their config explicitly. */
export function localConfigPath(web) {
  const local = path.join(web, 'wrangler.local.jsonc')
  return fs.existsSync(local) ? local : path.join(web, 'wrangler.jsonc')
}
