import { useId, useState } from "react"
import { Link } from "wouter"
import { motion, useReducedMotion } from "motion/react"
import { BookmarkIcon, ChevronDownIcon, KeyRound, LogOutIcon, McpServerIcon, MonitorIcon, MoonIcon, SearchIcon, SunIcon, XIcon } from "@/components/icons"
import { BookmarkletDialog } from "@/components/bookmarklet-dialog"
import { api, type Reference, type StorageUsage } from "@/lib/api"
import { SiteIcon } from "@/components/site-icon"
import { useAddFlow } from "@/components/add-flow"
import { BoardsList } from "@/components/canvas/boards-list"
import { isLocalOrigin } from "@/lib/mcp"
import { useCollections } from "@/lib/collections"
import { useTheme } from "@/components/theme-provider"
import { Logo } from "@/components/brand"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useGridSize, useHomeView, type GridSize, type HomeView } from "@/lib/prefs"

// Cosmos-style chrome: three floating pills (brand + board switcher, search, actions).

// Raised white pills: a fine ring and a crisp drop instead of a border.
const pill = "flex h-10 items-center rounded-full bg-control/90 shadow-button backdrop-blur-md"

export function TopBar({
  login,
  query,
  onQuery,
  boardId,
  solid,
  floating,
}: {
  login: string
  query?: string
  onQuery?: (q: string) => void
  /** The board in view, named in the switcher. Undefined is All saves. */
  boardId?: string
  /** Opaque background, for pages with their own sticky bar underneath so content can't show through. */
  solid?: boolean
  /** Over a canvas: laid on top of it, and only the pills take the pointer so the gaps between them still pan. */
  floating?: boolean
}) {
  return (
    <header
      className={cn(
        "flex items-center gap-3 px-4 py-3 sm:px-6",
        floating ? "pointer-events-none absolute inset-x-0 top-0 z-50 *:pointer-events-auto" : "sticky top-0 z-30",
        solid && "bg-background",
      )}
    >
      <BoardSwitcher boardId={boardId} />

      {onQuery ? (
        <SearchField query={query ?? ""} onQuery={onQuery} />
      ) : (
        <div className="flex-1" />
      )}

      <div className={cn(pill, "shrink-0 gap-1.5 p-1")}>
        <McpButton />
        <AccountMenu login={login} />
      </div>
    </header>
  )
}

/**
 * Compact until it's in use: it widens while focused or holding a query, so the canvas doesn't feel crowded. While
 * focused and empty, a panel says what search matches and offers saved sites as one-click filters.
 */
function SearchField({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  const [sites, setSites] = useState<Reference[] | null>(null)
  const loadSites = () => api.references({ status: "ready" }, null, 8).then((p) => setSites(p.items.filter((r, i, a) => a.findIndex((x) => x.domain === r.domain) === i)), () => setSites([]))
  return (
    <div className="group/search relative mx-auto min-w-0">
      <label
        className={cn(
          pill,
          "w-60 max-w-full min-w-0 gap-2 px-3 transition-[width] duration-200 ease-out focus-within:w-96 has-[input:not(:placeholder-shown)]:w-96 motion-reduce:transition-none has-focus-visible:outline-2 has-focus-visible:outline-offset-2 max-sm:focus-within:w-full max-sm:has-[input:not(:placeholder-shown)]:w-full",
        )}
      >
        <SearchIcon className="size-3.5 shrink-0 text-ink-9" />
        <input
          data-search
          value={query}
          onFocus={() => void loadSites()}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
          placeholder="Search sites, pages, sections…"
          aria-label="Search your saves by site, page title, path or section"
          aria-keyshortcuts="/"
          className="peer h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-ink-10 pointer-coarse:text-base"
        />
        {!query && (
          <kbd aria-hidden className="hidden h-5 min-w-5 place-items-center rounded-sm bg-ink-3 px-1 text-2xs text-ink-10 pointer-fine:grid pointer-fine:peer-focus:hidden">
            /
          </kbd>
        )}
        {query && (
          <button onClick={() => onQuery("")} aria-label="Clear search" className="press grid size-5 place-items-center rounded-full bg-control text-ink-10 shadow-button hover:text-foreground active:scale-[0.92]">
            <XIcon className="size-3" />
          </button>
        )}
      </label>
      {/* Shown by CSS while focus is inside, so tabbing from the field to a chip keeps it open. */}
      {!query && (
        <div className="absolute inset-x-0 top-12 hidden flex-col gap-2.5 rounded-2xl bg-popover p-3 shadow-menu group-focus-within/search:flex">
          <p className="text-2xs text-ink-10">Matches site names and links, page titles and paths, and section names like “pricing” or “footer”.</p>
          {!!sites?.length && (
            <div className="flex flex-col gap-1.5">
              <span className="text-2xs font-medium text-ink-11">Your sites</span>
              <div className="flex flex-wrap gap-1.5">
                {sites.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    // Keep focus in the field so the panel stays put and the results show at once.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onQuery(r.domain)}
                    className="tactile press flex h-7 items-center gap-1.5 rounded-full pr-2.5 pl-1.5 text-2xs"
                  >
                    <SiteIcon domain={r.domain} icon={r.favicon} />
                    {r.domain}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** The logo goes home; the board name opens the boards popover. */
function BoardSwitcher({ boardId }: { boardId?: string }) {
  const { collections } = useCollections()
  const [open, setOpen] = useState(false)
  const name = boardId ? (collections.find((c) => c.id === boardId)?.name ?? "Board") : "All saves"
  return (
    <div className={cn(pill, "shrink-0 gap-0.5 p-1")}>
      <Link href="/" className="press grid size-8 place-items-center rounded-full hover:bg-ink-2 active:scale-[0.92]" aria-label="Snip home">
        <Logo className="size-7" />
      </Link>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label={`${name}, switch board`}
          className="press group/board flex h-8 max-w-[40vw] items-center gap-1 rounded-full pr-2.5 pl-1.5 text-xs font-medium hover:bg-ink-2 data-popup-open:bg-ink-3 sm:max-w-56"
        >
          <span className="truncate">{name}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-ink-10 transition-transform duration-150 ease-out group-data-popup-open/board:rotate-180" />
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={8} className="w-auto p-1.5">
          <BoardsList activeId={boardId} onNavigate={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </div>
  )
}

function McpButton() {
  const { connectMcp } = useAddFlow()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={connectMcp}
            aria-label="Connect MCP"
            className="press grid size-8 place-items-center rounded-full text-ink-11 hover:bg-ink-3 hover:text-foreground active:scale-[0.92]"
          />
        }
      >
        <McpServerIcon className="size-4" />
      </TooltipTrigger>
      <TooltipContent side="bottom">Connect your agent over MCP</TooltipContent>
    </Tooltip>
  )
}

export function formatBytes(n: number) {
  if (n < 1024 ** 2) return `${Math.max(0, Math.round(n / 1024))} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`
  return `${+(n / 1024 ** 3).toFixed(1)} GB`
}

function StorageMeter({ usage }: { usage: StorageUsage | null | "error" }) {
  if (usage === "error") return null
  // Local mode has no quota: the bytes are files in the library folder. Only a hosted Snip
  // counts against R2's free tier.
  if (isLocalOrigin()) {
    return (
      <div className="flex items-center justify-between px-2 py-1.5 text-xs" title="Screenshots, recordings, HTML snapshots and styles, stored in this Mac's Snip library.">
        Storage
        <span className="text-ink-11 tabular-nums">{usage ? `${usage.partial ? "over " : ""}${formatBytes(usage.bytes)} on disk` : "…"}</span>
      </div>
    )
  }
  const share = usage ? Math.min(1, usage.bytes / usage.freeBytes) : 0
  return (
    <div className="flex flex-col gap-1.5 px-2 py-1.5 text-xs" title="Cloudflare R2's free tier includes 10 GB. Storage beyond it is billed.">
      <div className="flex items-center justify-between">
        Storage
        <span className="text-ink-11 tabular-nums">
          {usage ? `${usage.partial ? "over " : ""}${formatBytes(usage.bytes)} of ${formatBytes(usage.freeBytes)} free tier` : "…"}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-ink-3" role="meter" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
        <div className={cn("h-full rounded-full bg-ink-11 transition-[width]", share > 0.8 && "bg-(--red-9)")} style={{ width: `${Math.max(share * 100, usage?.bytes ? 1 : 0)}%` }} />
      </div>
    </div>
  )
}

function AccountMenu({ login }: { login: string }) {
  const { theme, setTheme } = useTheme()
  const [grid, setGrid] = useGridSize()
  const [view, setView] = useHomeView()
  const [usage, setUsage] = useState<StorageUsage | null | "error">(null)
  const [bookmarklet, setBookmarklet] = useState(false)
  return (
    <>
    <BookmarkletDialog open={bookmarklet} onOpenChange={setBookmarklet} />
    <DropdownMenu onOpenChange={(open) => open && api.storage().then(setUsage, () => setUsage("error"))}>
      <DropdownMenuTrigger
        render={
          <button
            aria-label="Account"
            className="press grid size-8 place-items-center rounded-full bg-ink-3 text-2xs font-medium text-ink-11 uppercase hover:bg-ink-4 active:scale-[0.92] aria-expanded:bg-ink-4"
          />
        }
      >
        {login.slice(0, 1)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>@{login}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div className="flex items-center justify-between px-2 py-1.5 text-xs">
          Theme
          <Segmented
            value={theme}
            onChange={setTheme}
            options={[
              { value: "light", label: <SunIcon className="size-3.5" />, title: "Light" },
              { value: "dark", label: <MoonIcon className="size-3.5" />, title: "Dark" },
              { value: "system", label: <MonitorIcon className="size-3.5" />, title: "System" },
            ]}
          />
        </div>
        <div className="flex items-center justify-between px-2 py-1.5 text-xs">
          Gallery
          <Segmented<HomeView>
            value={view}
            onChange={setView}
            options={[
              { value: "canvas", label: "Canvas", title: "Infinite canvas you can drag around" },
              { value: "grid", label: "Grid", title: "Scrolling grid" },
            ]}
          />
        </div>
        <div className="flex items-center justify-between px-2 py-1.5 text-xs">
          Grid size
          <Segmented<GridSize>
            value={grid}
            onChange={setGrid}
            options={[
              { value: "s", label: <GridGlyph n={3} />, title: "Small" },
              { value: "m", label: <GridGlyph n={2} />, title: "Medium" },
              { value: "l", label: <GridGlyph n={1} />, title: "Large" },
            ]}
          />
        </div>
        <DropdownMenuSeparator />
        <StorageMeter usage={usage} />
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<a href="/passkeys" />}>
          <KeyRound /> Passkeys and devices
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setBookmarklet(true)}>
          <BookmarkIcon /> Browser bookmarklet
        </DropdownMenuItem>
        <DropdownMenuItem render={<a href="/auth/logout" />}>
          <LogOutIcon /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  )
}

function GridGlyph({ n }: { n: number }) {
  return (
    <span className="flex h-3 gap-[2px]">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="w-[3px] rounded-[1px] bg-current" />
      ))}
    </span>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: React.ReactNode; title?: string }[]
  className?: string
}) {
  const id = useId()
  // Reduced motion: the pill snaps to the chosen option instead of sliding.
  const reduce = useReducedMotion()
  return (
    <div className={cn("tactile-track flex items-center", className)} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "press relative grid h-6 min-w-7 place-items-center rounded-full px-2 text-xs font-medium text-ink-11 hover:text-foreground",
            value === o.value && "text-foreground",
          )}
        >
          {/* The chosen option sits on a white pill that springs across. */}
          {value === o.value && (
            <motion.span
              layoutId={`seg-${id}`}
              transition={reduce ? { duration: 0 } : { type: "spring", bounce: 0.12, duration: 0.4 }}
              className="tactile-chosen absolute inset-0 rounded-full"
              aria-hidden
            />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

/** Circular icon button with a caption underneath (Cosmos collection actions). */
export function ActionCircle({ icon, label, onClick, href }: { icon: React.ReactNode; label: string; onClick?: () => void; href?: string }) {
  const inner = (
    <>
      <span className="tactile press grid size-9 place-items-center rounded-full group-active:scale-[0.94] [&_svg]:size-4 [&_svg]:text-ink-11">{icon}</span>
      <span className="text-2xs text-ink-11">{label}</span>
    </>
  )
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="group flex flex-col items-center gap-1.5">
      {inner}
    </a>
  ) : (
    <button onClick={onClick} className="group flex flex-col items-center gap-1.5">
      {inner}
    </button>
  )
}
