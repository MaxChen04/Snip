import { useEffect, useState } from "react"
import { Link } from "wouter"
import { KeyRound, Lock } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { AuthError, AuthShell } from "@/components/auth/auth-shell"
import { api, type Me } from "@/lib/api"
import { signInWithPasskey } from "@/lib/passkeys"
import { safeNext } from "../../../shared/safe-next"

type Methods = { github: boolean; hasPasskeys: boolean }

// The validated `?next=` for this page, or the library (contracts v3.19 §4.2.2).
const nextTarget = () => safeNext(new URLSearchParams(location.search).get("next"))

/**
 * Passkey sign-in. This is the everyday way in on every device but the one that minted the owner
 * link, and it is also where an MCP client's authorization starts: `/authorize` sends an
 * unauthenticated client here and this page sends them back, so a passkeys-only install needs no
 * GitHub App to connect an agent.
 */
export function SignInPage() {
  const [state, setState] = useState<"checking" | "anon" | Me>("checking")
  const [methods, setMethods] = useState<Methods | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const target = nextTarget()

  useEffect(() => {
    let live = true
    api
      .me()
      .then((me) => {
        if (!live) return
        // A client sent here to authorize has nothing else to do on this page.
        if (target !== "/") {
          location.replace(target)
          return
        }
        setState(me)
      })
      // A cloud library that is unreachable should still show the form; only 401 means anon.
      .catch(() => live && setState("anon"))
    // What this install can actually do, so the page never offers a dead end.
    fetch("/auth/methods")
      .then((res) => (res.ok ? (res.json() as Promise<Methods>) : null))
      .then((value) => live && setMethods(value))
      .catch(() => live && setMethods(null))
    return () => {
      live = false
    }
  }, [target])

  const signIn = async () => {
    setBusy(true)
    setError(null)
    try {
      await signInWithPasskey()
      // The cookie is set; a full navigation picks it up and lands where the caller asked for.
      location.assign(target)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  if (state === "checking") {
    return (
      <AuthShell title="Sign in">
        <div className="h-9 animate-pulse rounded-lg bg-fill-2" />
      </AuthShell>
    )
  }

  if (state !== "anon") {
    return (
      <AuthShell
        title="You're already signed in"
        description={
          <>
            Signed in as <span className="font-medium text-foreground">{state.login}</span> with a{" "}
            {state.method === "passkey" ? "passkey" : state.method === "github" ? "GitHub account" : "signed-in browser"}.
          </>
        }
        footer={<Link href="/passkeys">Manage passkeys and devices</Link>}
      >
        <Button size="xl" className="w-full" render={<Link href="/" />} nativeButton={false}>
          Open your library
        </Button>
      </AuthShell>
    )
  }

  // Before /auth/methods answers, assume a passkey exists: that is the common case, and the button
  // reports a real error rather than the page flashing "no passkey here" on every load.
  const hasPasskeys = methods?.hasPasskeys ?? true
  return (
    <AuthShell
      title="Sign in to Snip"
      description={
        hasPasskeys
          ? "Use the passkey saved on this device. Nothing to type, nothing to remember."
          : "This library has no passkey yet. Open Snip on the Mac that owns it and use the owner link under Settings → Cloud: it signs this browser in once, and you can add a passkey here."
      }
      footer={
        methods?.github ? (
          <>
            No passkey on this device? <a href="/auth/login">Use GitHub</a> if this library allows it, or add one from a signed-in device.
          </>
        ) : hasPasskeys ? (
          // A device that has a passkey elsewhere cannot help itself here: the owner link from the
          // Mac is the documented way back in, so name it rather than dead-ending.
          <>No passkey on this device? Open Snip on the Mac that owns this library and use the owner link under Settings → Cloud.</>
        ) : null /* The description above already gives the only way in. */
      }
    >
      {/*
        With no passkey registered anywhere, "Sign in with a passkey" can only fail. Hide it rather
        than offer a dead end: the description above carries the way in, and the only useful action
        is to reload once a passkey exists.
      */}
      {methods?.hasPasskeys === false ? (
        <Button size="xl" variant="outline" className="w-full" onClick={() => location.reload()}>
          Reload once you've added one
        </Button>
      ) : (
        <>
          <div className="mb-5 flex items-center gap-3 rounded-xl bg-fill-1 px-3.5 py-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-fill-2 text-muted-foreground">
              <Lock className="size-4" />
            </span>
            <p className="text-[12.5px] leading-snug text-muted-foreground">Your passkey stays on this device. Snip only ever sees its public half.</p>
          </div>
          <Button size="xl" className="w-full" disabled={busy} onClick={signIn}>
            <KeyRound className="size-4" />
            {busy ? "Waiting for your device…" : "Sign in with a passkey"}
          </Button>
        </>
      )}
      <AuthError>{error}</AuthError>
    </AuthShell>
  )
}
