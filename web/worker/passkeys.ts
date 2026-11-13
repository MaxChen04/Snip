import type { Context } from "hono"
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server"
import { type AppEnv, crossSiteWrite, currentEpoch, getSession, setSessionCookie, signOutAll } from "./auth"
import * as db from "./db"

// Passkeys are an owner-only convenience: the owner registers one from the owner link so every
// other browser and device can sign in without GitHub. GitHub remains the path for a second
// person, and there is no invite model.
//
// RP ID and origin come from PUBLIC_URL, never from the request host, so a spoofed Host header
// cannot ask a browser to sign an assertion for another domain.

const RP_NAME = "Snip"
const CHALLENGE_SECONDS = 300

function relyingParty(env: Env) {
  const url = new URL(env.PUBLIC_URL)
  return { rpID: url.hostname, origin: url.origin }
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

const hex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("")

/** Challenges live in D1: a KV get-then-burn can be replayed in another colo. */
async function putChallenge(database: D1Database, kind: "register" | "login", challenge: string) {
  await database.prepare(`DELETE FROM webauthn_challenges WHERE exp < ?`).bind(nowSeconds()).run()
  await database
    .prepare(`INSERT INTO webauthn_challenges (id, challenge, kind, exp) VALUES (?, ?, ?, ?)`)
    .bind(hex(16), challenge, kind, nowSeconds() + CHALLENGE_SECONDS)
    .run()
}

/** Single use, by DELETE: exactly one caller sees meta.changes === 1 for a given challenge. */
async function burnChallenge(database: D1Database, kind: "register" | "login", challenge: string): Promise<boolean> {
  const result = await database
    .prepare(`DELETE FROM webauthn_challenges WHERE challenge = ? AND kind = ? AND exp >= ?`)
    .bind(challenge, kind, nowSeconds())
    .run()
  return result.meta.changes === 1
}

const badRequest = (message: string) => ({ error: message })

export async function registerOptions(c: Context<AppEnv>) {
  const session = await getSession(c)
  if (!session) return c.json(badRequest("unauthorized"), 401)
  const owner = await db.getOwner(c.env.DB, session.ownerId)
  if (!owner) return c.json(badRequest("Only the owner of this Snip library can add a passkey."), 403)
  const existing = await db.listPasskeys(c.env.DB, owner.id)
  const { rpID } = relyingParty(c.env)
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: owner.id,
    userDisplayName: owner.label ?? owner.id,
    userID: Uint8Array.from(new TextEncoder().encode(owner.id)),
    excludeCredentials: existing.map((k) => ({ id: k.id, transports: k.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  })
  await putChallenge(c.env.DB, "register", options.challenge)
  return c.json(options)
}

export async function registerVerify(c: Context<AppEnv>) {
  const refused = crossSiteWrite(c.req.raw)
  if (refused) return c.json(badRequest(refused), 403)
  const session = await getSession(c)
  if (!session) return c.json(badRequest("unauthorized"), 401)
  const owner = await db.getOwner(c.env.DB, session.ownerId)
  if (!owner) return c.json(badRequest("Only the owner of this Snip library can add a passkey."), 403)

  const body = await c.req.json<{ response?: RegistrationResponseJSON; deviceLabel?: unknown }>().catch(() => null)
  if (!body?.response) return c.json(badRequest("Expected a registration response"), 400)
  const label = typeof body.deviceLabel === "string" && body.deviceLabel.trim() ? body.deviceLabel.trim().slice(0, 60) : null

  const { rpID, origin } = relyingParty(c.env)
  let verification
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: (challenge) => burnChallenge(c.env.DB, "register", challenge),
      expectedOrigin: origin,
      expectedRPID: rpID,
    })
  } catch (error) {
    return c.json(badRequest(error instanceof Error ? error.message : "Passkey registration failed."), 400)
  }
  if (!verification.verified) return c.json(badRequest("Passkey registration could not be verified."), 400)

  const credential = verification.registrationInfo.credential
  const outcome = await db.addPasskey(c.env.DB, {
    id: credential.id,
    ownerId: owner.id,
    publicKey: credential.publicKey.buffer.slice(credential.publicKey.byteOffset, credential.publicKey.byteOffset + credential.publicKey.byteLength) as ArrayBuffer,
    counter: credential.counter,
    transports: credential.transports,
    deviceLabel: label,
  })
  if (outcome === "other-owner") return c.json(badRequest("This passkey already belongs to another account on this Snip library."), 409)
  // `duplicate` is additive on top of the documented `{ ok: true }`: the browser normally stops
  // this with excludeCredentials (InvalidStateError), but a stale options blob can get past it,
  // and the page then needs to say "you already added a passkey on this device" rather than
  // silently claiming a new one.
  return c.json(outcome === "refreshed" ? { ok: true, duplicate: true } : { ok: true })
}

export async function loginOptions(c: Context<AppEnv>) {
  const passkeys = await db.listPasskeys(c.env.DB)
  if (!passkeys.length) return c.json(badRequest("No passkeys are registered for this Snip library. Use the owner link or GitHub to sign in."), 400)
  const { rpID } = relyingParty(c.env)
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: passkeys.map((k) => ({ id: k.id, transports: k.transports })),
    userVerification: "preferred",
  })
  await putChallenge(c.env.DB, "login", options.challenge)
  return c.json(options)
}

export async function loginVerify(c: Context<AppEnv>) {
  const refused = crossSiteWrite(c.req.raw)
  if (refused) return c.json(badRequest(refused), 403)
  const body = await c.req.json<{ response?: AuthenticationResponseJSON }>().catch(() => null)
  if (!body?.response?.id) return c.json(badRequest("Expected an authentication response"), 400)

  const context = await db.getPasskeyLogin(c.env.DB, body.response.id)
  if (!context) return c.json(badRequest("This passkey is no longer registered for this Snip library. Use the owner link or GitHub to sign in."), 400)
  const { passkey, owner, epoch } = context

  const { rpID, origin } = relyingParty(c.env)
  const credential: WebAuthnCredential = {
    id: passkey.id,
    publicKey: new Uint8Array(passkey.publicKey),
    counter: passkey.counter,
    transports: passkey.transports as WebAuthnCredential["transports"],
  }
  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: (challenge) => burnChallenge(c.env.DB, "login", challenge),
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential,
    })
  } catch (error) {
    return c.json(badRequest(error instanceof Error ? error.message : "Passkey sign-in failed."), 400)
  }
  if (!verification.verified) return c.json(badRequest("Passkey sign-in could not be verified."), 400)

  await db.touchPasskey(c.env.DB, passkey.id, verification.authenticationInfo.newCounter)
  await setSessionCookie(c, { ownerId: owner.id, label: owner.label ?? owner.id, method: "passkey", epoch })
  return c.json({ ok: true })
}

/** Per-device list for Settings. Never returns the public key. */
export async function listDevices(c: Context<AppEnv>) {
  const passkeys = await db.listPasskeys(c.env.DB, c.get("session").ownerId)
  return c.json({
    devices: passkeys.map((k) => ({
      id: k.id,
      label: k.deviceLabel,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
    })),
  })
}

export async function removeDevice(c: Context<AppEnv>) {
  const session = c.get("session")
  if (!(await db.deletePasskey(c.env.DB, session.ownerId, c.req.param("id")!))) return c.json(badRequest("No such passkey"), 404)
  // A session does not record which passkey signed it in, so a removed device is signed out by ending them all,
  // connected agents included. This one is renewed.
  await setSessionCookie(c, { ...session, epoch: await signOutAll(c.env, session) })
  return c.json({ ok: true })
}
