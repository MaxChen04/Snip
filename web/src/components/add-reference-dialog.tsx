import { useEffect, useMemo, useState } from "react"
import { useLocation } from "wouter"
import { ChevronRightIcon, ClipboardIcon, CornerDownLeftIcon, FileIcon, GlobeIcon, NetworkIcon, XIcon } from "@/components/icons"
import { toast } from "sonner"
import { CollectionPicker } from "@/components/collection-picker"
import { notify } from "@/components/notify"
import { Dialog, DialogContent, DialogTitle, DialogClose, DialogDescription } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { api, DuplicateError, type CaptureMode, type CaptureOptions, type Reference } from "@/lib/api"
import { DESKTOP_WIDTHS } from "../../shared/types"
import { extractUrls, parseSiteUrl } from "@/lib/site-url"

export { extractUrls, parseSiteUrl }
import { cn } from "@/lib/utils"

const MODES: { value: CaptureMode; title: string; description: string; icon: typeof FileIcon }[] = [
  { value: "single", title: "Single page", description: "Just this URL", icon: FileIcon },
  { value: "crawl", title: "Crawl site", description: "Follow same-domain links", icon: NetworkIcon },
]
const LIMITS = [10, 25, 50, 100]

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
  onCreated,
  defaultCollection,
  defaultUrl,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** null after adding several websites at once. */
  onAdded: (r: Reference | null) => void
  /** Each reference as it is created, including the ones saved before a bulk add fails part way. */
  onCreated?: (r: Reference) => void
  defaultCollection?: string
  defaultUrl?: string
}) {
  const [, navigate] = useLocation()
  const initial = useMemo(() => extractUrls(defaultUrl ?? ""), [defaultUrl])
  const [url, setUrl] = useState(initial.length > 1 ? "" : (defaultUrl ?? ""))
  // Several pasted websites are added together, each as its own reference.
  const [bulk, setBulk] = useState<URL[]>(initial.length > 1 ? initial : [])
  const [mode, setMode] = useState<CaptureMode>("single")
  const [maxPages, setMaxPages] = useState(25)
  const [selected, setSelected] = useState<string[]>(defaultCollection ? [defaultCollection] : [])
  const [notes, setNotes] = useState("")
  const [showOptions, setShowOptions] = useState(false)
  const [colorScheme, setColorScheme] = useState<"light" | "dark">("light")
  const [desktopWidth, setDesktopWidth] = useState<number>(1440)
  const [signedIn, setSignedIn] = useState(false)
  const [duplicate, setDuplicate] = useState<Reference | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const parsed = useMemo(() => parseSiteUrl(url), [url])
  useEffect(() => setDuplicate(null), [url])

  const options: CaptureOptions = { colorScheme, desktopWidth, signedIn }
  const body = (u: URL, allowDuplicate = false) => ({
    url: u.href,
    mode,
    maxPages: mode === "crawl" ? maxPages : 1,
    collectionIds: selected,
    notes: notes.trim() || undefined,
    options,
    allowDuplicate,
  })

  const submitBulk = async () => {
    let added = 0
    let saved = 0
    const failed: URL[] = []
    let lastError = ""
    for (const u of bulk) {
      try {
        onCreated?.(await api.addReference(body(u)))
        added++
      } catch (err) {
        if (err instanceof DuplicateError) saved++
        else {
          failed.push(u)
          lastError = (err as Error).message
        }
      }
    }
    const summary = [added && `Added ${added} ${added === 1 ? "website" : "websites"}`, saved && `${saved} already saved`].filter(Boolean).join(", ")
    if (failed.length) {
      // Keep the ones that failed in the dialog so they can be retried as they were.
      setBulk(failed)
      if (added) window.dispatchEvent(new Event("rs:reload"))
      toast.error(`${summary ? `${summary}. ` : ""}${failed.length} couldn't be added: ${lastError}`)
      return
    }
    setBulk([])
    onAdded(null)
    notify(summary)
  }

  const submit = async (e?: React.FormEvent, allowDuplicate = false) => {
    e?.preventDefault()
    if (submitting || (!parsed && !bulk.length)) return
    setSubmitting(true)
    try {
      if (bulk.length) return await submitBulk()
      const ref = await api.addReference(body(parsed!, allowDuplicate))
      onCreated?.(ref)
      setUrl("")
      onAdded(ref)
      notify(mode === "crawl" ? `Crawling ${parsed!.hostname}` : "Added 1 reference", {
        action: { label: "View", onClick: () => navigate(`/r/${ref.id}`) },
      })
    } catch (err) {
      if (err instanceof DuplicateError) setDuplicate(err.existing)
      else toast.error((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  /** One URL fills the field; several switch to adding them all at once. */
  const take = (text: string) => {
    const found = extractUrls(text)
    if (found.length > 1) {
      setBulk(found)
      setUrl("")
      return true
    }
    setUrl(text.trim())
    return false
  }

  const paste = async () => {
    try {
      take(await navigator.clipboard.readText())
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
            {/* URL, or several pasted at once */}
            {bulk.length ? (
              <div className="well flex flex-col gap-2 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">{bulk.length} websites</span>
                  <button type="button" onClick={() => setBulk([])} className="press text-2xs text-ink-11 hover:text-foreground">
                    Clear
                  </button>
                </div>
                <ul className="flex max-h-32 flex-col gap-1.5 overflow-y-auto">
                  {bulk.map((u) => (
                    <li key={u.href} className="flex items-center gap-2 text-xs text-ink-11">
                      <Favicon host={u.hostname} />
                      <span className="truncate">{u.hostname + (u.pathname === "/" ? "" : u.pathname)}</span>
                      <button type="button" aria-label={`Remove ${u.hostname}`} onClick={() => setBulk((b) => b.filter((x) => x.href !== u.href))} className="press ml-auto grid size-5 shrink-0 place-items-center rounded-full text-ink-10 hover:text-foreground">
                        <XIcon className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="text-2xs text-ink-10">Each website becomes its own reference. Ones already saved are skipped.</p>
              </div>
            ) : (
            <div>
              <label className="well flex h-12 items-center gap-3 rounded-lg px-3.5">
                <Favicon host={parsed?.hostname} />
                <input
                  autoFocus
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Website URL"
                  placeholder="Paste one or more website URLs"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onPaste={(e) => {
                    const found = extractUrls(e.clipboardData.getData("text"))
                    if (found.length > 1) {
                      e.preventDefault()
                      setBulk(found)
                      setUrl("")
                    }
                  }}
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
              {duplicate ? (
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-ink-2 px-3 py-2 text-xs dark:bg-ink-3">
                  <span className="min-w-0 flex-1 truncate text-ink-11">
                    Already saved as <span className="font-medium text-foreground">{duplicate.title ?? duplicate.domain}</span>
                  </span>
                  <button type="button" onClick={() => { onOpenChange(false); navigate(`/r/${duplicate.id}`) }} className="tactile press h-7 rounded-full px-2.75 font-medium">
                    Open
                  </button>
                  <button type="button" onClick={() => submit(undefined, true)} className="press h-7 rounded-full px-2 font-medium text-ink-11 hover:text-foreground">
                    Capture again
                  </button>
                </div>
              ) : (
              <p className={cn("mt-1.5 h-4 px-1 text-2xs text-ink-10", url && !parsed && "text-(--red-11)")}>
                {url && !parsed
                  ? "Enter a full domain like linear.app"
                  : mode === "crawl"
                    ? `Follows links on ${parsed?.hostname ?? "the same domain"}, desktop and mobile`
                    : "Desktop and mobile screenshots, styles and motion"}
              </p>
              )}
            </div>
            )}

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

            {/* Note */}
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              rows={2}
              aria-label="Note"
              placeholder="Note (optional): what to borrow from it"
              className="well min-h-14 w-full resize-none rounded-lg px-3 py-2.5 text-sm outline-none placeholder:text-ink-10 pointer-coarse:text-base"
            />

            {/* Capture options */}
            <div className="flex flex-col gap-2.5">
              <button
                type="button"
                aria-expanded={showOptions}
                onClick={() => setShowOptions((o) => !o)}
                className="press flex items-center gap-1 self-start px-1 text-xs font-medium text-ink-11 hover:text-foreground"
              >
                <ChevronRightIcon className={cn("size-3.5 transition-transform", showOptions && "rotate-90")} />
                Capture options
                {!showOptions && (colorScheme === "dark" || desktopWidth !== 1440 || signedIn) && (
                  <span className="font-normal text-ink-10">
                    · {[colorScheme === "dark" && "Dark", desktopWidth !== 1440 && `${desktopWidth}px`, signedIn && "Signed in"].filter(Boolean).join(", ")}
                  </span>
                )}
              </button>
              {showOptions && (
                <div className="flex flex-col gap-2.5 px-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-ink-11">Color scheme</span>
                    <div className="tactile-track flex">
                      {(["light", "dark"] as const).map((v) => (
                        <button key={v} type="button" onClick={() => setColorScheme(v)} className={cn("press h-7 min-w-14 rounded-full px-2.5 text-xs font-medium text-ink-11 capitalize hover:text-foreground", colorScheme === v && "tactile-chosen")}>
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-ink-11">Desktop width</span>
                    <div className="tactile-track flex">
                      {DESKTOP_WIDTHS.map((w) => (
                        <button key={w} type="button" onClick={() => setDesktopWidth(w)} className={cn("press h-7 min-w-14 rounded-full px-2.5 text-xs font-medium text-ink-11 tabular-nums hover:text-foreground", desktopWidth === w && "tactile-chosen")}>
                          {w}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input type="checkbox" checked={signedIn} onChange={(e) => setSignedIn(e.target.checked)} className="mt-0.5 size-3.5 accent-(--ink-12)" />
                    <span className="grid">
                      <span className="text-xs">Use my saved sign-in</span>
                      <span className="text-2xs text-ink-10">For pages behind a login. Needs STORAGE_STATE in capture/.env.</span>
                    </span>
                  </label>
                </div>
              )}
            </div>

            {/* Boards */}
            <div className="flex min-h-0 flex-col gap-1.5">
              <span className="px-1 text-xs font-medium text-ink-11">Save to</span>
              <CollectionPicker
                className="max-h-56"
                selected={selected}
                onToggle={(id, on) => setSelected((s) => (on ? [...new Set([...s, id])] : s.filter((x) => x !== id)))}
              />
            </div>
          </div>

          <div className="border-t-[0.5px] border-border p-3">
            <button
              type="submit"
              disabled={(!parsed && !bulk.length) || submitting}
              className="press flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-medium tracking-[-0.01em] text-primary-foreground shadow-primary hover:bg-(--primary-hover) disabled:opacity-60 disabled:active:scale-100 dark:disabled:bg-ink-4 dark:disabled:text-ink-8 dark:disabled:opacity-100 dark:disabled:shadow-none"
            >
              {submitting ? <Spinner className="size-3.5" /> : null}
              {submitting ? "Saving…" : bulk.length ? `Save ${bulk.length} websites` : mode === "crawl" ? "Crawl and save" : "Save reference"}
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
