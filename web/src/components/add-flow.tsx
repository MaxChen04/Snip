import { createContext, useContext, useState, type ReactNode } from "react"
import { useLocation } from "wouter"
import { XIcon } from "lucide-react"
import { toast } from "sonner"
import { AddReferenceDialog } from "@/components/add-reference-dialog"
import { ConnectMcpDialog } from "@/components/connect-mcp-dialog"
import { notify } from "@/components/notify"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { api } from "@/lib/api"
import { useCollections } from "@/lib/collections"

// One place that owns the "Create" dialogs so the top bar, collection header and empty
// states on any page open the same flow.

type Ctx = { addReference: (collectionId?: string, url?: string) => void; newCollection: () => void; connectMcp: () => void }
const AddFlowCtx = createContext<Ctx>({ addReference: () => {}, newCollection: () => {}, connectMcp: () => {} })
export const useAddFlow = () => useContext(AddFlowCtx)

export function AddFlowProvider({ children }: { children: ReactNode }) {
  const [adding, setAdding] = useState<{ collection?: string; url?: string; n: number } | null>(null)
  const [naming, setNaming] = useState(false)
  const [connecting, setConnecting] = useState(false)
  return (
    <AddFlowCtx.Provider
      value={{
        addReference: (collection, url) => setAdding((a) => ({ collection, url, n: (a?.n ?? 0) + 1 })),
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
        onAdded={() => {
          setAdding(null)
          window.dispatchEvent(new Event("rs:reload"))
        }}
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
      <DialogContent showCloseButton={false} className="gap-0 rounded-3xl p-0 sm:max-w-[400px]">
        <form onSubmit={submit}>
          <div className="flex items-center justify-between px-5 pt-4 pb-3">
            <DialogTitle className="text-sm font-medium">New collection</DialogTitle>
            <DialogDescription className="sr-only">Name a collection to group references.</DialogDescription>
            <DialogClose className="-mr-1.5 grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-fill-2 hover:text-foreground" aria-label="Close">
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
              className="h-14 w-full rounded-2xl bg-fill-1 px-4 text-base outline-none ring-1 ring-transparent placeholder:text-muted-foreground focus:bg-background focus:ring-border focus:shadow-xs"
            />
          </div>
          <div className="border-t border-border p-3">
            <button
              type="submit"
              disabled={!name.trim() || busy}
              className="h-11 w-full rounded-full bg-foreground text-sm font-medium text-background hover:bg-foreground/85 disabled:bg-fill-2 disabled:text-muted-foreground"
            >
              Create collection
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
