import { CheckIcon, SparklesIcon, XIcon } from "lucide-react"
import { notify } from "@/components/notify"
import { buildAgentPrompt } from "@/lib/agent-prompt"
import type { Animation, Page, Reference } from "@/lib/api"
import { cn } from "@/lib/utils"

export interface Selection {
  pages: string[]
  animations: string[]
  tokens: boolean
}
export const EMPTY_SELECTION: Selection = { pages: [], animations: [], tokens: false }
export const selectionSize = (s: Selection) => s.pages.length + s.animations.length + (s.tokens ? 1 : 0)
export const toggleIn = (xs: string[], id: string) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id])

/** Round check in a tile's corner. Visible on hover, or always while selecting. */
export function SelectCheck({ on, active, onToggle, label }: { on: boolean; active: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        "absolute top-2 left-2 z-10 grid size-6 place-items-center rounded-full bg-background/90 shadow-sm ring-1 ring-black/10 backdrop-blur transition-opacity",
        on ? "bg-foreground text-background opacity-100 ring-foreground" : active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
      )}
    >
      {on && <CheckIcon className="size-3.5" strokeWidth={3} />}
    </button>
  )
}

/** Compact bar on the tabs row: what's selected, a tokens toggle, and "Copy prompt". */
export function SelectionBar({
  reference,
  pages,
  animations,
  selection,
  onChange,
  onDone,
}: {
  reference: Reference
  pages: Page[]
  animations: Animation[]
  selection: Selection
  onChange: (s: Selection) => void
  onDone: () => void
}) {
  const n = selectionSize(selection)
  const parts = [
    selection.pages.length && `${selection.pages.length} ${selection.pages.length === 1 ? "page" : "pages"}`,
    selection.animations.length && `${selection.animations.length} ${selection.animations.length === 1 ? "animation" : "animations"}`,
  ].filter(Boolean)

  const copy = async () => {
    const prompt = buildAgentPrompt(
      {
        reference,
        pages: pages.filter((p) => selection.pages.includes(p.id)),
        animations: animations.filter((a) => selection.animations.includes(a.id)),
        tokens: selection.tokens,
      },
      pages,
    )
    try {
      await navigator.clipboard.writeText(prompt)
      notify("Prompt copied. Paste it into your agent chat")
    } catch {
      // Clipboard blocked (e.g. insecure origin): fall back to a prompt dialog the user can copy from.
      window.prompt("Copy this prompt", prompt)
    }
  }

  return (
    <div className="flex h-10 max-w-full items-center gap-0.5 rounded-full bg-neutral-900 p-1 text-xs text-white shadow-md ring-1 ring-white/10 dark:bg-neutral-100 dark:text-neutral-900 dark:ring-black/10">
        <button onClick={onDone} aria-label="Done selecting" className="grid size-8 shrink-0 place-items-center rounded-full hover:bg-white/10 dark:hover:bg-black/10">
          <XIcon className="size-4" />
        </button>
        <span className="truncate px-1 font-medium whitespace-nowrap">{parts.length ? parts.join(" · ") : n ? "Tokens only" : "Pick items"}</span>
        <button
          onClick={() => onChange({ ...selection, tokens: !selection.tokens })}
          aria-pressed={selection.tokens}
          className={cn(
            "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium",
            selection.tokens ? "bg-white/20 dark:bg-black/15" : "text-white/60 hover:text-white dark:text-neutral-500 dark:hover:text-neutral-900",
          )}
        >
          {selection.tokens ? <CheckIcon className="size-3.5" /> : <span className="size-3.5 rounded-full ring-1 ring-current" />}
          Tokens
        </button>
        <button
          onClick={copy}
          disabled={!n}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white px-3.5 text-xs font-medium text-neutral-900 hover:bg-white/90 disabled:opacity-40 dark:bg-neutral-900 dark:text-white"
        >
          <SparklesIcon className="size-3.5" /> Copy prompt
        </button>
    </div>
  )
}
