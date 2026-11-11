import { useEffect, useState, type ReactNode } from "react"
import { cn } from "cn"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { CheckIcon, CopyIcon, Clock, GlobeIcon, HardDrive, LaptopIcon, ShieldCheckIcon, Trash2Icon, TriangleAlertIcon } from "@/components/icons"
import { references } from "./bits"
import type { OwnerLink } from "./types"

export function EnableDialog({
  open,
  onOpenChange,
  empty,
  refs,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  empty: boolean
  refs: number | null
  onConfirm: () => void
}) {
  const copies = !empty
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Turn on cloud for this library?</DialogTitle>
          <DialogDescription>
            {copies
              ? "Snip copies this library into your own Cloudflare account. Nothing on this Mac changes until the copy is verified."
              : "This library is empty, so there's nothing to copy. Snip will set up your Cloudflare account and switch this app to it."}
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-3.5">
          <Fact
            icon={<HardDrive className="size-4" />}
            title={copies ? `${references(refs)} ${refs === 1 ? "is" : "are"} copied to Cloudflare` : "There’s nothing to copy"}
            body={
              copies
                ? "Your screenshots and database are copied to your account. Cloudflare, not Snip, stores them."
                : "This library is empty, so setup only creates the cloud copy and switches this app to it."
            }
          />
          <Fact
            icon={<GlobeIcon className="size-4" />}
            title="Cloudflare asks for two things"
            body="You sign in and allow Snip. If R2 is off, you turn it on there: Cloudflare asks for a card even on the free plan."
          />
          <Fact
            icon={<LaptopIcon className="size-4" />}
            title={copies ? "This Mac keeps its library" : "This Mac keeps working as it does now"}
            body={
              copies
                ? "It stays where it is and isn’t changed while you use cloud. Switching back is one click, and changes you make in the cloud stay in the cloud."
                : "Captures still run on this Mac, and the cloud copy becomes the library you read everywhere."
            }
          />
          <Fact
            icon={<ShieldCheckIcon className="size-4" />}
            title="Captures stay local"
            body="Snip runs Playwright on this Mac. Cloud adds reading from your other devices and agent access, not remote capture."
          />
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>Continue to Cloudflare</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export type TurnOffChoice = "stay" | "detach" | "pull"

export function TurnOffDialog({
  open,
  onOpenChange,
  host,
  localCopy,
  initialChoice = "stay",
  onChoose,
  onCopyPrompt,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  host: string
  localCopy: string
  initialChoice?: TurnOffChoice
  onChoose: (choice: TurnOffChoice) => void
  onCopyPrompt: () => void
}) {
  const [choice, setChoice] = useState<TurnOffChoice>(initialChoice)
  useEffect(() => {
    if (open) setChoice(initialChoice)
  }, [open, initialChoice])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Turn off cloud?</DialogTitle>
          <DialogDescription>
            Changes made in your cloud library stay there. This Mac goes back to {localCopy}. Your cloud library is still reachable at {host}, and devices and agents
            signed in to it keep working.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Choice
            selected={choice === "stay"}
            onSelect={() => setChoice("stay")}
            title="Stay in cloud"
            body="Keep using the cloud library. Nothing changes."
          />
          <Choice
            selected={choice === "detach"}
            onSelect={() => setChoice("detach")}
            title="Turn off and keep local"
            body="This Mac goes back to its own library. Nothing is deleted, on this Mac or on Cloudflare."
          />
          <Choice
            selected={choice === "pull"}
            onSelect={() => setChoice("pull")}
            title="Bring the cloud library back to this Mac"
            body="Downloads the cloud library, checks every reference, then switches this Mac to it. This Mac's current library is kept."
          >
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">Recommended if you made changes</Badge>
              <Button variant="ghost" size="xs" onClick={onCopyPrompt} className="text-ink-11">
                <CopyIcon data-icon="inline-start" />
                Copy prompt for your agent
              </Button>
            </div>
          </Choice>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={choice === "stay"}
            variant={choice === "pull" ? "default" : "outline"}
            onClick={() => onChoose(choice)}
          >
            {choice === "pull" ? "Copy back now" : "Turn off cloud"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SignOutDialog({ open, onOpenChange, onConfirm }: { open: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Sign out all devices?</DialogTitle>
          <DialogDescription>
            Signs out browsers and this app. You'll sign in again with your passkey. Agents that already have access keep it until their token expires, up to 7
            days.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>Sign out all devices</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteResourcesDialog({
  open,
  onOpenChange,
  host,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  host: string
  onConfirm: () => void
}) {
  const [value, setValue] = useState("")
  useEffect(() => {
    if (open) setValue("")
  }, [open])
  // With no cloud library on record there is nothing to name, so nothing to confirm.
  const matches = host !== "" && value.trim().toLowerCase() === host.toLowerCase()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlertIcon className="size-4 text-(--red-11)" />
            Delete cloud resources?
          </DialogTitle>
          <DialogDescription>
            This deletes the Worker, database, KV and stored screenshots from your Cloudflare account. Devices and agents lose access. It can't be undone, and
            this Mac's snapshot is not affected.
          </DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Type <span className="font-mono text-foreground">{host}</span> to confirm
          </span>
          <Input autoFocus value={value} onChange={event => setValue(event.target.value)} spellCheck={false} autoComplete="off" aria-label="Cloud library address" />
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive-confirm" disabled={!matches} onClick={onConfirm}>
            <Trash2Icon data-icon="inline-start" />
            Delete cloud resources
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SnapshotDeleteDialog({ open, onOpenChange, label, onConfirm }: { open: boolean; onOpenChange: (open: boolean) => void; label: string; onConfirm: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Delete the previous library?</DialogTitle>
          <DialogDescription>
            {label} is removed from this Mac. Your cloud library is not affected, and this can’t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive-confirm" onClick={onConfirm}>
            Delete previous library
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ExportDeleteDialog({ open, onOpenChange, onConfirm }: { open: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Delete this export?</DialogTitle>
          <DialogDescription>
            The database dump and file list from setup are removed from this Mac. It can’t be used to restore anything, so deleting it does not affect either
            library.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive-confirm" onClick={onConfirm}>
            Delete export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AbortSetupDialog({ open, onOpenChange, onConfirm }: { open: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Undo this setup?</DialogTitle>
          <DialogDescription>
            Snip removes anything it created for the unfinished cloud copy and this Mac goes back to its local library. Your references and screenshots here are not
            touched, and nothing already in Cloudflare from another Snip is deleted.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep setup
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Undo setup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The owner link is the only way in for a browser that has no passkey yet, so this
 * sheet shows the URL itself: it is meant to be opened, not hidden (contracts §4.2).
 * The session token behind it never reaches this window.
 */
export function OwnerLinkDialog({
  open,
  onOpenChange,
  link,
  pending,
  error,
  copied,
  onCreate,
  onOpen,
  onCopy,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  link: OwnerLink | null
  pending: boolean
  error: string | null
  copied: boolean
  onCreate: () => void
  onOpen: (url: string) => void
  onCopy: (url: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Sign in another browser</DialogTitle>
          <DialogDescription>Open this link in the browser you want to sign in, on this Mac or any other device.</DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg bg-fill-2 px-3 py-2.5">
              <div className="mb-1.5 flex items-center gap-2">
                {/* "Link ready", never "Signed in": this run cannot see the other device. */}
                <Badge variant="success">Link ready</Badge>
              </div>
              <p className="select-all break-all font-mono text-xs leading-[1.5] text-foreground">{link.url}</p>
            </div>
            <p className="flex items-start gap-2 text-xs leading-[1.5] text-muted-foreground">
              <Clock className="mt-px size-3.5 shrink-0" />
              {link.note}
            </p>
          </div>
        ) : error ? (
          <p className="rounded-lg bg-fill-2 px-3 py-2.5 text-sm leading-[1.5]">{error}</p>
        ) : (
          <p className="rounded-lg bg-fill-2 px-3 py-2.5 text-sm leading-[1.5] text-muted-foreground">
            {pending ? "Creating a sign-in link…" : "No link yet."}
          </p>
        )}
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" onClick={onCreate} disabled={pending}>
            {link ? "Create a new link" : "Try again"}
          </Button>
          <div className="flex gap-2">
            {link ? (
              <Button variant="outline" onClick={() => onCopy(link.url)} aria-live="polite">
                {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            ) : null}
            <Button disabled={!link} onClick={() => link && onOpen(link.url)}>
              <GlobeIcon data-icon="inline-start" />
              Open in browser
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function Fact({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-fill-2 text-ink-10">{icon}</span>
      <div className="min-w-0">
        <div className="text-sm leading-5">{title}</div>
        <p className="mt-0.5 text-xs leading-[1.5] text-muted-foreground">{body}</p>
      </div>
    </li>
  )
}

function Choice({
  selected,
  onSelect,
  title,
  body,
  children,
}: {
  selected: boolean
  onSelect: () => void
  title: string
  body: string
  children?: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "rounded-xl px-3.5 py-3 text-left transition-[background-color,box-shadow] duration-150 ease-out",
        selected ? "bg-fill-2 shadow-[0_0_0_1px_var(--ink-7)]" : "hover:bg-fill-2/70",
      )}
    >
      <span className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-1 grid size-3.5 shrink-0 place-items-center rounded-full transition-colors duration-150",
            selected ? "bg-primary" : "shadow-[inset_0_0_0_1px_var(--ink-8)]",
          )}
        >
          {selected ? <span className="size-1.5 rounded-full bg-primary-foreground" /> : null}
        </span>
        <span className="min-w-0">
          <span className="block text-sm leading-5">{title}</span>
          <span className="mt-0.5 block text-xs leading-[1.5] text-muted-foreground">{body}</span>
          {children}
        </span>
      </span>
    </button>
  )
}
