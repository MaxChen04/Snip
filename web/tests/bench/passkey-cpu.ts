import { readdir, readFile } from "node:fs/promises"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type WebAuthnCredential,
} from "@simplewebauthn/server"
import { app } from "../../worker/app"
import { getPasskey } from "../../worker/db"
import { b64url, fromB64url } from "../helpers/webauthn"

// Risk 3 from the architecture spec: "Passkey CPU on the free plan (10 ms)".
//
// What this measures is the CPU the Worker spends, which is the metric the free plan caps: JSON
// parse, CBOR decode, ECDSA verify and D1 statement handling. Wall time is reported next to it,
// because on a real deployment most of a request is waiting on D1 and R2, not computing.
//
// The verify rows replay web/tests/fixtures/passkey.json, the same committed bytes the tests
// check, so the number is not flattered by a cheaper synthetic input.

type Fixture = {
  rpID: string
  origin: string
  credential: { id: string; publicKey: string; counter: number }
  registration: { challenge: string; response: Record<string, unknown> }
  authentication: { challenge: string; response: Record<string, unknown>; counter: number }
}

const fixture = JSON.parse(await readFile(new URL("../fixtures/passkey.json", import.meta.url), "utf8")) as Fixture
const fixtureCredential: WebAuthnCredential = {
  id: fixture.credential.id,
  publicKey: fromB64url(fixture.credential.publicKey),
  counter: fixture.credential.counter,
  transports: [],
}

const ITERATIONS = Number(process.env.ITERATIONS ?? 200)

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return {
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1)!,
  }
}

const ms = (n: number) => `${n.toFixed(2)} ms`

/** CPU microseconds consumed by `fn`, from the process counters. */
async function cpuTime<T>(fn: () => Promise<T>): Promise<{ cpu: number; wall: number; value: T }> {
  const before = process.cpuUsage()
  const start = performance.now()
  const value = await fn()
  const delta = process.cpuUsage(before)
  return { cpu: (delta.user + delta.system) / 1000, wall: performance.now() - start, value }
}

async function main() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"] }))
  const db = (await mf.getD1Database("DB")) as unknown as D1Database
  const dir = new URL("../../migrations/", import.meta.url)
  for (const migration of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(migration, dir), "utf8")
    const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
    await db.batch(statements.map((statement) => db.prepare(statement)))
  }
  await db.prepare(`INSERT INTO owners (id, label, created_at) VALUES ('max', 'Max', '2026-01-01T00:00:00Z')`).run()
  // The fixture credential, stored exactly as the registration route would store it.
  await db
    .prepare(`INSERT INTO passkeys (id, owner_id, public_key, counter, transports, device_label, created_at) VALUES (?, 'max', ?, ?, '["internal"]', 'Fixture', '2026-01-01T00:00:00Z')`)
    .bind(fixture.credential.id, fromB64url(fixture.credential.publicKey).buffer, fixture.credential.counter)
    .run()
  const env = { DB: db, SESSION_SECRET: "s", OWNER_LINK_SECRET: "o", PUBLIC_URL: fixture.origin, DEV_LOGIN: "max" } as unknown as Env
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

  const stored = (await getPasskey(db, fixture.credential.id))!
  const challenge = () => b64url(crypto.getRandomValues(new Uint8Array(32)))

  // Warm-up: the first call pulls in the ASN.1/CBOR helpers and fills the module cache.
  await generateRegistrationOptions({ rpName: "Snip", rpID: fixture.rpID, userName: "max" })
  await verifyRegistrationResponse({
    response: fixture.registration.response as never,
    expectedChallenge: fixture.registration.challenge,
    expectedOrigin: fixture.origin,
    expectedRPID: fixture.rpID,
  })
  await verifyAuthenticationResponse({
    response: fixture.authentication.response as never,
    expectedChallenge: fixture.authentication.challenge,
    expectedOrigin: fixture.origin,
    expectedRPID: fixture.rpID,
    credential: fixtureCredential,
  })

  const rows: { label: string; cpu: ReturnType<typeof stats>; wall: ReturnType<typeof stats> }[] = []

  const measure = async (label: string, fn: () => Promise<unknown>) => {
    const cpu: number[] = []
    const wall: number[] = []
    for (let i = 0; i < ITERATIONS; i++) {
      const result = await cpuTime(fn)
      cpu.push(result.cpu)
      wall.push(result.wall)
    }
    rows.push({ label, cpu: stats(cpu), wall: stats(wall) })
  }

  await measure("generate registration options", () =>
    generateRegistrationOptions({ rpName: "Snip", rpID: fixture.rpID, userName: "max", userID: Uint8Array.from([1, 2, 3]) }),
  )

  await measure("verify registration (fixture, ES256, none attestation)", () =>
    verifyRegistrationResponse({
      response: fixture.registration.response as never,
      expectedChallenge: fixture.registration.challenge,
      expectedOrigin: fixture.origin,
      expectedRPID: fixture.rpID,
    }),
  )

  await measure("generate login options", () => generateAuthenticationOptions({ rpID: fixture.rpID, allowCredentials: [{ id: fixture.credential.id }] }))

  await measure("verify assertion (fixture, ES256)", () =>
    verifyAuthenticationResponse({
      response: fixture.authentication.response as never,
      expectedChallenge: fixture.authentication.challenge,
      expectedOrigin: fixture.origin,
      expectedRPID: fixture.rpID,
      credential: fixtureCredential,
    }),
  )

  await measure("D1: insert + prune challenge", async () => {
    await db.prepare(`INSERT INTO webauthn_challenges (id, challenge, kind, exp) VALUES (?, ?, 'login', ?)`).bind(challenge(), challenge(), Math.floor(Date.now() / 1000) + 300).run()
    return db.prepare(`DELETE FROM webauthn_challenges WHERE exp < ?`).bind(Math.floor(Date.now() / 1000) - 1).run()
  })

  // A whole request through the route, the way a browser exercises it: D1 challenge lookup and
  // burn, ECDSA verify, passkey counter update and the session cookie, all at once.
  const replayIntoRoute = async () => {
    await db.prepare(`DELETE FROM webauthn_challenges`).run()
    await db.prepare(`UPDATE passkeys SET counter = 0 WHERE id = ?`).bind(fixture.credential.id).run()
    await db
      .prepare(`INSERT INTO webauthn_challenges (id, challenge, kind, exp) VALUES (?, ?, 'login', ?)`)
      .bind(challenge(), fixture.authentication.challenge, Math.floor(Date.now() / 1000) + 300)
      .run()
    return app.request(
      `${fixture.origin}/auth/passkey/login/verify`,
      { method: "POST", body: JSON.stringify({ response: fixture.authentication.response }), headers: { "content-type": "application/json" } },
      env,
      ctx,
    )
  }
  const first = await replayIntoRoute()
  if (first.status !== 200) throw new Error(`the fixture replay failed: ${first.status} ${await first.text()}`)

  const fullCpu: number[] = []
  const fullWall: number[] = []
  for (let i = 0; i < Math.max(20, Math.floor(ITERATIONS / 4)); i++) {
    const result = await cpuTime(replayIntoRoute)
    fullCpu.push(result.cpu)
    fullWall.push(result.wall)
  }
  rows.push({ label: "POST /auth/passkey/login/verify (whole route)", cpu: stats(fullCpu), wall: stats(fullWall) })
  void stored

  console.log(`\nPasskey CPU, ${ITERATIONS} iterations per row, ${process.version}\n`)
  console.log("operation".padEnd(52), "cpu mean", "  p95  ", "  max  ", " wall mean")
  for (const row of rows) {
    console.log(row.label.padEnd(52), ms(row.cpu.mean).padStart(8), ms(row.cpu.p95).padStart(7), ms(row.cpu.max).padStart(7), ms(row.wall.mean).padStart(10))
  }
  console.log(`\nFree-plan CPU limit: 10 ms per request. Slowest measured mean: ${ms(Math.max(...rows.map((r) => r.cpu.mean)))}.\n`)
  await mf.dispose()
}

await main()
