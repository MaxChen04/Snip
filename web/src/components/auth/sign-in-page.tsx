import { useEffect, useState } from "react"
import { Link } from "wouter"
import { KeyRound, Lock } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AuthError, AuthShell } from "@/components/auth/auth-shell"
import { api, type Me } from "@/lib/api"
import { signInWithPasskey } from "@/lib/passkeys"

/**
 * Passkey sign-in. This is the everyday way in on every device but the one that minted the owner
 * link, and it is the only browser flow a second person never sees: they use GitHub.
 */
export function SignInPage() {
  const [state, setState] = useState<"checking" | "anon" | Me>("checking")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api
      .me()
      .then((me) => live && setState(me))
      // A cloud library that is unreachable should still show the form; only 401 means anon.
      .catch(() => live && setState("anon"))
    return () => {
      live = false
    }
  }, [])

  const signIn = async () => {
    setBusy(true)
    setError(null)
    try {
      await signInWithPasskey()
      // The cookie is set; a reload is all the app needs to pick it up.
      location.assign("/")
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

  return (
    <AuthShell
      title="Sign in to Snip"
      description="Use the passkey saved on this device. Nothing to type, nothing to remember."
      footer={
        <>
          No passkey on this device?{" "}
          <a href="/auth/login">Use GitHub</a> if this library allows it, or add one from a signed-in device.
        </>
      }
    >
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
      <AuthError>{error}</AuthError>
    </AuthShell>
  )
}

/** Small badge naming the method a session used, for the gallery's account row. */
export function MethodBadge({ method }: { method: Me["method"] }) {
  const label = method === "passkey" ? "Passkey" : method === "github" ? "GitHub" : "Owner link"
  return (
    <Badge variant="secondary" size="lg">
      {label}
    </Badge>
  )
}
