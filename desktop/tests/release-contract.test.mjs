import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { APP_FILES, stableVersion, releaseCredentials, subprocessEnvironment, requirePublicRepository, repairAndValidateRuntime } from '../release-contract.mjs'

test('stable release versions and credentials are required', () => {
  for (const value of ['0.1.0', '1.20.300']) assert.equal(stableVersion(value), true)
  for (const value of ['v1.2.3', '1.2', '1.2.3-beta', '01.2.3', '9007199254740992.0.0', '1.2.3\n']) assert.equal(stableVersion(value), false)
  assert.throws(() => releaseCredentials({}), /Developer ID/)
  assert.throws(() => releaseCredentials({ SNIP_SIGN_IDENTITY: 'Apple Development: Test', APPLE_NOTARY_KEYCHAIN_PROFILE: 'profile' }), /Developer ID/)
  assert.deepEqual(releaseCredentials({ SNIP_SIGN_IDENTITY: 'Developer ID Application: Example', APPLE_NOTARY_KEYCHAIN_PROFILE: 'profile' }).notarize, { keychainProfile: 'profile' })
})

test('build environment and launcher allowlist exclude secrets and checkout pointer', () => {
  assert.deepEqual(subprocessEnvironment({ PATH: '/bin', HOME: '/tmp', APPLE_APP_SPECIFIC_PASSWORD: 'secret', GH_TOKEN: 'secret', MACOS_CERTIFICATE_BASE64: 'secret' }), { PATH: '/bin', HOME: '/tmp' })
  assert.equal(APP_FILES.includes('repo.json'), false)
  assert.equal(APP_FILES.includes('release.json'), false) // generated, never copied
  assert.equal(APP_FILES.includes('updates.cjs'), true)
})

test('the release bundle includes every local module the launcher requires', () => {
  const desktop = path.join(path.dirname(new URL(import.meta.url).pathname), '..')
  for (const file of ['main.cjs', ...APP_FILES.filter(name => name.endsWith('.cjs'))]) {
    const source = fs.readFileSync(path.join(desktop, file), 'utf8')
    for (const [, local] of source.matchAll(/require\(["']\.\/([\w.-]+)["']\)/g)) assert.ok(APP_FILES.includes(local), `${file} requires ${local}, which APP_FILES omits`)
  }
})

test('the provisioning engine ships in the release bundle, and nothing under provision names a forbidden runtime entry', () => {
  const desktop = path.join(path.dirname(new URL(import.meta.url).pathname), '..')
  assert.ok(APP_FILES.includes('provision'), 'the engine directory must be copied into the app')
  const engine = path.join(desktop, 'provision')
  const files = fs.readdirSync(engine).filter((name) => name.endsWith('.cjs'))
  assert.ok(files.includes('cli.cjs'), 'the CLI entry point must ship')
  assert.ok(files.includes('engine.cjs'))
  // The engine writes deploy state under the library, never inside the signed runtime.
  for (const file of files) {
    const source = fs.readFileSync(path.join(engine, file), 'utf8')
    for (const forbidden of ['.dev.vars', '.wrangler/config']) {
      assert.equal(source.includes(`writeFileSync(path.join(root, '${forbidden}')`), false, `${file} must not write ${forbidden} into the runtime`)
    }
  }
})

test('release requires unauthenticated public access to the expected repository', async () => {
  await requirePublicRepository(async () => ({ ok: true, json: async () => ({ private: false, full_name: 'MaxChen04/Snip' }) }))
  await assert.rejects(requirePublicRepository(async () => ({ ok: false, status: 404 })), /public/)
  await assert.rejects(requirePublicRepository(async () => ({ ok: true, json: async () => ({ private: true, full_name: 'MaxChen04/Snip' }) })), /public/)
  await assert.rejects(requirePublicRepository(async () => { throw new Error('offline') }), /Cannot verify/)
})

test('runtime repairs staging links and rejects forbidden files and escaping links', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snip-release-test-'))
  try {
    const stage = path.join(tmp, 'stage'), dest = path.join(tmp, 'bundle')
    fs.mkdirSync(stage); fs.mkdirSync(dest)
    fs.writeFileSync(path.join(dest, 'target'), 'ok')
    fs.symlinkSync(path.join(stage, 'target'), path.join(dest, 'internal'))
    repairAndValidateRuntime(stage, dest)
    assert.equal(fs.readlinkSync(path.join(dest, 'internal')), 'target')
    fs.symlinkSync('../outside', path.join(dest, 'escape'))
    fs.writeFileSync(path.join(tmp, 'outside'), 'private')
    assert.throws(() => repairAndValidateRuntime(stage, dest), /External symbolic link/)
    fs.unlinkSync(path.join(dest, 'escape'))
    fs.symlinkSync('../outside', path.join(dest, 'indirect'))
    fs.symlinkSync('indirect', path.join(dest, 'chain'))
    assert.throws(() => repairAndValidateRuntime(stage, dest), /External symbolic link/)
    fs.unlinkSync(path.join(dest, 'chain'))
    fs.unlinkSync(path.join(dest, 'indirect'))
    for (const name of ['.env', '.dev.vars', '.wrangler', 'repo.json']) {
      fs.writeFileSync(path.join(dest, name), 'private')
      assert.throws(() => repairAndValidateRuntime(stage, dest), /Forbidden runtime entry/)
      fs.unlinkSync(path.join(dest, name))
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
