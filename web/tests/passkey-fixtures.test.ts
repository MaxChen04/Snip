import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type WebAuthnCredential } from "@simplewebauthn/server"
import { fromB64url } from "./helpers/webauthn"

// The fixture is a real registration and assertion for snip.test, generated once by
// generate-passkey-fixture.mjs. Driving the verifiers with it proves the shapes the Worker sends
// and accepts, independently of the request handler, and gives the CPU benchmark the same work.

type Fixture = {
  rpID: string
  origin: string
  credential: { id: string; publicKey: string; counter: number }
  registration: { challenge: string; response: Record<string, unknown> }
  authentication: { challenge: string; response: Record<string, unknown>; counter: number }
}

const fixture = JSON.parse(await readFile(new URL("./fixtures/passkey.json", import.meta.url), "utf8")) as Fixture

const credential = (): WebAuthnCredential => ({
  id: fixture.credential.id,
  publicKey: fromB64url(fixture.credential.publicKey),
  counter: fixture.credential.counter,
  transports: ["internal"],
})

test("the committed registration fixture verifies", async () => {
  const result = await verifyRegistrationResponse({
    response: fixture.registration.response as never,
    expectedChallenge: fixture.registration.challenge,
    expectedOrigin: fixture.origin,
    expectedRPID: fixture.rpID,
  })
  assert.equal(result.verified, true)
  assert.ok(result.registrationInfo)
  assert.equal(result.registrationInfo.fmt, "none", "no attestation is requested or verified")
  assert.equal(result.registrationInfo.credential.id, fixture.credential.id)
  assert.deepEqual([...result.registrationInfo.credential.publicKey], [...fromB64url(fixture.credential.publicKey)], "the stored COSE key is the credential's")
  assert.equal(result.registrationInfo.credential.counter, 0)
  assert.equal(result.registrationInfo.origin, fixture.origin)
  assert.equal(result.registrationInfo.rpID, fixture.rpID)
})

test("the committed assertion fixture verifies and moves the counter", async () => {
  const result = await verifyAuthenticationResponse({
    response: fixture.authentication.response as never,
    expectedChallenge: fixture.authentication.challenge,
    expectedOrigin: fixture.origin,
    expectedRPID: fixture.rpID,
    credential: credential(),
  })
  assert.equal(result.verified, true)
  assert.equal(result.authenticationInfo.credentialID, fixture.credential.id)
  assert.equal(result.authenticationInfo.newCounter, fixture.authentication.counter)
  assert.ok(result.authenticationInfo.newCounter > fixture.credential.counter, "the counter advances")
})

test("the same fixtures are refused under another origin, RP ID or challenge", async () => {
  await assert.rejects(
    verifyRegistrationResponse({
      response: fixture.registration.response as never,
      expectedChallenge: fixture.registration.challenge,
      expectedOrigin: "https://evil.example",
      expectedRPID: fixture.rpID,
    }),
    /origin/i,
  )
  await assert.rejects(
    verifyRegistrationResponse({
      response: fixture.registration.response as never,
      expectedChallenge: fixture.registration.challenge,
      expectedOrigin: fixture.origin,
      expectedRPID: "evil.example",
    }),
    /RP ID/i,
  )
  await assert.rejects(
    verifyAuthenticationResponse({
      response: fixture.authentication.response as never,
      expectedChallenge: "different-challenge",
      expectedOrigin: fixture.origin,
      expectedRPID: fixture.rpID,
      credential: credential(),
    }),
    /challenge/i,
  )
})

test("a tampered assertion signature is refused", async () => {
  const response = structuredClone(fixture.authentication.response) as { response: { signature: string } }
  const bytes = fromB64url(response.response.signature)
  bytes[bytes.length - 1] ^= 0xff
  response.response.signature = Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  const result = await verifyAuthenticationResponse({
    response: response as never,
    expectedChallenge: fixture.authentication.challenge,
    expectedOrigin: fixture.origin,
    expectedRPID: fixture.rpID,
    credential: credential(),
  })
  // The library reports a bad signature as verified: false; the route turns that into a 400.
  assert.equal(result.verified, false)
})

test("the options generators emit the shapes the fixture was built against", async () => {
  const registration = await generateRegistrationOptions({ rpName: "Snip", rpID: fixture.rpID, userName: "max" })
  assert.equal(registration.rp.id, fixture.rpID)
  const algorithms = registration.pubKeyCredParams.map((p) => p.alg)
  assert.ok(algorithms.includes(-7), `ES256 is offered (got ${algorithms.join(", ")})`)
  assert.ok(algorithms.every((alg) => typeof alg === "number"))
  assert.match(registration.challenge, /^[A-Za-z0-9_-]{43}$/)

  const authentication = await generateAuthenticationOptions({ rpID: fixture.rpID, allowCredentials: [{ id: fixture.credential.id }] })
  assert.equal(authentication.rpId, fixture.rpID)
  assert.deepEqual(authentication.allowCredentials, [{ id: fixture.credential.id, type: "public-key" }])
})
