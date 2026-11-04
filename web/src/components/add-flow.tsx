import { createContext, useContext, useState, type ReactNode } from "react"
import { useLocation } from "wouter"
import { XIcon } from "@/components/icons"
import { toast } from "sonner"
import { AddReferenceDialog } from "@/components/add-reference-dialog"
import { notify } from "@/components/notify"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { api } from "@/lib/api"
import { useCollections } from "@/lib/collections"

// One place that owns the "Create" dialogs so the top bar, collection header and empty
// states on any page open the same flow.

type Ctx = { addReference: (collectionId?: string, url?: string) => void; newCollection: () => void }
const AddFlowCtx = createContext<Ctx>({ addReference: () => {}, newCollection: () => {} })
export const useAddFlow = () => useContext(AddFlowCtx)

export function AddFlowProvider({ children }: { children: ReactNode }) {
  const [adding, setAdding] = useState<{ collection?: string; url?: string; n: number } | null>(null)
  const [naming, setNaming] = useState(false)
  return (
    <AddFlowCtx.Provider value={{ addReference: (collection, url) => setAdding((a) => ({ collection, url, n: (a?.n ?? 0) + 1 })), newCollection: () => setNaming(true) }}>
      {children}
      <AddReferenceDialog
        key={adding ? `${adding.collection}-${adding.n}` : "closed"}
        open={!!adding}
        defaultCollection={adding?.collection}
        defaultUrl={adding?.url}
        onOpenChange={(o) => !o && setAdding(null)}
        onAdded={() => {
          setAdding(null)
          window.dispatchEvent(new Event("rs:reload"))
        }}
      />
      <NewCollectionDialog open={naming} onOpenChange={setNaming} />
    </AddFlowCtx.Provider>
  )
}

function NewCollectionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { refresh } = useCollections()
  const [, navigate] = useLocation()
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      const { id } = await api.createCollection(name.trim())
      await refresh()
      onOpenChange(false)
      notify(`Created “${name.trim()}”`)
      setName("")
      navigate(`/?collection=${id}`)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-[400px]">
        <form onSubmit={submit}>
          <div className="flex items-center justify-between px-5 pt-5 pb-4">
            <DialogTitle className="text-base font-medium">New collection</DialogTitle>
            <DialogDescription className="sr-only">Name a collection to group references.</DialogDescription>
            <DialogClose className="press -mr-1.5 grid size-7 place-items-center rounded-md text-ink-10 hover:bg-ink-3 hover:text-foreground active:scale-[0.92]" aria-label="Close">
              <XIcon className="size-4" />
            </DialogClose>
          </div>
          <div className="px-5 pb-5">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Pricing pages"
              aria-label="Collection name"
              className="well h-10 w-full rounded-lg px-3 text-sm outline-none placeholder:text-ink-10 focus:bg-ink-4 pointer-coarse:text-base"
            />
          </div>
          <div className="flex justify-between gap-3 border-t-[0.5px] border-border p-3">
            <DialogClose type="button" className="tactile press h-8 rounded-lg px-3.5 text-xs font-medium tracking-[-0.01em]">
              Cancel
            </DialogClose>
            <button
              type="submit"
              disabled={!name.trim() || busy}
              className="press h-8 rounded-lg bg-primary px-3.5 text-xs font-medium tracking-[-0.01em] text-primary-foreground shadow-primary hover:bg-(--primary-hover) disabled:opacity-60 disabled:active:scale-100 dark:disabled:bg-ink-4 dark:disabled:text-ink-8 dark:disabled:opacity-100 dark:disabled:shadow-none"
            >
              {busy ? "Creating…" : "Create collection"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
