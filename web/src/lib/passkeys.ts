// Browser side of passkeys. Registration is owner-only and happens right after the owner link;
// sign-in is the everyday path for every other device.

const toBytes = (value: string) => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  const binary = atob(base64)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

const toBase64url = (value: ArrayBuffer) => {
  const bytes = new Uint8Array(value)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export class PasskeyError extends Error {}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new PasskeyError(data.error ?? `Request failed (${res.status})`)
  return data as T
}

const passkeyUnsupported = () =>
  !window.PublicKeyCredential || !window.isSecureContext
    ? new PasskeyError(
        window.isSecureContext
          ? "This browser does not support passkeys."
          : "Passkeys need a secure address. Open this library at its https:// address.",
      )
    : null

const describe = (error: unknown) => {
  if (error instanceof PasskeyError) return error
  const name = (error as { name?: string })?.name
  if (name === "NotAllowedError") return new PasskeyError("Cancelled, or the prompt timed out. Try again or use a different device.")
  if (name === "InvalidStateError") return new PasskeyError("This device already has a passkey for Snip.")
  return new PasskeyError((error as Error)?.message ?? "The passkey prompt failed.")
}

/** Adds this device's passkey to the signed-in owner. Returns nothing; throws PasskeyError. */
export async function registerPasskey(deviceLabel?: string) {
  const unsupported = passkeyUnsupported()
  if (unsupported) throw unsupported

  const options = await fetch("/auth/passkey/register/options").then(async (res) => {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new PasskeyError(data.error ?? "Could not start passkey registration.")
    return data as PublicKeyCredentialCreationOptionsJSON
  })

  let credential: Credential | null
  try {
    const publicKey = {
      ...options,
      challenge: toBytes(options.challenge),
      user: { ...options.user, id: toBytes(options.user.id) },
      excludeCredentials: options.excludeCredentials?.map((c) => ({ ...c, id: toBytes(c.id) })),
    } as unknown as PublicKeyCredentialCreationOptions
    credential = await navigator.credentials.create({ publicKey })
  } catch (error) {
    throw describe(error)
  }
  if (!credential || credential.type !== "public-key") throw new PasskeyError("No passkey was created.")
  const publicKey = credential as PublicKeyCredential
  const attestation = publicKey.response as AuthenticatorAttestationResponse

  await postJson("/auth/passkey/register/verify", {
    deviceLabel: deviceLabel?.trim() || undefined,
    response: {
      id: publicKey.id,
      rawId: toBase64url(publicKey.rawId),
      type: publicKey.type,
      authenticatorAttachment: publicKey.authenticatorAttachment ?? undefined,
      clientExtensionResults: publicKey.getClientExtensionResults(),
      response: {
        clientDataJSON: toBase64url(attestation.clientDataJSON),
        attestationObject: toBase64url(attestation.attestationObject),
        transports: attestation.getTransports?.() ?? [],
      },
    },
  })
}

/** Signs this browser in with a passkey and reloads so the app picks up the new session. */
export async function signInWithPasskey() {
  const unsupported = passkeyUnsupported()
  if (unsupported) throw unsupported

  const options = await fetch("/auth/passkey/login/options").then(async (res) => {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new PasskeyError(data.error ?? "Could not start passkey sign-in.")
    return data as PublicKeyCredentialRequestOptionsJSON
  })

  let credential: Credential | null
  try {
    const publicKey = {
      ...options,
      challenge: toBytes(options.challenge),
      allowCredentials: options.allowCredentials?.map((c) => ({ ...c, id: toBytes(c.id) })),
    } as unknown as PublicKeyCredentialRequestOptions
    credential = await navigator.credentials.get({ publicKey })
  } catch (error) {
    throw describe(error)
  }
  if (!credential || credential.type !== "public-key") throw new PasskeyError("No passkey was returned.")
  const publicKey = credential as PublicKeyCredential
  const assertion = publicKey.response as AuthenticatorAssertionResponse

  await postJson("/auth/passkey/login/verify", {
    response: {
      id: publicKey.id,
      rawId: toBase64url(publicKey.rawId),
      type: publicKey.type,
      authenticatorAttachment: publicKey.authenticatorAttachment ?? undefined,
      clientExtensionResults: publicKey.getClientExtensionResults(),
      response: {
        clientDataJSON: toBase64url(assertion.clientDataJSON),
        authenticatorData: toBase64url(assertion.authenticatorData),
        signature: toBase64url(assertion.signature),
        userHandle: assertion.userHandle ? toBase64url(assertion.userHandle) : undefined,
      },
    },
  })
}

// The subset of the WebAuthn JSON option shapes this file reads. The server sends them verbatim.

type PublicKeyCredentialDescriptorJSON = { id: string; type: "public-key"; transports?: AuthenticatorTransport[] }

type PublicKeyCredentialCreationOptionsJSON = {
  challenge: string
  user: { id: string; name: string; displayName: string }
  excludeCredentials?: PublicKeyCredentialDescriptorJSON[]
  [key: string]: unknown
}

type PublicKeyCredentialRequestOptionsJSON = {
  challenge: string
  allowCredentials?: PublicKeyCredentialDescriptorJSON[]
  [key: string]: unknown
}
