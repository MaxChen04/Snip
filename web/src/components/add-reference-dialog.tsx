import { useEffect, useMemo, useState } from "react"
import { useLocation } from "wouter"
import { ClipboardIcon, CornerDownLeftIcon, FileIcon, GlobeIcon, NetworkIcon, XIcon } from "@/components/icons"
import { toast } from "sonner"
import { CollectionPicker } from "@/components/collection-picker"
import { notify } from "@/components/notify"
import { Dialog, DialogContent, DialogTitle, DialogClose, DialogDescription } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { api, type CaptureMode, type Reference } from "@/lib/api"
import { cn } from "@/lib/utils"

const MODES: { value: CaptureMode; title: string; description: string; icon: typeof FileIcon }[] = [
  { value: "single", title: "Single page", description: "Just this URL", icon: FileIcon },
  { value: "crawl", title: "Crawl site", description: "Follow same-domain links", icon: NetworkIcon },
]
const LIMITS = [10, 25, 50, 100]

/** Accepts "linear.app" or a full URL; returns null until it looks like a real host. */
export function parseSiteUrl(raw: string): URL | null {
  const s = raw.trim()
  if (!s) return null
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`)
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null
    return u
  } catch {
    return null
  }
}

function Favicon({ host }: { host?: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [host])
  if (!host || broken) return <GlobeIcon className="size-5 text-muted-foreground" />
  return <img src={`https://icons.duckduckgo.com/ip3/${host}.ico`} alt="" onError={() => setBroken(true)} className="size-5 rounded-[5px]" />
}

export function AddReferenceDialog({
  open,
  onOpenChange,
  onAdded,
  defaultCollection,
  defaultUrl,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onAdded: (r: Reference) => void
  defaultCollection?: string
  defaultUrl?: string
}) {
  const [, navigate] = useLocation()
  const [url, setUrl] = useState(defaultUrl ?? "")
  const [mode, setMode] = useState<CaptureMode>("single")
  const [maxPages, setMaxPages] = useState(25)
  const [selected, setSelected] = useState<string[]>(defaultCollection ? [defaultCollection] : [])
  const [submitting, setSubmitting] = useState(false)
  const parsed = useMemo(() => parseSiteUrl(url), [url])

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!parsed || submitting) return
    setSubmitting(true)
    try {
      const ref = await api.addReference({ url: parsed.href, mode, maxPages: mode === "crawl" ? maxPages : 1, collectionIds: selected })
      setUrl("")
      onAdded(ref)
      notify(mode === "crawl" ? `Crawling ${parsed.hostname}` : "Added 1 reference", {
        action: { label: "View", onClick: () => navigate(`/r/${ref.id}`) },
      })
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const paste = async () => {
    try {
      setUrl((await navigator.clipboard.readText()).trim())
    } catch {
      /* clipboard blocked: the field is still focusable */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="flex max-h-[calc(100svh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[460px]">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <div className="flex items-center justify-between px-5 pt-5 pb-4">
            <DialogTitle className="text-base font-medium">New reference</DialogTitle>
            <DialogDescription className="sr-only">Paste a website; your capture agent saves screenshots, styles and animations.</DialogDescription>
            <DialogClose className="press -mr-1.5 grid size-7 place-items-center rounded-md text-ink-10 hover:bg-ink-3 hover:text-foreground active:scale-[0.92]" aria-label="Close">
              <XIcon className="size-4" />
            </DialogClose>
          </div>

          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-4">
            {/* URL */}
            <div>
              <label className="well flex h-12 items-center gap-3 rounded-lg px-3.5">
                <Favicon host={parsed?.hostname} />
                <input
                  autoFocus
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Website URL"
                  placeholder="Paste a website URL"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-ink-10"
                />
                {url ? (
                  <button type="button" onClick={() => setUrl("")} aria-label="Clear" className="press grid size-6 place-items-center rounded-full bg-control text-ink-10 shadow-button hover:text-foreground active:scale-[0.92]">
                    <XIcon className="size-3" />
                  </button>
                ) : (
                  <button type="button" onClick={paste} className="tactile press flex h-7 items-center gap-1 rounded-full pr-2.75 pl-2.25 text-xs font-medium">
                    <ClipboardIcon className="size-3.5 text-ink-9" /> Paste
                  </button>
                )}
              </label>
              <p className={cn("mt-1.5 h-4 px-1 text-2xs text-ink-10", url && !parsed && "text-(--red-11)")}>
                {url && !parsed
                  ? "Enter a full domain like linear.app"
                  : mode === "crawl"
                    ? `Follows links on ${parsed?.hostname ?? "the same domain"}, desktop and mobile`
                    : "Desktop and mobile screenshots, styles and motion"}
              </p>
            </div>

            {/* Mode */}
            <div role="radiogroup" aria-label="Capture" className="grid grid-cols-2 gap-2">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.value}
                  onClick={() => setMode(m.value)}
                  className={cn(
                    "press relative flex flex-col items-start gap-0.5 rounded-lg bg-ink-2 p-3 text-left transition-colors hover:bg-ink-3 active:scale-[0.99] dark:bg-ink-3 dark:hover:bg-ink-4",
                    mode === m.value && "bg-ink-3 dark:bg-ink-4 dark:shadow-[0_0_0_0.5px_var(--ink-8)]",
                  )}
                >
                  <m.icon className="mb-2 size-4 text-ink-11" />
                  <span className="text-xs font-medium">{m.title}</span>
                  <span className="text-2xs text-ink-11">{m.description}</span>
                  {/* The filled mark, not the fill, tells selected from hovered. */}
                  <span
                    aria-hidden
                    className={cn(
                      "absolute top-3 right-3 grid size-[18px] place-items-center rounded-full ring-[1.5px] ring-ink-6 ring-inset",
                      mode === m.value && "bg-surface-top ring-0 shadow-button dark:bg-ink-6",
                    )}
                  >
                    {mode === m.value && <span className="size-2 rounded-full bg-ink-12" />}
                  </span>
                </button>
              ))}
            </div>

            {mode === "crawl" && (
              <div className="flex items-center gap-2.5 px-1">
                <span className="text-xs text-ink-11">Up to</span>
                <div className="tactile-track flex">
                  {LIMITS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setMaxPages(n)}
                      className={cn(
                        "press h-7 min-w-11 rounded-full px-2.5 text-xs font-medium text-ink-11 tabular-nums hover:text-foreground",
                        maxPages === n && "tactile-chosen",
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <span className="text-xs text-ink-11">pages</span>
              </div>
            )}

            {/* Collections */}
            <div className="flex min-h-0 flex-col gap-1.5">
              <span className="px-1 text-xs font-medium text-ink-11">Save to</span>
              <CollectionPicker
                className="max-h-56"
                selected={selected}
                onToggle={(id, on) => setSelected((s) => (on ? [...new Set([...s, id])] : s.filter((x) => x !== id)))}
              />
            </div>
          </div>

          <div className="flex justify-between gap-3 border-t-[0.5px] border-border p-3">
            <DialogClose type="button" className="tactile press h-8 rounded-lg px-3.5 text-xs font-medium tracking-[-0.01em]">
              Cancel
            </DialogClose>
            <button
              type="submit"
              disabled={!parsed || submitting}
              className="press flex h-8 items-center justify-center gap-2 rounded-lg bg-primary pr-2 pl-3.5 text-xs font-medium tracking-[-0.01em] text-primary-foreground shadow-primary hover:bg-(--primary-hover) disabled:opacity-60 disabled:active:scale-100 dark:disabled:bg-ink-4 dark:disabled:text-ink-8 dark:disabled:opacity-100 dark:disabled:shadow-none"
            >
              {submitting ? <Spinner className="size-3.5" /> : null}
              {submitting ? "Saving…" : mode === "crawl" ? "Crawl and save" : "Save reference"}
              {!submitting && (
                <kbd className="grid size-[18px] place-items-center rounded-xs bg-primary-foreground/15">
                  <CornerDownLeftIcon className="size-3" />
                </kbd>
              )}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
