import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react"
import { Link, useLocation } from "wouter"
import { useReducedMotion } from "motion/react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { toast } from "sonner"
import {
  ArrowLeft,
  ArrowUpRightIcon,
  CheckIcon,
  ChevronRightIcon,
  FolderPlusIcon,
  GlobeIcon,
  ImageIcon,
  Link2,
  MonitorIcon,
  MoreHorizontalIcon,
  SmartphoneIcon,
  Trash2Icon,
  XIcon,
} from "@/components/icons"
import { CollectionPicker } from "@/components/collection-picker"
import { notify } from "@/components/notify"
import { RecordingTile } from "@/components/reference-page"
import { SiteIcon } from "@/components/site-icon"
import { TokensPanel } from "@/components/tokens-panel"
import { Segmented } from "@/components/top-bar"
import { Dialog, DialogClose, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { RELOAD_EVENT, reloadCanvas, type CanvasItem } from "@/components/canvas/types"
import { api, fileUrl, type Animation, type Page, type Reference, type SavedImage, type SectionItem } from "@/lib/api"
import { useCollections } from "@/lib/collections"
import { cn } from "@/lib/utils"
import { isVideoKey } from "../../../shared/types"

type Detail = Awaited<ReturnType<typeof api.reference>>
type Tab = "sections" | "palette" | "tokens" | "motion"
type Device = "desktop" | "mobile"

// One fetch per website while the app is open, so stepping through a site's pages doesn't refetch.
// Anything that adds or removes material drops the lot.
const details = new Map<string, Promise<Detail>>()
// Board membership changed here this session ("page:<id>", "reference:<id>", "image:<id>"), newer than the canvas's copy.
// A reload brings fresh copies, so both caches go.
const memberships = new Map<string, string[]>()
window.addEventListener(RELOAD_EVENT, () => {
  details.clear()
  memberships.clear()
})
const loadDetail = (id: string) => {
  let p = details.get(id)
  if (!p) {
    p = api.reference(id)
    details.set(id, p)
    p.catch(() => details.delete(id))
  }
  return p
}

function useDetail(id: string | null) {
  const [state, setState] = useState<{ id: string; data?: Detail; error?: string }>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!id) return
    let live = true
    setState({ id })
    loadDetail(id).then(
      (data) => live && setState({ id, data }),
      (e: Error) => live && setState({ id, error: e.message }),
    )
    return () => {
      live = false
    }
  }, [id, attempt])
  const current = state?.id === id ? state : undefined
  const latest = useRef(current?.data)
  latest.current = current?.data
  /** Change the cached copy too, so it survives stepping away and back (works after unmount). */
  const update = (fn: (d: Detail) => Detail) => {
    if (!id || !latest.current) return
    const data = fn(latest.current)
    latest.current = data
    details.set(id, Promise.resolve(data))
    setState({ id, data })
  }
  return { detail: current?.data, error: current?.error, retry: () => setAttempt((n) => n + 1), update }
}

const savedOn = (iso: string) => {
  const d = new Date(iso)
  const year = d.getFullYear() !== new Date().getFullYear()
  return `saved ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(year && { year: "numeric" }) })}`
}
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`
const motionLabel = (a: Animation) => a.label || (a.kind === "hover" ? "Hover effect" : "Scroll recording")
const isTyping = (el: HTMLElement) => el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|VIDEO)$/.test(el.tagName)

/** Full-screen focus view for one item: preview on the left, details and actions on the right. */
export function ItemInspector({
  item,
  onClose,
  onPrev,
  onNext,
  position,
}: {
  item: CanvasItem
  onClose: () => void
  /** Step through the canvas's current list. Omitted at the ends. */
  onPrev?: () => void
  onNext?: () => void
  /** 0-based index in the current list and its length, for "38 of 142". */
  position?: { index: number; total: number }
}) {
  // Opens on the next frame so the enter transition runs; onClose waits for the exit transition.
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(true), [])
  // Kept across prev/next, so stepping through pages stays on "Colors & type".
  const [tab, setTab] = useState<Tab>("sections")

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    const t = e.target as HTMLElement
    // Menus and popovers portal out of the popup; tabs and fields use the arrows themselves.
    if (!e.currentTarget.contains(t) || isTyping(t) || t.closest('[role="tablist"]')) return
    const step = e.key === "ArrowLeft" ? onPrev : onNext
    if (!step) return
    e.preventDefault()
    step()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)} onOpenChangeComplete={(o) => !o && onClose()}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Popup
          data-slot="dialog-content"
          onKeyDown={onKeyDown}
          className="fixed inset-0 z-50 m-auto flex flex-col overflow-y-auto bg-card text-popover-foreground outline-none sm:inset-4 sm:rounded-3xl sm:shadow-modal lg:inset-6 lg:h-[min(796px,calc(100svh-3rem))] lg:w-[min(1248px,calc(100vw-3rem))] lg:flex-row lg:overflow-hidden"
        >
          <Body
            key={`${item.kind}:${item.id}`}
            item={item}
            close={() => setOpen(false)}
            onPrev={onPrev}
            onNext={onNext}
            position={position}
            tab={tab}
            onTab={setTab}
          />
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}

function Body({
  item,
  close,
  onPrev,
  onNext,
  position,
  tab: tabPref,
  onTab,
}: {
  item: CanvasItem
  close: () => void
  onPrev?: () => void
  onNext?: () => void
  position?: { index: number; total: number }
  tab: Tab
  onTab: (t: Tab) => void
}) {
  const [location, navigate] = useLocation()
  const { collections, refresh } = useCollections()
  const refId =
    item.kind === "image" ? null
    : item.kind === "website" ? item.reference.id
    : item.kind === "page" ? item.page.referenceId
    : item.kind === "section" ? item.section.referenceId
    : item.animation.referenceId
  const { detail, error, retry, update } = useDetail(refId)

  const pageId = item.kind === "page" ? item.page.id : item.kind === "section" ? item.section.pageId : item.kind === "animation" ? item.animation.pageId : null
  const page: Page | undefined = (pageId ? detail?.pages.find((p) => p.id === pageId) : undefined) ?? (item.kind === "page" ? item.page : undefined)
  const showsPage = item.kind === "page" || item.kind === "section"
  const animations = detail?.animations.filter((a) => (pageId ? a.pageId === pageId : true))
  // Pages captured before per-page tokens fall back to the site's.
  const tokens = page?.tokens ?? (detail?.reference ?? (item.kind === "website" ? item.reference : null))?.tokens ?? null
  // A section or recording learns its page from the fetch; until then the tabs would jump.
  const waitingForPage = !page && !!pageId && !detail

  // ---- Preview state shared by the screenshot and the Sections tab ----
  const hasDesktop = !!(page?.desktopKey ?? page?.desktopThumbKey)
  const hasMobile = !!(page?.mobileKey ?? page?.mobileThumbKey)
  const [device, setDevice] = useState<Device>(hasDesktop || !hasMobile ? "desktop" : "mobile")
  const initial = item.kind === "section" ? item.section.index : null
  const [active, setActive] = useState<number | null>(initial)
  const [hover, setHover] = useState<number | null>(null)
  const [scrollTo, setScrollTo] = useState<{ i: number; smooth: boolean } | null>(initial === null ? null : { i: initial, smooth: false })
  const pickSection = (i: number) => {
    setActive(i)
    setDevice("desktop")
    setScrollTo({ i, smooth: true })
  }

  // ---- What this item is ----
  const info =
    item.kind === "page" ? { domain: item.page.reference.domain, title: item.page.title || item.page.path, path: item.page.path, url: item.page.url, at: item.page.createdAt }
    : item.kind === "section" ? { domain: item.section.reference.domain, title: item.section.label, path: item.section.path, url: item.section.url, at: item.section.createdAt }
    : item.kind === "animation" ? { domain: item.animation.reference.domain, title: motionLabel(item.animation), path: page?.path, url: page?.url ?? detail?.reference.url, at: item.animation.createdAt }
    : item.kind === "website" ? { domain: item.reference.domain, title: item.reference.title || item.reference.domain, path: undefined, url: item.reference.url, at: item.reference.createdAt }
    : { domain: undefined, title: item.image.title || "Untitled image", path: undefined, url: fileUrl(item.image.key), at: item.image.createdAt }
  const meta =
    item.kind === "image" ? `${item.image.width} × ${item.image.height} · ${savedOn(info.at)}`
    : item.kind === "website" ? `${info.domain} · ${plural(item.reference.pageCount, "page")} · ${savedOn(info.at)}`
    : `${info.domain}${info.path && info.path !== "/" ? info.path : ""} · ${savedOn(info.at)}`
  const websiteHref = refId && `/r/${refId}${pageId ? `?page=${pageId}` : ""}`

  // ---- Boards: pages (sections and recordings save their page), websites and images ----
  const target =
    item.kind === "image" ? { kind: "image" as const, id: item.image.id, ids: item.image.collectionIds }
    : item.kind === "website" ? { kind: "reference" as const, id: item.reference.id, ids: (detail?.reference ?? item.reference).collectionIds }
    : page ? { kind: "page" as const, id: page.id, ids: page.collectionIds }
    : detail && !pageId ? { kind: "reference" as const, id: detail.reference.id, ids: detail.reference.collectionIds }
    : null
  const selected = target ? (memberships.get(`${target.kind}:${target.id}`) ?? target.ids) : []
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const toggling = useRef(false)
  const toggleBoard = async (cid: string, on: boolean) => {
    if (!target || toggling.current) return
    toggling.current = true
    const key = `${target.kind}:${target.id}`
    const before = selected
    memberships.set(key, on ? [...new Set([...before, cid])] : before.filter((x) => x !== cid))
    rerender()
    try {
      if (target.kind === "page") await api.setPageMembership(cid, [target.id], on)
      else if (target.kind === "image") await api.setImageMembership(cid, [target.id], on)
      else await api.setMembership(target.id, cid, on)
      void refresh().catch(() => {})
      // The board being viewed gains or loses this item.
      if (location === `/b/${cid}`) reloadCanvas()
    } catch (e) {
      memberships.set(key, before)
      rerender()
      toast.error((e as Error).message)
    } finally {
      toggling.current = false
    }
  }
  const boards = collections.filter((c) => selected.includes(c.id))

  const copyLink = () => {
    const link = item.kind === "image" ? window.location.href : info.url
    if (!link) return
    navigator.clipboard?.writeText(link).then(
      () => notify("Copied link"),
      () => toast.error("Copy failed"),
    )
  }
  const deleteImage = async () => {
    if (item.kind !== "image" || !confirm("Delete this image? It comes off every board too.")) return
    try {
      await api.deleteImage(item.image.id)
      reloadCanvas()
      void refresh().catch(() => {})
      close()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // ---- Tabs: only the ones with something in them; Motion shows its own empty state ----
  const tabs: { value: Tab; label: string }[] = []
  if (showsPage && page?.sections.length) tabs.push({ value: "sections", label: "Sections" })
  if (item.kind === "image" && item.image.palette.length) tabs.push({ value: "palette", label: "Colors" })
  if (tokens) tabs.push({ value: "tokens", label: "Colors & type" })
  if (refId) {
    // A recording's own motion comes first.
    const motion = { value: "motion" as const, label: "Motion" }
    if (item.kind === "animation") tabs.unshift(motion)
    else tabs.push(motion)
  }
  const tab = tabs.some((t) => t.value === tabPref) ? tabPref : tabs[0]?.value

  const pressable = "press flex h-9 items-center gap-1.5 rounded-md text-xs tracking-[-0.01em] pointer-coarse:h-11"

  return (
    <>
      {/* Preview */}
      <section className="flex h-[62svh] shrink-0 flex-col gap-3 bg-ink-3 p-3 sm:gap-4 sm:p-5 lg:h-auto lg:min-w-0 lg:flex-1 dark:bg-ink-1">
        <div className="flex min-h-8 items-center gap-2">
          {showsPage && hasDesktop && hasMobile && (
            <Segmented<Device>
              value={device}
              onChange={setDevice}
              options={[
                { value: "desktop", title: "Desktop", label: <span className="flex items-center gap-1.5"><MonitorIcon className="size-3.5" /><span className="max-sm:sr-only">Desktop</span></span> },
                { value: "mobile", title: "Mobile", label: <span className="flex items-center gap-1.5"><SmartphoneIcon className="size-3.5" /><span className="max-sm:sr-only">Mobile</span></span> },
              ]}
              className="[&_button]:h-7 [&_button]:px-3"
            />
          )}
          <span className="flex-1" />
          {(onPrev || onNext || position) && (
            <div className="flex items-center gap-1">
              <StepButton label="Previous" keys="ArrowLeft" onClick={onPrev}>
                <ArrowLeft />
              </StepButton>
              {position && (
                <span className="px-1.5 text-2xs text-ink-10 tabular-nums">
                  {position.index + 1} of {position.total}
                </span>
              )}
              <StepButton label="Next" keys="ArrowRight" onClick={onNext}>
                <ChevronRightIcon />
              </StepButton>
            </div>
          )}
          <CloseButton className="tactile lg:hidden" />
        </div>

        {item.kind === "image" ? (
          <ImagePreview image={item.image} />
        ) : item.kind === "animation" ? (
          <AnimationPreview a={item.animation} />
        ) : item.kind === "website" ? (
          <WebsitePreview reference={item.reference} pages={detail?.pages} failed={!!error} />
        ) : page ? (
          <PagePreview page={page} device={device} active={active} hover={hover} onHover={setHover} onPick={setActive} scrollTo={scrollTo} />
        ) : item.kind === "section" ? (
          <SectionStill section={item.section} />
        ) : null}
      </section>

      {/* Details */}
      <aside className="flex flex-col border-t border-line lg:w-[392px] lg:shrink-0 lg:overflow-hidden lg:border-t-0 lg:border-l">
        <div className="flex shrink-0 flex-col gap-3 px-5 pt-5 pb-4">
          <div className="flex min-h-8 items-center gap-2">
            {info.domain ? <SiteIcon domain={info.domain} className="size-5 rounded-md" /> : <ImageIcon className="size-4 text-ink-10" />}
            <span className="truncate text-xs text-ink-11">{info.domain ?? "Uploaded image"}</span>
            <CloseButton className="ml-auto hidden bg-ink-3 hover:bg-ink-4 hover:text-ink-12 lg:grid" />
          </div>
          <div className="grid gap-1">
            <DialogTitle className="line-clamp-2 text-xl leading-7 tracking-tight text-balance text-ink-12">{info.title}</DialogTitle>
            <DialogDescription className="truncate text-xs text-ink-10">{meta}</DialogDescription>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Popover>
              <PopoverTrigger
                disabled={!target}
                className={cn(pressable, "flex-1 justify-center bg-primary px-3 text-primary-foreground shadow-primary hover:bg-(--primary-hover) disabled:opacity-60 data-popup-open:bg-(--primary-hover)")}
              >
                <FolderPlusIcon className="size-4" />
                Add to board
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 p-2">
                <CollectionPicker className="max-h-72" selected={selected} onToggle={(cid, on) => void toggleBoard(cid, on)} />
              </PopoverContent>
            </Popover>
            {info.url && (
              <a href={info.url} target="_blank" rel="noreferrer" className={cn(pressable, "tactile px-3.5")}>
                Open
                <ArrowUpRightIcon className="size-3.5 text-ink-10" />
              </a>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="More actions"
                className="tactile press grid size-9 shrink-0 place-items-center rounded-md data-popup-open:bg-control-hover pointer-coarse:size-11"
              >
                <MoreHorizontalIcon className="size-4 text-ink-11" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {websiteHref && (
                  <DropdownMenuItem onClick={() => navigate(websiteHref)}>
                    <GlobeIcon /> Open in website view
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={copyLink}>
                  <Link2 /> Copy link
                </DropdownMenuItem>
                {item.kind === "image" && (
                  <DropdownMenuItem variant="destructive" onClick={() => void deleteImage()}>
                    <Trash2Icon /> Delete image
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {boards.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {boards.map((c) => (
                <Link
                  key={c.id}
                  href={`/b/${c.id}`}
                  className="flex h-6 max-w-full items-center truncate rounded-full bg-ink-3 px-2.5 text-2xs text-ink-11 transition-colors duration-150 ease-out hover:bg-ink-4 hover:text-ink-12"
                >
                  {c.name}
                </Link>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="mx-5 mb-4 flex shrink-0 items-center gap-2 rounded-md bg-ink-3 py-1.5 pr-1.5 pl-3 text-2xs text-ink-11">
            <span className="min-w-0 flex-1">Couldn't load this site's details.</span>
            <button type="button" onClick={retry} className="tactile press h-7 shrink-0 rounded-full px-2.5 text-2xs">
              Try again
            </button>
          </div>
        )}

        {waitingForPage && !error ? (
          <div className="flex flex-col gap-3 border-t border-line p-5">
            <Skeleton className="h-6 w-48 rounded-md" />
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 rounded-md" />
            ))}
          </div>
        ) : (
          // flex-col and h-10 are explicit: Base UI marks orientation with data-orientation, so the primitive's
          // data-horizontal styles never apply.
          tab && (
            <Tabs value={tab} onValueChange={(v) => onTab(v as Tab)} className="min-h-0 flex-1 flex-col gap-0">
              <TabsList variant="line" className="h-10 w-full shrink-0 justify-start gap-1.5 rounded-none border-b border-line px-3">
                {tabs.map((t) => (
                  <TabsTrigger key={t.value} value={t.value} className="h-10">
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {page && (
                <TabsContent value="sections" className="min-h-0 overflow-y-auto">
                  <SectionList page={page} active={device === "desktop" ? active : null} hover={hover} onHover={setHover} onSelect={pickSection} />
                </TabsContent>
              )}
              {item.kind === "image" && (
                <TabsContent value="palette" className="min-h-0 overflow-y-auto">
                  <Palette colors={item.image.palette} />
                </TabsContent>
              )}
              {tokens && (
                <TabsContent value="tokens" className="min-h-0 overflow-y-auto p-5">
                  <TokensPanel tokens={tokens} compact />
                </TabsContent>
              )}
              <TabsContent value="motion" className="min-h-0 overflow-y-auto">
                <MotionList animations={animations} current={item.kind === "animation" ? item.id : undefined} failed={!!error} />
              </TabsContent>
            </Tabs>
          )
        )}

        {refId && !error && (
          <div className="flex shrink-0 flex-col gap-2 border-t border-line p-5 lg:mt-auto">
            {detail ? (
              <Notes reference={detail.reference} onChange={(notes) => update((d) => ({ ...d, reference: { ...d.reference, notes } }))} />
            ) : (
              <>
                <Skeleton className="h-4 w-28 rounded-sm" />
                <Skeleton className="h-16 rounded-md" />
              </>
            )}
          </div>
        )}
      </aside>
    </>
  )
}

function CloseButton({ className }: { className?: string }) {
  return (
    <DialogClose aria-label="Close" className={cn("press grid size-8 shrink-0 place-items-center rounded-full text-ink-11 pointer-coarse:size-10", className)}>
      <XIcon className="size-4" />
    </DialogClose>
  )
}

function StepButton({ label, keys, onClick, children }: { label: string; keys: string; onClick?: () => void; children: React.ReactNode }) {
  // aria-disabled, not disabled: a disabled button drops focus, and the arrow keys need it inside the dialog.
  return (
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts={keys}
      aria-disabled={!onClick || undefined}
      onClick={onClick}
      className="tactile press relative grid size-8 place-items-center rounded-full after:absolute after:-inset-1.5 aria-disabled:pointer-events-none aria-disabled:opacity-40 [&_svg]:size-4 [&_svg]:text-ink-11"
    >
      {children}
    </button>
  )
}

// ---------- Previews ----------

/** Fills the pane and contains a w×h box in it, sized before the media loads and never past its natural size. */
const stage = "grid min-h-0 flex-1 place-items-center [container-type:size]"
const fit = (w: number, h: number): React.CSSProperties => ({ width: `min(100cqw, ${(w / h) * 100}cqh, ${w}px)`, aspectRatio: `${w} / ${h}` })
const frame = "min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-xl bg-surface-top shadow-card"

function PagePreview({
  page,
  device,
  active,
  hover,
  onHover,
  onPick,
  scrollTo,
}: {
  page: Page
  device: Device
  active: number | null
  hover: number | null
  onHover: (i: number | null) => void
  onPick: (i: number) => void
  /** A new value scrolls that section into view. */
  scrollTo: { i: number; smooth: boolean } | null
}) {
  const box = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const src = device === "desktop" ? (page.desktopKey ?? page.desktopThumbKey) : (page.mobileKey ?? page.mobileThumbKey)
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const loaded = !!src && loadedSrc === src
  const W = page.desktopWidth
  // Sections are measured on the full desktop screenshot in CSS px; cqw maps them onto it as displayed.
  const sections = device === "desktop" && page.desktopKey && W ? page.sections : []

  useEffect(() => {
    const el = scrollTo && loaded ? box.current?.querySelector<HTMLElement>(`[data-section="${scrollTo.i}"]`) : null
    if (!box.current || !el) return
    const top = el.getBoundingClientRect().top - box.current.getBoundingClientRect().top + box.current.scrollTop - 32
    box.current.scrollTo({ top, behavior: scrollTo?.smooth && !reduce ? "smooth" : "auto" })
  }, [scrollTo, loaded])

  if (!src) return <div className={cn(frame, "grid place-items-center text-xs text-ink-10")}>No {device} screenshot</div>

  if (device === "mobile") {
    return (
      <div ref={box} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <img src={fileUrl(src)} alt={page.title ?? page.path} className="mx-auto block w-[390px] max-w-full rounded-3xl shadow-card" />
      </div>
    )
  }

  return (
    <div ref={box} className={frame}>
      <div className="relative @container" onMouseLeave={() => onHover(null)}>
        <img
          key={src}
          src={fileUrl(src)}
          alt={page.title ?? page.path}
          onLoad={() => setLoadedSrc(src)}
          className={cn("block w-full", !loaded && "animate-pulse bg-ink-3")}
          style={!loaded && W && page.desktopHeight && page.desktopKey ? { aspectRatio: `${W} / ${page.desktopHeight}` } : undefined}
        />
        {W
          ? sections.map((s, i) => {
            const on = i === active
            const hot = i === hover && !on
            return (
              <div
                key={s.key}
                data-section={i}
                aria-hidden
                onMouseEnter={() => onHover(i)}
                onClick={() => onPick(i)}
                className={cn("absolute inset-x-0 cursor-pointer -outline-offset-2", on ? "z-10 outline-2 outline-note" : hot && "outline-[1.5px] outline-note/70")}
                style={{ top: `${(s.y / W) * 100}cqw`, height: `${(s.height / W) * 100}cqw` }}
              >
                {(on || hot) && (
                  <span
                    className={cn(
                      "pointer-events-none absolute left-0 flex h-6 items-center bg-note px-2 text-2xs whitespace-nowrap text-note-ink tabular-nums",
                      // The first section starts at the top edge, where a tab above it would be cut off.
                      i === 0 ? "top-0 rounded-br-md" : "bottom-full rounded-t-md",
                    )}
                  >
                    {s.label}
                    {on && ` · ${W} × ${Math.round(s.height)}`}
                  </span>
                )}
              </div>
            )
          })
          : null}
      </div>
    </div>
  )
}

/** A section shown on its own while its page loads (or if the page is gone). */
function SectionStill({ section }: { section: SectionItem }) {
  return (
    <div className={frame}>
      <img src={fileUrl(section.key)} alt={section.label} className="block w-full" />
    </div>
  )
}

function AnimationPreview({ a }: { a: Animation }) {
  const src = fileUrl(a.gifKey)
  const box = "rounded-xl bg-surface-top shadow-card"
  return (
    <div className={stage}>
      {isVideoKey(a.gifKey) ? (
        <video
          key={src}
          src={src}
          poster={fileUrl(a.meta?.frames[0]?.key)}
          aria-label={motionLabel(a)}
          controls
          loop
          muted
          autoPlay
          playsInline
          disablePictureInPicture
          className={box}
          style={fit(a.width, a.height)}
        />
      ) : (
        <img src={src} alt={motionLabel(a)} className={box} style={fit(a.width, a.height)} />
      )}
    </div>
  )
}

function ImagePreview({ image }: { image: SavedImage }) {
  return (
    <div className={stage}>
      <img
        src={fileUrl(image.key)}
        alt={image.title ?? ""}
        // The thumbnail shows underneath until the original arrives.
        className="max-h-full max-w-full rounded-lg bg-cover shadow-card"
        style={{ ...(image.width && image.height ? fit(image.width, image.height) : {}), backgroundImage: `url(${fileUrl(image.thumbKey)})` }}
      />
    </div>
  )
}

function WebsitePreview({ reference, pages, failed }: { reference: Reference; pages: Page[] | undefined; failed: boolean }) {
  const cover = reference.coverKey ?? reference.previewKeys[0] ?? pages?.[0]?.desktopThumbKey
  return (
    <>
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl bg-surface-top shadow-card">
        {cover ? (
          <img src={fileUrl(cover)} alt={reference.title ?? reference.domain} className="size-full object-cover object-top" />
        ) : (
          <div className="grid size-full place-items-center text-xs text-ink-10">No cover yet</div>
        )}
      </div>
      {!failed && (pages === undefined || pages.length > 0) && (
        <div className="-mx-3 flex shrink-0 gap-3 overflow-x-auto px-3 pb-1 sm:-mx-5 sm:px-5">
          {pages
            ? pages.map((p) => (
                <Link key={p.id} href={`/r/${reference.id}?page=${p.id}`} className="group w-36 shrink-0 rounded-md">
                  <img
                    src={fileUrl(p.desktopThumbKey ?? p.mobileThumbKey)}
                    alt=""
                    loading="lazy"
                    className="aspect-[16/10] w-full rounded-md bg-ink-4 object-cover object-top shadow-card transition-[scale] duration-150 ease-out group-active:scale-[0.98]"
                  />
                  <span className="mt-1 block truncate text-2xs text-ink-11 group-hover:text-ink-12">{p.title || p.path}</span>
                </Link>
              ))
            : [0, 1, 2, 3].map((i) => <Skeleton key={i} className="aspect-[16/10] w-36 shrink-0 rounded-md" />)}
        </div>
      )}
    </>
  )
}

// ---------- Tabs ----------

function SectionList({
  page,
  active,
  hover,
  onHover,
  onSelect,
}: {
  page: Page
  active: number | null
  hover: number | null
  onHover: (i: number | null) => void
  onSelect: (i: number) => void
}) {
  return (
    <ol className="flex flex-col gap-1 p-3">
      {page.sections.map((s, i) => (
        <li key={s.key}>
          <button
            type="button"
            aria-current={i === active || undefined}
            onClick={() => onSelect(i)}
            onMouseEnter={() => onHover(i)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(i)}
            onBlur={() => onHover(null)}
            className={cn(
              "flex h-16 w-full items-center gap-3 rounded-md px-2 text-left transition-colors duration-150 ease-out focus-visible:-outline-offset-2",
              i === active ? "bg-ink-4" : i === hover ? "bg-ink-3" : "hover:bg-ink-3",
            )}
          >
            <img
              src={fileUrl(s.key)}
              alt=""
              loading="lazy"
              className="h-11 w-[72px] shrink-0 rounded-sm bg-ink-4 object-cover object-top outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
            />
            <span className="grid min-w-0">
              <span className="truncate text-xs text-ink-12">{s.label}</span>
              <span className="text-2xs text-ink-10 tabular-nums">{page.desktopWidth ? `${page.desktopWidth} × ${Math.round(s.height)}` : s.kind}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  )
}

/** Dark ink on light swatches, white on dark ones. Palette entries are "#rrggbb". */
const isLight = (hex: string) => {
  const n = parseInt(hex.slice(1, 7), 16)
  return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 150
}

function Palette({ colors }: { colors: string[] }) {
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = (c: string) => {
    // The tick shows on the click, before the clipboard answers.
    setCopied(c)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(null), 1200)
    navigator.clipboard?.writeText(c).catch(() => {
      setCopied(null)
      toast.error("Copy failed")
    })
  }
  return (
    <div className="grid grid-cols-3 gap-3 p-5">
      {colors.map((c) => (
        <button key={c} type="button" onClick={() => copy(c)} aria-label={`Copy ${c}`} className="press min-w-0 rounded-lg text-left">
          <span className="grid aspect-[4/3] place-items-center rounded-lg shadow-button" style={{ background: c }}>
            {copied === c && <CheckIcon className={cn("size-4", isLight(c) ? "text-black/70" : "text-white")} />}
          </span>
          <span className="mt-1.5 block truncate font-mono text-2xs text-ink-11 uppercase">{c}</span>
        </button>
      ))}
    </div>
  )
}

function MotionList({ animations, current, failed }: { animations: Animation[] | undefined; current?: string; failed: boolean }) {
  if (!animations) {
    if (failed) return <Empty title="Recordings didn't load" text="Try again above." />
    return (
      <div className="grid grid-cols-2 gap-3 p-5">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="aspect-video rounded-lg" />
        ))}
      </div>
    )
  }
  if (!animations.length) return <Empty title="No motion recorded" text="Scroll and hover recordings show up here when a capture finds them." />
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-4 p-5">
      {animations.map((a) => (
        <li key={a.id} className={cn("min-w-0 rounded-lg", a.id === current && "ring-2 ring-note ring-offset-2 ring-offset-card")}>
          <RecordingTile a={a} bare />
          <p className="mt-1.5 truncate text-2xs text-ink-11">
            {motionLabel(a)}
            {a.label && <span className="text-ink-10"> · {a.kind === "hover" ? "Hover" : "Scroll"}</span>}
          </p>
        </li>
      ))}
    </ul>
  )
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="grid place-items-center gap-1 px-8 py-12 text-center">
      <p className="text-xs text-ink-11">{title}</p>
      <p className="max-w-60 text-2xs text-pretty text-ink-10">{text}</p>
    </div>
  )
}

// ---------- Notes ----------

/** "Why you saved this": the website's note, saved shortly after typing stops, on blur, and on the way out. */
function Notes({ reference, onChange }: { reference: Reference; onChange: (notes: string | null) => void }) {
  const id = useId()
  const [value, setValue] = useState(reference.notes ?? "")
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  const saved = useRef(reference.notes ?? "")
  const draft = useRef(value)
  const timer = useRef<number | undefined>(undefined)
  const mounted = useRef(true)

  const save = useCallback(async () => {
    window.clearTimeout(timer.current)
    const next = draft.current.trim()
    const before = saved.current
    if (next === before) return
    saved.current = next
    // Cache first, so stepping to the next item and back shows the edit.
    onChange(next || null)
    setStatus("saving")
    try {
      await api.setNotes(reference.id, next)
      if (mounted.current) setStatus("saved")
    } catch {
      saved.current = before
      onChange(before || null)
      if (mounted.current) setStatus("failed")
      else toast.error("Couldn't save your note")
    }
  }, [reference.id])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      void save()
    }
  }, [save])

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-2xs text-ink-10">
          Why you saved this
        </label>
        <span aria-live="polite" className={cn("flex items-center gap-1.5 text-2xs text-ink-10", status === "failed" && "text-(--red-11)")}>
          {status === "saving" && "Saving…"}
          {status === "saved" && "Saved"}
          {status === "failed" && (
            <>
              Couldn't save
              <button type="button" onClick={() => void save()} className="press underline underline-offset-2 hover:text-ink-12">
                Retry
              </button>
            </>
          )}
        </span>
      </div>
      <textarea
        id={id}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          draft.current = e.target.value
          setStatus("idle")
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => void save(), 800)
        }}
        onBlur={() => void save()}
        maxLength={2000}
        rows={2}
        placeholder="What to borrow from it"
        className="well field-sizing-content max-h-40 min-h-16 w-full resize-none rounded-md p-3 text-xs leading-snug text-ink-12 outline-none placeholder:text-ink-10 pointer-coarse:text-base"
      />
    </>
  )
}
