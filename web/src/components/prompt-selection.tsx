import { CheckIcon, SparklesIcon, XIcon } from "@/components/icons"
import { notify } from "@/components/notify"
import { buildAgentPrompt } from "@/lib/agent-prompt"
import { mcpUrl } from "@/lib/mcp"
import type { Animation, Page, Reference } from "@/lib/api"
import { cn } from "@/lib/utils"

export { EMPTY_SELECTION, pruneSelection, selectionSize, toggleIn, togglePage, withPageView, type Selection } from "@/lib/selection-state"
import { selectionSize, type Selection } from "@/lib/selection-state"

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
        "absolute top-2 left-2 z-10 grid size-6 place-items-center rounded-full bg-control shadow-button transition-[opacity,scale,background-color] duration-150 ease-out active:scale-[0.92]",
        on ? "bg-primary text-primary-foreground opacity-100 shadow-primary" : active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
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
        mcpUrl: mcpUrl(),
        views: selection.views,
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
    <div className="surface-raised flex h-10 max-w-full items-center gap-0.5 rounded-full bg-card p-1 text-xs shadow-card">
        <button onClick={onDone} aria-label="Done selecting" className="press grid size-8 shrink-0 place-items-center rounded-full text-ink-10 hover:bg-ink-3 hover:text-foreground active:scale-[0.92]">
          <XIcon className="size-4" />
        </button>
        <span className="truncate px-1 font-medium whitespace-nowrap">{parts.length ? parts.join(" · ") : n ? "Tokens only" : "Pick items"}</span>
        <button
          onClick={() => onChange({ ...selection, tokens: !selection.tokens })}
          aria-pressed={selection.tokens}
          className={cn(
            "press flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium",
            selection.tokens ? "bg-ink-4 text-foreground" : "text-ink-11 hover:bg-ink-3 hover:text-foreground",
          )}
        >
          {selection.tokens ? <CheckIcon className="size-3.5" /> : <span className="size-3.5 rounded-full ring-1 ring-current" />}
          Tokens
        </button>
        <button
          onClick={copy}
          disabled={!n}
          className="press flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary pr-3.5 pl-3 text-xs font-medium text-primary-foreground shadow-primary hover:bg-(--primary-hover) disabled:opacity-60 dark:disabled:bg-ink-4 dark:disabled:text-ink-8 dark:disabled:opacity-100 dark:disabled:shadow-none"
        >
          <SparklesIcon className="size-3.5" /> Copy prompt
        </button>
    </div>
  )
}
