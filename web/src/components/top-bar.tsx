import { useId } from "react"
import { Link } from "wouter"
import { motion, useReducedMotion } from "motion/react"
import { FolderPlusIcon, GlobeIcon, LogOutIcon, MonitorIcon, MoonIcon, PlugIcon, PlusIcon, SearchIcon, SunIcon, TerminalIcon, XIcon } from "@/components/icons"
import { useAddFlow } from "@/components/add-flow"
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

// Raised white pills: a fine ring and a crisp drop instead of a border.
const pill = "flex h-10 items-center rounded-full bg-control/90 shadow-button backdrop-blur-md"

export function TopBar({
  login,
  view,
  onView,
  query,
  onQuery,
  collection,
  solid,
}: {
  login: string
  view?: View
  onView?: (v: View) => void
  query?: string
  onQuery?: (q: string) => void
  /** Preselected in the add flow when browsing a collection. */
  collection?: string
  /** Opaque background, for pages with their own sticky bar underneath so content can't show through. */
  solid?: boolean
}) {
  return (
    <header className={cn("sticky top-0 z-30 flex items-center gap-3 px-4 py-3 sm:px-6", solid && "bg-background")}>
      <div className={cn(pill, "shrink-0 gap-1 p-1")}>
        <Link href="/" className="press grid size-8 place-items-center rounded-full hover:bg-ink-2 active:scale-[0.92]" aria-label="Snip home">
          <Logo className="size-7" />
        </Link>
        <nav className="hidden items-center sm:flex">
          {VIEWS.map((v) =>
            onView ? (
              <button
                key={v.value}
                onClick={() => onView(v.value)}
                aria-current={view === v.value ? "page" : undefined}
                className={cn(
                  "press h-8 rounded-full px-3 text-xs font-medium text-ink-11 hover:bg-ink-2 hover:text-foreground",
                  view === v.value && "bg-ink-3 text-foreground hover:bg-ink-3",
                )}
              >
                {v.label}
              </button>
            ) : (
              <Link key={v.value} href={`/?view=${v.value}`} className="press h-8 content-center rounded-full px-3 text-xs font-medium text-ink-11 hover:bg-ink-2 hover:text-foreground">
                {v.label}
              </Link>
            ),
          )}
        </nav>
      </div>

      <div className="mx-auto min-w-0 max-w-md flex-1">
        {onQuery ? (
          <label className="well flex h-10 items-center gap-2 rounded-full px-3.5">
            <SearchIcon className="size-4 shrink-0 text-ink-9" />
            <input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search Snip…"
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-10"
            />
            {query && (
              <button onClick={() => onQuery("")} aria-label="Clear search" className="press grid size-5 place-items-center rounded-full bg-control text-ink-10 shadow-button hover:text-foreground active:scale-[0.92]">
                <XIcon className="size-3" />
              </button>
            )}
          </label>
        ) : null}
      </div>

      <div className={cn(pill, "shrink-0 gap-1.5 p-1")}>
        <ConnectButton />
        <CreateMenu collection={collection} />
        <AccountMenu login={login} />
      </div>
    </header>
  )
}

function ConnectButton() {
  const { connectMcp } = useAddFlow()
  return (
    <Button size="sm" variant="ghost" onClick={connectMcp} aria-label="Connect MCP" title="Connect your agent over MCP" className="rounded-full">
      <PlugIcon data-icon="inline-start" />
      <span className="hidden sm:inline">Connect MCP</span>
    </Button>
  )
}

function CreateMenu({ collection }: { collection?: string }) {
  const { addReference, newCollection, connectMcp } = useAddFlow()
  const item = "flex items-start gap-3 px-2.5 py-2"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Create" render={<Button size="sm" className="rounded-full" />}>
        <PlusIcon data-icon="inline-start" />
        <span className="hidden sm:inline">Create</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={10} className="w-64 p-1.5">
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
            onClick={connectMcp}
          >
            <TerminalIcon className="mt-0.5" />
            <span className="grid">
              <span className="font-medium">Connect an agent</span>
              <span className="text-2xs text-muted-foreground">MCP URL and setup steps</span>
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
            value={theme ?? "system"}
            onChange={setTheme}
            options={[
              { value: "light", label: <SunIcon className="size-3.5" />, title: "Light" },
              { value: "dark", label: <MoonIcon className="size-3.5" />, title: "Dark" },
              { value: "system", label: <MonitorIcon className="size-3.5" />, title: "System" },
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
