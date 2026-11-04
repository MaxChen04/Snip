// Build an isolated Apple Silicon app. --release is signed/notarized; --standalone is for local smoke tests only.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'
import { APP_FILES, REPOSITORY, stableVersion, releaseCredentials, subprocessEnvironment, requirePublicRepository, repairAndValidateRuntime } from './release-contract.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const args = process.argv.slice(2)
const release = args.includes('--release')
const standalone = args.includes('--standalone')
if (release === standalone || args.some(arg => !['--release', '--standalone'].includes(arg))) throw new Error('Choose exactly one of --release or --standalone.')
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build requires native Apple Silicon macOS.')
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'package.json')))
if (!stableVersion(manifest.version)) throw new Error('Desktop version must be a stable X.Y.Z version.')
const signing = release ? releaseCredentials(process.env) : null
if (release) await requirePublicRepository()
const nodeDistribution = process.env.SNIP_NODE_DISTRIBUTION
if (!nodeDistribution || !path.isAbsolute(nodeDistribution)) throw new Error('Set SNIP_NODE_DISTRIBUTION to an official Node.js 24 macOS arm64 distribution directory containing bin/node and LICENSE.')
const node = path.join(nodeDistribution, 'bin/node')
const license = path.join(nodeDistribution, 'LICENSE')
if (!fs.existsSync(node) || !fs.existsSync(license)) throw new Error('Node distribution must contain bin/node and LICENSE.')
const run = (command, argv, options = {}) => execFileSync(command, argv, { stdio: 'inherit', ...options })
const buildEnv = { ...subprocessEnvironment(process.env), CLOUDFLARE_CF_FETCH_ENABLED: 'false' }
const capture = (command, argv) => execFileSync(command, argv, { encoding: 'utf8' }).trim()
if (capture(node, ['-p', 'process.platform + ":" + process.arch + ":" + process.versions.node.split(".")[0]']) !== 'darwin:arm64:24') throw new Error('Node distribution must be macOS arm64 Node 24.')
const minimumOS = capture('otool', ['-l', node]).match(/\bminos\s+(\d+)\.(\d+)/)
if (!minimumOS || Number(minimumOS[1]) > 14 || (Number(minimumOS[1]) === 14 && Number(minimumOS[2]) > 0)) throw new Error('Node distribution must support macOS 14.0.')
const libraries = capture('otool', ['-L', node]).split('\n').slice(1).map(line => line.trim().split(' ')[0])
if (libraries.some(lib => !lib.startsWith('/usr/lib/') && !lib.startsWith('/System/Library/'))) throw new Error('Node binary has non-system dynamic library dependencies and is not portable.')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'snip-release-'))
const stage = path.join(work, 'runtime')
const app = path.join(work, 'app')
const out = path.join(here, 'dist')
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true }) }
try {
  fs.mkdirSync(stage)
  for (const file of ['package.json', 'package-lock.json', 'web/package.json', 'capture/package.json', 'web/wrangler.jsonc', 'web/index.html', 'web/vite.config.ts', 'web/tsconfig.json', 'web/tsconfig.app.json', 'web/tsconfig.worker.json', 'web/components.json']) copy(path.join(root, file), path.join(stage, file))
  for (const dir of ['web/src', 'web/shared', 'web/worker', 'web/public', 'web/migrations', 'capture/src']) copy(path.join(root, dir), path.join(stage, dir))
  // Install only from the lockfile into fresh staging; never copy checkout dependencies.
  run('npm', ['ci'], { cwd: stage, env: { ...buildEnv, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } })
  run('npm', ['run', 'build', '-w', 'web'], { cwd: stage, env: { ...buildEnv, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' } })
  const browsers = path.join(stage, 'browsers')
  // For an offline local smoke test only, a preinstalled Playwright cache may seed the browser.
  if (!release && process.env.SNIP_SMOKE_BROWSER_CACHE) copy(process.env.SNIP_SMOKE_BROWSER_CACHE, browsers)
  run('node', [path.join(stage, 'node_modules/playwright/cli.js'), 'install', '--only-shell', 'chromium'], { cwd: stage, env: { ...buildEnv, PLAYWRIGHT_BROWSERS_PATH: browsers } })
  // Installer bookkeeping contains staging paths and is unnecessary at runtime.
  fs.rmSync(path.join(browsers, '.links'), { recursive: true, force: true })
  const generatedConfig = path.join(stage, 'web/dist/snip/wrangler.json')
  const config = JSON.parse(fs.readFileSync(generatedConfig, 'utf8'))
  delete config.configPath
  delete config.userConfigPath
  fs.writeFileSync(generatedConfig, JSON.stringify(config))
  fs.rmSync(path.join(stage, 'web/.wrangler'), { recursive: true, force: true })
  for (const dir of ['web/src', 'web/shared', 'web/worker']) fs.rmSync(path.join(stage, dir), { recursive: true, force: true })
  fs.mkdirSync(path.join(stage, 'node/bin'), { recursive: true })
  copy(node, path.join(stage, 'node/bin/node'))
  copy(license, path.join(stage, 'node/LICENSE'))
  fs.mkdirSync(app)
  for (const file of APP_FILES) copy(path.join(here, file), path.join(app, file))
  fs.writeFileSync(path.join(app, 'release.json'), JSON.stringify({ channel: 'stable', repository: REPOSITORY, updatesEnabled: release }) + '\n')
  const icon = path.join(here, 'assets/Snip.icns')
  const electronVersion = JSON.parse(fs.readFileSync(path.join(here, 'node_modules/electron/package.json'))).version
  const [result] = await packager({ dir: app, name: 'Snip', platform: 'darwin', arch: 'arm64', electronVersion, asar: false, out, overwrite: true, icon, appBundleId: 'dev.snip.desktop', appCategoryType: 'public.app-category.developer-tools', extendInfo: { LSMinimumSystemVersion: '14.0' }, extraResource: stage, prune: false,
    // Packager's copy resolves symlinks to staging paths. Rewrite them before signing.
    afterCopyExtraResources: [({ buildPath }) => repairAndValidateRuntime(stage, path.join(buildPath, 'Snip.app/Contents/Resources/runtime'))],
    ...(!release && process.env.SNIP_SMOKE_ELECTRON_ZIP_DIR ? { electronZipDir: process.env.SNIP_SMOKE_ELECTRON_ZIP_DIR } : {}),
    ...(release ? { osxSign: { identity: signing.identity, hardenedRuntime: true }, osxNotarize: signing.notarize } : {}) })
  const built = path.join(result, 'Snip.app')
  if (!release) run('codesign', ['--force', '--deep', '--sign', '-', built])
  run('codesign', ['--verify', '--deep', '--strict', built])
  if (release) {
    run('xcrun', ['stapler', 'validate', built])
    const archive = path.join(out, `Snip-${manifest.version}-darwin-arm64.zip`)
    fs.rmSync(archive, { force: true })
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', built, archive])
    console.log(`Signed and notarized release: ${archive}`)
  } else console.log(`Standalone smoke-test app: ${built} (updates disabled; do not publish)`)
} finally { fs.rmSync(work, { recursive: true, force: true }) }
