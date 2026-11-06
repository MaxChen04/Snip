import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { parseCreatedId, publicUrlFrom, readValues, renderDeployConfig, TRACKED_CONFIG } from "../../scripts/cloudflare.mjs"

const tracked = fs.readFileSync(TRACKED_CONFIG, "utf8")

test("the tracked config ships placeholders only", () => {
  assert.deepEqual(readValues(tracked), { d1: null, kv: null, login: null, url: null })
})

test("the deploy config fills in this install's values and keeps the rest", () => {
  const values = { d1: "0f0e0d0c-0b0a-0908-0706-050403020100", kv: "a1b2c3d4e5f60718293a4b5c6d7e8f90", login: "octocat", url: "https://snip.octo.workers.dev/" }
  const out = renderDeployConfig(tracked, values)
  assert.deepEqual(readValues(out), { ...values, url: "https://snip.octo.workers.dev" })
  assert.match(out, /"migrations_dir": "migrations"/)
  assert.match(out, /Gitignored/)
})

test("public URLs from a subdomain, host or URL", () => {
  assert.equal(publicUrlFrom("octo"), "https://snip.octo.workers.dev")
  assert.equal(publicUrlFrom("snip.example.com"), "https://snip.example.com")
  assert.equal(publicUrlFrom("https://snip.example.com/path/"), "https://snip.example.com")
  assert.equal(publicUrlFrom(" "), null)
})

test("ids printed by wrangler create commands", () => {
  assert.equal(parseCreatedId(`[[d1_databases]]\nbinding = "DB"\ndatabase_name = "snip"\ndatabase_id = "0f0e0d0c-0b0a-0908-0706-050403020100"`, "database_id"), "0f0e0d0c-0b0a-0908-0706-050403020100")
  assert.equal(parseCreatedId(`{\n  "d1_databases": [{ "binding": "DB", "database_id": "0f0e0d0c-0b0a-0908-0706-050403020100" }]\n}`, "database_id"), "0f0e0d0c-0b0a-0908-0706-050403020100")
  assert.equal(parseCreatedId(`"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90" }]`, "id"), "a1b2c3d4e5f60718293a4b5c6d7e8f90")
})

import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { preserveLocalConfig } from '../../scripts/cloudflare.mjs'
import { localConfigPath } from '../../web/local-config.mjs'

test('setup and tracked-config reset preserve the local database, files and sessions', {timeout:60000}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snip-local-identity-'))
  const web = path.join(root,'web')
  fs.mkdirSync(web)
  const original = {
    name:'snip-identity-test', main:'worker.js', compatibility_date:'2026-10-01',
    d1_databases:[{binding:'DB',database_name:'snip',database_id:'existing-local-db'}],
    kv_namespaces:[{binding:'KV',id:'existing-local-kv'}],
    r2_buckets:[{binding:'FILES',bucket_name:'existing-local-files'}],
  }
  fs.writeFileSync(path.join(web,'wrangler.jsonc'),JSON.stringify(original))
  fs.writeFileSync(path.join(web,'worker.js'),`export default {async fetch(req,env) {
    if(new URL(req.url).pathname==='/seed') {
      await env.DB.exec("CREATE TABLE refs (id TEXT); INSERT INTO refs VALUES ('existing-reference');");
      await env.KV.put('session','existing-session'); await env.FILES.put('image','existing-file'); return new Response('ok');
    }
    return Response.json({reference:await env.DB.prepare('SELECT id FROM refs').first(),session:await env.KV.get('session'),file:await (await env.FILES.get('image')).text()});
  }}`)
  const { unstable_readConfig, unstable_startWorker } = createRequire(import.meta.url)('wrangler')
  const start = () => unstable_startWorker({config:unstable_readConfig({config:localConfigPath(web)}),dev:{remote:false,watch:false,inspector:false,logLevel:'error',server:{hostname:'127.0.0.1',port:0},persist:path.join(web,'.wrangler/state')}})
  let worker
  try {
    worker = await start()
    assert.equal((await fetch(new URL('/seed',await worker.url))).status,200)
    const before = await (await fetch(await worker.url)).json()
    await worker.dispose(); worker = null
    const preserved = preserveLocalConfig(root)
    const localContents = fs.readFileSync(preserved,'utf8')
    fs.writeFileSync(path.join(web,'wrangler.deploy.jsonc'),JSON.stringify({...original,d1_databases:[{binding:'DB',database_name:'snip',database_id:'hosted-db'}]}))
    fs.writeFileSync(path.join(web,'wrangler.jsonc'),tracked)
    preserveLocalConfig(root)
    assert.equal(fs.readFileSync(preserved,'utf8'),localContents,'rerunning setup must not replace saved local identities')
    assert.equal(localConfigPath(web),preserved)
    worker = await start()
    assert.deepEqual(await (await fetch(await worker.url)).json(),before)
  } finally {
    await worker?.dispose()
    fs.rmSync(root,{recursive:true,force:true})
  }
})
