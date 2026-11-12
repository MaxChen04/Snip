import { useCallback, useEffect, useState } from "react"
import { Link, useSearch } from "wouter"
import { navigate } from "wouter/use-browser-location"
import { CheckIcon, KeyRound, LaptopIcon, LogOutIcon, PlusIcon, ShieldCheckIcon, SmartphoneIcon, Trash2Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AuthError, AuthShell } from "@/components/auth/auth-shell"
import { notify } from "@/components/notify"
import { api, type Me, type PasskeyDevice } from "@/lib/api"
import { ALREADY_ADDED, passkeyUnsupported, registerPasskey } from "@/lib/passkeys"

/**
 * The owner's devices. A passkey is per-device and owner-only: it is not an invite. Removing one
 * here is the recovery path for a lost device; "Sign out everywhere" is the recovery path for a
 * leaked session. App has already checked the session (and shown its own retry state when Snip
 * could not be reached), so `me` is null only after a real 401.
 */
export function PasskeysPage({ me }: { me: Me | null }) {
  // The owner link sends a browser it just signed in here with ?new=1.
  const fresh = new URLSearchParams(useSearch()).get("new") === "1"
  const [devices, setDevices] = useState<PasskeyDevice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState("")
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<PasskeyDevice | null>(null)
  const [signingOut, setSigningOut] = useState(false)

  const load = useCallback(async () => {
    try {
      setDevices((await api.passkeys()).devices)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (me) void load()
  }, [me, load])

  const add = async () => {
    setAdding(true)
    setAddError(null)
    try {
      const { duplicate } = await registerPasskey(label.trim() || defaultLabel())
      setLabel("")
      // The server also reports a duplicate, for the stale-options case the browser's
      // excludeCredentials cannot catch. Both paths say the same thing.
      notify(duplicate ? ALREADY_ADDED : "Passkey added")
      await load()
      if (fresh) navigate("/passkeys", { replace: true })
    } catch (e) {
      setAddError((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  const remove = async (device: PasskeyDevice) => {
    try {
      await api.removePasskey(device.id)
      notify("Device removed")
      setRemoving(null)
      await load()
    } catch (e) {
      notify(`Couldn't remove it: ${(e as Error).message}`)
    }
  }

  const signOutEverywhere = async () => {
    try {
      await api.signOutAll()
      location.assign("/")
    } catch (e) {
      notify(`Couldn't sign out: ${(e as Error).message}`)
      setSigningOut(false)
    }
  }

  const addForm = (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={defaultLabel()}
          maxLength={60}
          aria-label="Device name"
          size="lg"
          className="flex-1"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !adding) void add()
          }}
        />
        <Button size="lg" disabled={adding} onClick={add} className="shrink-0">
          {adding ? <span className="size-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" /> : <PlusIcon className="size-4" />}
          {adding ? "Waiting…" : "Add passkey"}
        </Button>
      </div>
      <AuthError>{addError}</AuthError>
    </>
  )

  if (!me) {
    return (
      <AuthShell title="Sign in to manage passkeys" description="This page belongs to the owner of this Snip library." footer={<Link href="/">Back to the library</Link>}>
        <Button size="xl" className="w-full" render={<Link href="/sign-in" />} nativeButton={false}>
          Sign in
        </Button>
      </AuthShell>
    )
  }

  // Offered once, right after the owner link: not to a session that already came from a passkey, and
  // not in a browser that cannot make one.
  if (fresh && me.method !== "passkey" && !passkeyUnsupported()) {
    return (
      <AuthShell
        wide
        title="Add a passkey for this device"
        description="Next time this device signs in with Touch ID, your device PIN or a security key, with no owner link. Name it so you can tell it apart later."
      >
        {addForm}
        <Button variant="ghost" size="lg" className="mt-3 w-full" render={<Link href="/" />} nativeButton={false}>
          Not now
        </Button>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      wide
      title="Your devices"
      description="Every passkey that can open this library. A passkey stays on its device; Snip keeps only the public half."
      footer={<Link href="/">Back to the library</Link>}
    >
      <section aria-labelledby="add-passkey">
        <h2 id="add-passkey" className="text-[13px] font-medium text-foreground">
          Add this device
        </h2>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
          You'll be asked for Touch ID, your device PIN or a security key. Name it so you can tell it apart later.
        </p>
        <div className="mt-3">{addForm}</div>
      </section>

      <section aria-labelledby="device-list" className="mt-6">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="device-list" className="text-[13px] font-medium text-foreground">
            Passkeys
          </h2>
          {devices && devices.length > 0 ? <span className="text-2xs text-muted-foreground">{devices.length} {devices.length === 1 ? "device" : "devices"}</span> : null}
        </div>

        {devices === null ? (
          <div className="mt-2 h-14 animate-pulse rounded-xl bg-fill-2" />
        ) : devices.length === 0 ? (
          <div className="mt-2 flex flex-col items-center gap-2 rounded-xl bg-fill-1 px-4 py-7 text-center">
            <span className="grid size-8 place-items-center rounded-lg bg-fill-2 text-muted-foreground">
              <KeyRound className="size-4" />
            </span>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              No passkeys yet. Add this device so you can sign in without the owner link.
            </p>
          </div>
        ) : (
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl bg-fill-1">
            {devices.map((device) => (
              <li key={device.id} className="flex items-center gap-3 px-3.5 py-3">
                <DeviceIcon label={device.label} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-foreground">{device.label || "Unnamed device"}</p>
                  <p className="mt-0.5 text-2xs text-muted-foreground">
                    Added {shortDate(device.createdAt)}
                    {device.lastUsedAt ? ` · Last used ${shortDate(device.lastUsedAt)}` : " · Never used"}
                  </p>
                </div>
                <Button variant="ghost" size="icon-sm" aria-label={`Remove ${device.label || "device"}`} onClick={() => setRemoving(device)}>
                  <Trash2Icon className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <AuthError>{error}</AuthError>
      </section>

      <section aria-labelledby="session-safety" className="mt-6 rounded-xl bg-fill-1 px-3.5 py-3">
        <div className="flex items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-fill-2 text-muted-foreground">
            <ShieldCheckIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="session-safety" className="text-[13px] font-medium text-foreground">
              Signed in somewhere you don't recognize?
            </h2>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
              Signing out everywhere ends every browser session, the Snip app's session and every connected agent. Passkeys stay registered.
            </p>
            <Button variant="destructive" size="sm" className="mt-2.5 h-auto max-w-full py-1.5 text-left whitespace-normal" onClick={() => setSigningOut(true)}>
              <LogOutIcon className="size-3.5" />
              Sign out everywhere, including connected agents
            </Button>
          </div>
        </div>
        <p className="mt-2 pl-11 text-2xs text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{me.login}</span> using {me.method === "passkey" ? "a passkey" : me.method === "github" ? "GitHub" : "the owner link"}.
        </p>
      </section>

      <Dialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove this passkey?</DialogTitle>
            <DialogDescription>
              {removing?.label || "This device"} will no longer open Snip. Every other browser and the Snip app are signed out, and connected agents have to reconnect. If it's your only passkey you'll need a fresh owner link to sign in again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Keep it</DialogClose>
            <Button variant="destructive-confirm" onClick={() => removing && remove(removing)}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={signingOut} onOpenChange={setSigningOut}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Sign out everywhere, including connected agents?</DialogTitle>
            <DialogDescription>
              Every browser, the Snip app and every connected agent stop working immediately. Browsers and the app have to sign in again, and agents have to reconnect. Passkeys stay registered, and the owner link from your Mac is the way back in.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button variant="destructive-confirm" onClick={signOutEverywhere}>
              <CheckIcon className="size-3.5" />
              Sign out everywhere
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AuthShell>
  )
}

function DeviceIcon({ label }: { label: string | null }) {
  const name = label?.toLowerCase() ?? ""
  const Phone = /iphone|ipad|phone|android|pixel|galaxy|mobile/.test(name)
  const Desktop = /mac|windows|linux|desktop|imac/.test(name) && !Phone
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-fill-2 text-muted-foreground">
      {Phone ? <SmartphoneIcon className="size-4" /> : Desktop ? <LaptopIcon className="size-4" /> : <KeyRound className="size-4" />}
    </span>
  )
}

/** A sensible default name, taken from the browser rather than an invented one. */
function defaultLabel() {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "This browser"
  const platform = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Mac/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : ""
  return platform ? `${browser} on ${platform}` : browser
}

const shortDate = (iso: string) => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "unknown"
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" })
}
