import { useEffect, useMemo, useState } from "react"
import { useLocation } from "wouter"
import { ClipboardIcon, CornerDownLeftIcon, FileIcon, GlobeIcon, NetworkIcon, XIcon } from "lucide-react"
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
      <DialogContent showCloseButton={false} className="flex max-h-[calc(100svh-2rem)] flex-col gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-[440px]">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <div className="flex items-center justify-between px-5 pt-4 pb-3">
            <DialogTitle className="text-sm font-medium">New reference</DialogTitle>
            <DialogDescription className="sr-only">Paste a website; your capture agent saves screenshots, styles and animations.</DialogDescription>
            <DialogClose className="-mr-1.5 grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-fill-2 hover:text-foreground" aria-label="Close">
              <XIcon className="size-4" />
            </DialogClose>
          </div>

          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-4">
            {/* URL */}
            <div>
              <label className="flex h-14 items-center gap-3 rounded-2xl bg-fill-1 px-4 ring-1 ring-transparent transition-shadow focus-within:bg-background focus-within:ring-border focus-within:shadow-xs">
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
                  className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
                />
                {url ? (
                  <button type="button" onClick={() => setUrl("")} aria-label="Clear" className="grid size-6 place-items-center rounded-full bg-fill-3 text-muted-foreground">
                    <XIcon className="size-3" />
                  </button>
                ) : (
                  <button type="button" onClick={paste} className="flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground ring-1 ring-border hover:text-foreground">
                    <ClipboardIcon className="size-3" /> Paste
                  </button>
                )}
              </label>
              <p className={cn("mt-1.5 h-4 px-1 text-2xs text-muted-foreground", url && !parsed && "text-destructive-foreground")}>
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
                    "flex flex-col items-center gap-1.5 rounded-2xl bg-fill-1 px-3 py-4 text-center ring-1 ring-transparent transition-all hover:bg-fill-2",
                    mode === m.value && "bg-background ring-2 ring-foreground hover:bg-background",
                  )}
                >
                  <m.icon className="size-4" />
                  <span className="text-sm font-medium">{m.title}</span>
                  <span className="text-2xs text-muted-foreground">{m.description}</span>
                </button>
              ))}
            </div>

            {mode === "crawl" && (
              <div className="flex items-center gap-2.5 px-1">
                <span className="text-xs text-muted-foreground">Up to</span>
                <div className="flex rounded-full bg-fill-1 p-0.5">
                  {LIMITS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setMaxPages(n)}
                      className={cn(
                        "h-7 min-w-11 rounded-full px-2.5 text-xs font-medium text-muted-foreground tabular-nums",
                        maxPages === n && "bg-background text-foreground shadow-xs ring-1 ring-border",
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">pages</span>
              </div>
            )}

            {/* Collections */}
            <div className="flex min-h-0 flex-col gap-1.5">
              <span className="px-1 text-2xs font-medium text-muted-foreground">Save to</span>
              <CollectionPicker
                className="max-h-56"
                selected={selected}
                onToggle={(id, on) => setSelected((s) => (on ? [...new Set([...s, id])] : s.filter((x) => x !== id)))}
              />
            </div>
          </div>

          <div className="border-t border-border p-3">
            <button
              type="submit"
              disabled={!parsed || submitting}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-full bg-foreground text-sm font-medium text-background transition-colors hover:bg-foreground/85 disabled:bg-fill-2 disabled:text-muted-foreground"
            >
              {submitting ? <Spinner className="size-4" /> : null}
              {mode === "crawl" ? "Crawl and save" : "Save reference"}
              {!submitting && parsed && <CornerDownLeftIcon className="size-3.5 opacity-50" />}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
