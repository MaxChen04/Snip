import { Link } from "wouter"
import { FolderPlusIcon, GlobeIcon, LogOutIcon, MonitorIcon, MoonIcon, PlusIcon, SearchIcon, SunIcon, TerminalIcon, XIcon } from "lucide-react"
import { useAddFlow } from "@/components/add-flow"
import { notify } from "@/components/notify"
import { useTheme } from "next-themes"
import { Logo } from "@/App"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useGridSize, type GridSize } from "@/lib/prefs"

// Cosmos-style chrome: three floating pills (brand + nav, search, actions).

export type View = "websites" | "pages" | "animations"
const VIEWS: { value: View; label: string }[] = [
  { value: "websites", label: "Websites" },
  { value: "pages", label: "Pages" },
  { value: "animations", label: "Animations" },
]

const pill = "flex h-10 items-center rounded-full bg-background/90 ring-1 ring-border shadow-xs backdrop-blur-md"

export function TopBar({
  login,
  view,
  onView,
  query,
  onQuery,
  collection,
}: {
  login: string
  view?: View
  onView?: (v: View) => void
  query?: string
  onQuery?: (q: string) => void
  /** Preselected in the add flow when browsing a collection. */
  collection?: string
}) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 px-4 py-3 sm:px-6">
      <div className={cn(pill, "shrink-0 gap-1 p-1")}>
        <Link href="/" className="grid size-8 place-items-center rounded-full hover:bg-fill-2" aria-label="Snip home">
          <Logo className="size-7" />
        </Link>
        <nav className="hidden items-center sm:flex">
          {VIEWS.map((v) =>
            onView ? (
              <button
                key={v.value}
                onClick={() => onView(v.value)}
                className={cn(
                  "h-8 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                  view === v.value && "text-foreground",
                )}
              >
                {v.label}
              </button>
            ) : (
              <Link key={v.value} href={`/?view=${v.value}`} className="h-8 content-center rounded-full px-3 text-xs font-medium text-muted-foreground hover:text-foreground">
                {v.label}
              </Link>
            ),
          )}
        </nav>
      </div>

      <div className="mx-auto min-w-0 max-w-md flex-1">
        {onQuery ? (
          <label className={cn(pill, "gap-2 px-3.5")}>
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search Snip…"
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {query && (
              <button onClick={() => onQuery("")} aria-label="Clear search" className="grid size-5 place-items-center rounded-full bg-fill-2 text-muted-foreground">
                <XIcon className="size-3" />
              </button>
            )}
          </label>
        ) : null}
      </div>

      <div className={cn(pill, "shrink-0 gap-1.5 p-1")}>
        <CreateMenu collection={collection} />
        <AccountMenu login={login} />
      </div>
    </header>
  )
}

function CreateMenu({ collection }: { collection?: string }) {
  const { addReference, newCollection } = useAddFlow()
  const item = "flex items-start gap-3 rounded-xl px-2.5 py-2"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Create" render={<Button size="sm" className="rounded-full bg-foreground text-background hover:bg-foreground/85" />}>
        <PlusIcon data-icon="inline-start" />
        <span className="hidden sm:inline">Create</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={10} className="w-64 rounded-2xl p-1.5">
        <DropdownMenuGroup>
          <DropdownMenuItem className={item} onClick={() => addReference(collection)}>
            <GlobeIcon className="mt-0.5" />
            <span className="grid">
              <span className="font-medium">Reference</span>
              <span className="text-2xs text-muted-foreground">Capture a page or crawl a site</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem className={item} onClick={newCollection}>
            <FolderPlusIcon className="mt-0.5" />
            <span className="grid">
              <span className="font-medium">Collection</span>
              <span className="text-2xs text-muted-foreground">Group references together</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className={item}
            onClick={() => {
              void navigator.clipboard?.writeText(`${location.origin}/mcp`)
              notify("Copied MCP server URL")
            }}
          >
            <TerminalIcon className="mt-0.5" />
            <span className="grid">
              <span className="font-medium">Connect an agent</span>
              <span className="text-2xs text-muted-foreground">Copy the remote MCP URL</span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccountMenu({ login }: { login: string }) {
  const { theme, setTheme } = useTheme()
  const [grid, setGrid] = useGridSize()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            aria-label="Account"
            className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-primary/70 to-fuchsia-400/70 text-[11px] font-semibold text-white uppercase"
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
        <div className="flex items-center justify-between px-2 py-1.5 text-sm">
          Theme
          <Segmented
            value={theme ?? "system"}
            onChange={setTheme}
            options={[
              { value: "light", label: <SunIcon className="size-3.5" />, title: "Light" },
              { value: "dark", label: <MoonIcon className="size-3.5" />, title: "Dark" },
              { value: "system", label: <MonitorIcon className="size-3.5" />, title: "System" },
            ]}
          />
        </div>
        <div className="flex items-center justify-between px-2 py-1.5 text-sm">
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
        <DropdownMenuItem render={<a href="/auth/logout" />}>
          <LogOutIcon /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  return (
    <div className={cn("flex items-center rounded-full bg-fill-2 p-0.5", className)} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "grid h-6 min-w-7 place-items-center rounded-full px-2 text-xs font-medium text-muted-foreground transition-colors",
            value === o.value && "bg-foreground text-background",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Circular icon button with a caption underneath (Cosmos collection actions). */
export function ActionCircle({ icon, label, onClick, href }: { icon: React.ReactNode; label: string; onClick?: () => void; href?: string }) {
  const inner = (
    <>
      <span className="grid size-9 place-items-center rounded-full ring-1 ring-border transition-colors group-hover:bg-fill-2 [&_svg]:size-4">{icon}</span>
      <span className="text-2xs text-muted-foreground">{label}</span>
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
