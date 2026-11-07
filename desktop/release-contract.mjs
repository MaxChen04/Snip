import fs from 'node:fs'
import path from 'node:path'

export const REPOSITORY = 'MaxChen04/Snip'
export const APP_FILES = Object.freeze(['package.json', 'main.cjs', 'local-server.cjs', 'runtime-layout.cjs', 'updates.cjs', 'source-updates.cjs', 'node-runtime.cjs', 'rotating-log.cjs', 'service.cjs', 'preload.cjs', 'preload-settings.cjs', 'loading.html', 'cloud-unreachable.html', 'cloud-state.cjs', 'cloud-engine.cjs', 'cloud-session.cjs', 'cloud-confirm.cjs', 'window-origin.cjs', 'settings-assets.cjs'])
export const stableVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.split('.').every(n => Number.isSafeInteger(Number(n)))
export function releaseCredentials(env) {
  const { SNIP_SIGN_IDENTITY: identity, APPLE_ID: appleId, APPLE_APP_SPECIFIC_PASSWORD: appleIdPassword, APPLE_TEAM_ID: teamId, APPLE_NOTARY_KEYCHAIN_PROFILE: keychainProfile } = env
  if (!identity?.startsWith('Developer ID Application:') || !(keychainProfile || (appleId && appleIdPassword && teamId))) throw new Error('Release requires a Developer ID Application identity and notarization credentials (APPLE_NOTARY_KEYCHAIN_PROFILE or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID).')
  return { identity, notarize: keychainProfile ? { keychainProfile } : { appleId, appleIdPassword, teamId } }
}
export function subprocessEnvironment(env) {
  // Build tools only need a small operational environment, never the signing credentials or GitHub token.
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'CI', 'LANG', 'LC_ALL', 'SYSTEMROOT'].filter(key => env[key] !== undefined).map(key => [key, env[key]]))
}
export async function requirePublicRepository(fetcher = fetch) {
  let response
  try { response = await fetcher(`https://api.github.com/repos/${REPOSITORY}`, { headers: { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15000), redirect: 'error' }) }
  catch { throw new Error('Cannot verify that MaxChen04/Snip is public; signed release is blocked because the updater requires a public GitHub repository.') }
  if (!response.ok) throw new Error('MaxChen04/Snip is not publicly accessible or GitHub could not verify it; signed release is blocked because the updater requires a public GitHub repository.')
  const data = await response.json()
  if (data.private !== false || data.full_name?.toLowerCase() !== REPOSITORY.toLowerCase()) throw new Error('Signed release requires the MaxChen04/Snip GitHub repository to be public for the unauthenticated updater.')
}
const inside = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)) }
export function repairAndValidateRuntime(stage, destination) {
  const links = []
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name)
    if (['.env', '.dev.vars', '.wrangler', 'repo.json'].includes(entry.name)) throw new Error(`Forbidden runtime entry: ${name}`)
    if (entry.isDirectory()) walk(name)
    else if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(name)
      if (path.isAbsolute(link)) {
        if (!inside(stage, link)) throw new Error(`External symbolic link in runtime: ${name}`)
        fs.unlinkSync(name)
        fs.symlinkSync(path.relative(dir, path.join(destination, path.relative(stage, link))), name)
      }
      links.push(name)
    }
  } }
  walk(destination)
  for (const link of links) {
    let target
    try { target = fs.realpathSync(link) } catch { throw new Error(`Broken runtime symlink: ${link}`) }
    if (!inside(fs.realpathSync(destination), target)) throw new Error(`External symbolic link in runtime: ${link}`)
  }
}
