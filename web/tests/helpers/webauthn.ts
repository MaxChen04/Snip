// A minimal software authenticator for tests and benchmarks. It builds the exact byte shapes a
// browser sends (CBOR attestation object, clientDataJSON, DER-encoded ECDSA assertion) so the
// real verify path runs, not a mock of it.

const enc = new TextEncoder()

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ""
  for (const b of view) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromB64url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// ---------- CBOR (the subset an attestation object needs) ----------

const head = (major: number, value: number) => {
  if (value < 24) return Uint8Array.of((major << 5) | value)
  if (value < 0x100) return Uint8Array.of((major << 5) | 24, value)
  return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff)
}

const cbor = {
  uint: (n: number) => head(0, n),
  neg: (n: number) => head(1, -n - 1),
  bytes: (b: Uint8Array) => concat(head(2, b.length), b),
  text: (s: string) => {
    const bytes = enc.encode(s)
    return concat(head(3, bytes.length), bytes)
  },
  array: (items: Uint8Array[]) => concat(head(4, items.length), ...items),
  map: (entries: [Uint8Array, Uint8Array][]) => concat(head(5, entries.length), ...entries.flat()),
}

// ---------- Authenticator ----------

export type Credential = {
  id: string
  rawId: Uint8Array
  privateKey: CryptoKey
  publicKey: Uint8Array
  counter: number
}

export type AuthenticatorOptions = { rpID: string; origin: string; counter?: number }

async function cosePublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey)
  const x = fromB64url(jwk.x!)
  const y = fromB64url(jwk.y!)
  // EC2: {1:2 (kty), 3:-7 (ES256), -1:1 (P-256), -2:x, -3:y}
  return cbor.map([
    [cbor.uint(1), cbor.uint(2)],
    [cbor.uint(3), cbor.neg(-7)],
    [cbor.neg(-1), cbor.uint(1)],
    [cbor.neg(-2), cbor.bytes(x)],
    [cbor.neg(-3), cbor.bytes(y)],
  ])
}

const rpIdHash = async (rpID: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(rpID)))

const clientData = (type: "webauthn.create" | "webauthn.get", challenge: string, origin: string) =>
  enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }))

/** Flags: user present, user verified, and (registration only) attested credential data. */
const FLAGS_UP_UV = 0b0000_0101
const FLAGS_UP_UV_AT = 0b0100_0101

export async function createCredential(options: AuthenticatorOptions & { challenge: string }): Promise<{ response: unknown; credential: Credential }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const publicKey = await cosePublicKey(pair.publicKey)
  const rawId = crypto.getRandomValues(new Uint8Array(16))
  const id = b64url(rawId)
  const counter = options.counter ?? 0

  const authData = concat(
    await rpIdHash(options.rpID),
    Uint8Array.of(FLAGS_UP_UV_AT),
    new Uint8Array(new Uint32Array([counter]).buffer).reverse(),
    new Uint8Array(16), // AAGUID
    Uint8Array.of(rawId.length >> 8, rawId.length & 0xff),
    rawId,
    publicKey,
  )
  const attestationObject = cbor.map([
    [cbor.text("fmt"), cbor.text("none")],
    [cbor.text("attStmt"), cbor.map([])],
    [cbor.text("authData"), cbor.bytes(authData)],
  ])

  return {
    credential: { id, rawId, privateKey: pair.privateKey, publicKey, counter },
    response: {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64url(clientData("webauthn.create", options.challenge, options.origin)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    },
  }
}

/** DER SEQUENCE { INTEGER r, INTEGER s } around the raw WebCrypto signature. */
function derEncodeSignature(raw: Uint8Array): Uint8Array {
  const trim = (bytes: Uint8Array) => {
    let i = 0
    while (i < bytes.length - 1 && bytes[i] === 0) i++
    return bytes.subarray(i)
  }
  const integer = (bytes: Uint8Array) => {
    const value = trim(bytes)
    // A leading 1 bit means the DER integer needs a 0x00 prefix to stay positive.
    const body = value[0]! & 0x80 ? concat(Uint8Array.of(0), value) : value
    return concat(Uint8Array.of(0x02, body.length), body)
  }
  const body = concat(integer(raw.subarray(0, 32)), integer(raw.subarray(32)))
  return concat(Uint8Array.of(0x30, body.length), body)
}

export async function createAssertion(options: AuthenticatorOptions & { challenge: string; credential: Credential }): Promise<{ response: unknown; counter: number }> {
  const counter = (options.credential.counter ?? 0) + 1
  const authData = concat(await rpIdHash(options.rpID), Uint8Array.of(FLAGS_UP_UV), new Uint8Array(new Uint32Array([counter]).buffer).reverse())
  const clientDataJSON = clientData("webauthn.get", options.challenge, options.origin)
  const signed = concat(authData, new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON)))
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, options.credential.privateKey, signed))

  return {
    counter,
    response: {
      id: options.credential.id,
      rawId: options.credential.id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(derEncodeSignature(signature)),
        userHandle: null,
      },
    },
  }
}
