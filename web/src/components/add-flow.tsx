import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useLocation } from "wouter"
import { XIcon } from "@/components/icons"
import { toast } from "sonner"
import { AddReferenceDialog, extractUrls } from "@/components/add-reference-dialog"
import { trackCapture } from "@/components/canvas/capture-card"
import { ConnectMcpDialog } from "@/components/connect-mcp-dialog"
import { notify } from "@/components/notify"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { api } from "@/lib/api"
import { useCollections } from "@/lib/collections"
import { MAX_NAME } from "../../shared/types"

// One place that owns the "Create" dialogs so the top bar, board views and empty
// states on any page open the same flow.

type Ctx = { addReference: (collectionId?: string, url?: string) => void; newCollection: () => void; connectMcp: () => void }
const AddFlowCtx = createContext<Ctx>({ addReference: () => {}, newCollection: () => {}, connectMcp: () => {} })
export const useAddFlow = () => useContext(AddFlowCtx)

/** True while the user is typing somewhere, so global shortcuts stay out of the way. */
const typing = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
}
const dialogOpen = () => !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')
/** The board being viewed (/b/:id, or the older /?collection=:id), so new material lands on it. */
const currentBoard = () =>
  window.location.pathname.match(/^\/b\/([^/]+)/)?.[1] ?? new URLSearchParams(window.location.search).get("collection") ?? undefined

export function AddFlowProvider({ children }: { children: ReactNode }) {
  const [adding, setAdding] = useState<{ collection?: string; url?: string; n: number } | null>(null)
  const [naming, setNaming] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [location, navigate] = useLocation()
  const open = (collection?: string, url?: string) => setAdding((a) => ({ collection, url, n: (a?.n ?? 0) + 1 }))

  // The bookmarklet sends the current tab to /add?url=…
  useEffect(() => {
    // Checks the real URL so a repeated effect (React strict mode) can't open it twice.
    if (location !== "/add" || window.location.pathname !== "/add") return
    const url = new URLSearchParams(window.location.search).get("url") ?? undefined
    navigate("/", { replace: true })
    open(undefined, url)
  }, [location, navigate])

  // Paste a URL anywhere in the app to add it; "/" jumps to search.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // The canvas capture card takes its own pastes (data-capture-input).
      if (typing(e.target) || (e.target as Element | null)?.closest?.("[data-capture-input]") || dialogOpen()) return
      const text = e.clipboardData?.getData("text") ?? ""
      if (!extractUrls(text).length) return
      e.preventDefault()
      open(currentBoard(), text)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || dialogOpen()) return
      const search = document.querySelector<HTMLInputElement>("[data-search]")
      if (!search) return
      e.preventDefault()
      search.focus()
      search.select()
    }
    window.addEventListener("paste", onPaste)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("paste", onPaste)
      window.removeEventListener("keydown", onKey)
    }
  }, [])

  return (
    <AddFlowCtx.Provider
      value={{
        addReference: open,
        newCollection: () => setNaming(true),
        connectMcp: () => setConnecting(true),
      }}
    >
      {children}
      <AddReferenceDialog
        key={adding ? `${adding.collection}-${adding.n}` : "closed"}
        open={!!adding}
        defaultCollection={adding?.collection}
        defaultUrl={adding?.url}
        onOpenChange={(o) => !o && setAdding(null)}
        // Captures started here show on the canvas capture card too.
        onCreated={(r) => trackCapture(r.id)}
      />
      <NewCollectionDialog open={naming} onOpenChange={setNaming} />
      <ConnectMcpDialog open={connecting} onOpenChange={setConnecting} />
    </AddFlowCtx.Provider>
  )
}

function NewCollectionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { refresh } = useCollections()
  const [, navigate] = useLocation()
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      const { id } = await api.createCollection(name.trim())
      // The board exists now; a list that fails to reload is not a failed create.
      await refresh().catch(() => {})
      onOpenChange(false)
      notify(`Created board “${name.trim()}”`)
      setName("")
      navigate(`/b/${id}`)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={field} showCloseButton={false} className="gap-0 p-0 sm:max-w-[400px]">
        <form onSubmit={submit}>
          <div className="flex items-center justify-between px-5 pt-5 pb-4">
            <DialogTitle className="text-base font-medium">New board</DialogTitle>
            <DialogDescription className="sr-only">Name a board to group saves by project or mood.</DialogDescription>
            <DialogClose className="press -mr-1.5 grid size-7 place-items-center rounded-md text-ink-10 hover:bg-ink-3 hover:text-foreground active:scale-[0.92]" aria-label="Close">
              <XIcon className="size-4" />
            </DialogClose>
          </div>
          <div className="px-5 pb-5">
            <input
              ref={field}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Pricing pages"
              aria-label="Board name"
              maxLength={MAX_NAME}
              className="well h-10 w-full rounded-lg px-3 text-sm outline-none placeholder:text-ink-10 focus:bg-ink-4 pointer-coarse:text-base"
            />
          </div>
          <div className="border-t-[0.5px] border-border p-3">
            <button
              type="submit"
              disabled={!name.trim() || busy}
              className="press h-10 w-full rounded-lg bg-primary px-3.5 text-sm font-medium tracking-[-0.01em] text-primary-foreground shadow-primary hover:bg-(--primary-hover) disabled:opacity-60 disabled:active:scale-100 dark:disabled:bg-ink-4 dark:disabled:text-ink-8 dark:disabled:opacity-100 dark:disabled:shadow-none"
            >
              {busy ? "Creating…" : "Create board"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
