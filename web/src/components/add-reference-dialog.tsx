import { useState } from "react"
import { FileIcon, NetworkIcon, PlusIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { api, type CaptureMode, type Reference } from "@/lib/api"
import { useCollections } from "@/lib/collections"
import { cn } from "@/lib/utils"

const MODES: { value: CaptureMode; title: string; description: string; icon: typeof FileIcon }[] = [
  { value: "single", title: "Static page", description: "Capture just this URL", icon: FileIcon },
  { value: "crawl", title: "Crawl site", description: "Follow links on the same domain", icon: NetworkIcon },
]

export function AddReferenceButton({ onAdded, defaultCollection }: { onAdded: (r: Reference) => void; defaultCollection?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <PlusIcon data-icon="inline-start" />
        Add reference
      </Button>
      <AddReferenceDialog
        open={open}
        onOpenChange={setOpen}
        defaultCollection={defaultCollection}
        onAdded={(r) => {
          setOpen(false)
          onAdded(r)
        }}
      />
    </>
  )
}

export function AddReferenceDialog({
  open,
  onOpenChange,
  onAdded,
  defaultCollection,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onAdded: (r: Reference) => void
  defaultCollection?: string
}) {
  const { collections } = useCollections()
  const [url, setUrl] = useState("")
  const [mode, setMode] = useState<CaptureMode>("single")
  const [maxPages, setMaxPages] = useState(25)
  const [selected, setSelected] = useState<string[]>(defaultCollection ? [defaultCollection] : [])
  const [submitting, setSubmitting] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim()) return
    setSubmitting(true)
    try {
      const ref = await api.addReference({ url, mode, maxPages: mode === "crawl" ? maxPages : 1, collectionIds: selected })
      toast.success("Reference queued", { description: "Your capture agent will pick it up shortly." })
      setUrl("")
      onAdded(ref)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-6">
          <DialogHeader>
            <DialogTitle>Add reference</DialogTitle>
            <DialogDescription>Paste a website you like. Screenshots, styles and animations are captured by your local agent.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="ref-url">Website URL</FieldLabel>
              <Input id="ref-url" autoFocus placeholder="https://linear.app" value={url} onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Capture</FieldLabel>
              <div role="radiogroup" className="grid grid-cols-2 gap-2">
                {MODES.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    aria-checked={mode === m.value}
                    onClick={() => setMode(m.value)}
                    className={cn(
                      "flex items-start gap-3 rounded-xl p-3 text-left outline-1 -outline-offset-1 outline-border transition-colors hover:bg-fill-1",
                      mode === m.value && "bg-fill-1 outline-2 outline-primary",
                    )}
                  >
                    <m.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="grid gap-0.5">
                      <span className="text-sm font-medium">{m.title}</span>
                      <span className="text-2xs text-muted-foreground">{m.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </Field>
            {mode === "crawl" && (
              <Field>
                <FieldLabel htmlFor="ref-max">Page limit</FieldLabel>
                <Input
                  id="ref-max"
                  type="number"
                  min={1}
                  max={200}
                  value={maxPages}
                  onChange={(e) => setMaxPages(Number(e.target.value) || 1)}
                  className="w-28"
                />
                <FieldDescription>Stays on the same domain. Each page gets desktop and mobile screenshots.</FieldDescription>
              </Field>
            )}
            {collections.length > 0 && (
              <Field>
                <FieldLabel>Collections</FieldLabel>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {collections.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={selected.includes(c.id)}
                        onCheckedChange={(v) => setSelected((s) => (v ? [...s, c.id] : s.filter((x) => x !== c.id)))}
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
              </Field>
            )}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!url.trim() || submitting}>
              {submitting ? "Adding…" : "Add reference"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
