import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { localConfigPath } from '../web/local-config.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const web = path.join(root, 'web')
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'),
  'd1', 'migrations', 'apply', 'DB', '--local', '--config', localConfigPath(web),
  '--persist-to', path.join(web, '.wrangler/state')], { cwd: web, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
