import { useRef, useState } from "react"
import { FolderPlusIcon } from "@/components/icons"
import { toast } from "sonner"
import { CollectionPicker } from "@/components/collection-picker"
import { notify } from "@/components/notify"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { api, type Page } from "@/lib/api"
import { useCollections } from "@/lib/collections"
import { cn } from "@/lib/utils"

const pagesLabel = (n: number) => (n === 1 ? "1 page" : `${n} pages`)

/**
 * Save one or more pages to collections. A saved page stays in its website and can be in any
 * number of collections; collections point at the same stored screenshots, nothing is copied.
 * A collection shows as checked when every given page is already in it.
 */
export function SavePagesButton({
  pages,
  onChange,
  label = "Add to collection",
  className,
}: {
  pages: Page[]
  onChange: (pageIds: string[], collectionId: string, member: boolean) => void
  label?: string
  className?: string
}) {
  const { collections, refresh } = useCollections()
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const ids = pages.map((p) => p.id)
  const selected = pages.length ? collections.filter((c) => pages.every((p) => p.collectionIds.includes(c.id))).map((c) => c.id) : []

  const toggle = async (cid: string, member: boolean) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    const name = collections.find((c) => c.id === cid)?.name ?? "the new collection"
    // Only pages whose membership actually changes, so a failed save rolls back just those.
    const changing = pages.filter((p) => p.collectionIds.includes(cid) !== member).map((p) => p.id)
    onChange(changing, cid, member)
    try {
      await api.setPageMembership(cid, ids, member)
      const n = changing.length || ids.length
      notify(member ? `Added ${pagesLabel(n)} to ${name}` : `Removed ${pagesLabel(n)} from ${name}`)
    } catch (err) {
      onChange(changing, cid, !member)
      toast.error((err as Error).message)
      return
    } finally {
      pending.current = false
      setBusy(false)
    }
    // A successful save must not be rolled back if refreshing counts fails.
    await refresh().catch(() => toast.error("Pages saved, but collection counts could not refresh."))
  }

  return (
    <Popover>
      <PopoverTrigger
        disabled={!pages.length}
        className={cn(
          "flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium whitespace-nowrap ring-1 ring-border transition-colors hover:bg-fill-1 disabled:opacity-40 data-popup-open:bg-fill-1",
          className,
        )}
      >
        <FolderPlusIcon className="size-3.5" />
        <span>{label}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 rounded-3xl p-3">
        <p className="px-2 pb-2 text-2xs text-muted-foreground">
          {pages.length === 1 ? "This page stays in its website too." : `${pagesLabel(pages.length)}. They stay in their website too.`}
        </p>
        <fieldset disabled={busy} aria-busy={busy} className="min-w-0 border-0 p-0 disabled:opacity-60">
          <CollectionPicker className="max-h-72" selected={selected} onToggle={(cid, on) => void toggle(cid, on)} />
        </fieldset>
      </PopoverContent>
    </Popover>
  )
}
