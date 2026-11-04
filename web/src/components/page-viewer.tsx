import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  MonitorIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  SmartphoneIcon,
  XIcon,
} from "@/components/icons"
import { notify } from "@/components/notify"
import { TokensPanel } from "@/components/tokens-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { fileUrl, type Page } from "@/lib/api"
import { readPref, writePref } from "@/lib/prefs"

// ---------- Resizable sidebar ----------

const MIN_WIDTH = 260
const DEFAULT_WIDTH = 360
const WIDTH_KEY = "snip.viewer.sidebarWidth"
const OPEN_KEY = "snip.viewer.sidebarOpen"
const TAB_KEY = "snip.viewer.sidebarTab"

const maxWidth = () => Math.max(MIN_WIDTH, Math.min(960, Math.round(window.innerWidth * 0.6)))
const clampWidth = (w: number) => Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, w)))

function useSidebarWidth() {
  const [width, setWidth] = useState(() => clampWidth(Number(readPref(WIDTH_KEY, String(DEFAULT_WIDTH))) || DEFAULT_WIDTH))
  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w))
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  const commit = useCallback((w: number) => {
    const next = clampWidth(w)
    setWidth(next)
    writePref(WIDTH_KEY, String(next))
  }, [])
  return [width, setWidth, commit] as const
}

function ResizeHandle({ width, onDrag, onCommit }: { width: number; onDrag: (w: number) => void; onCommit: (w: number) => void }) {
  const drag = useRef<{ x: number; w: number; last: number; cursor: string; userSelect: string } | null>(null)
  const [active, setActive] = useState(false)

  useEffect(() => () => {
    if (!drag.current) return
    document.body.style.cursor = drag.current.cursor
    document.body.style.userSelect = drag.current.userSelect
    drag.current = null
  }, [])

  const end = (e: React.PointerEvent) => {
    const current = drag.current
    if (!current) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    onCommit(current.last)
    setActive(false)
    document.body.style.cursor = current.cursor
    document.body.style.userSelect = current.userSelect
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={maxWidth()}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      className="group relative z-10 -mr-1.5 hidden w-3 shrink-0 cursor-col-resize touch-none outline-none lg:block"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, w: width, last: width, cursor: document.body.style.cursor, userSelect: document.body.style.userSelect }
        setActive(true)
        document.body.style.cursor = "col-resize"
        document.body.style.userSelect = "none"
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        // The sidebar sits on the right, so dragging left widens it.
        const next = clampWidth(drag.current.w + (drag.current.x - e.clientX))
        drag.current.last = next
        onDrag(next)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => onCommit(DEFAULT_WIDTH)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16
        if (e.key === "ArrowLeft") onCommit(width + step)
        else if (e.key === "ArrowRight") onCommit(width - step)
        else if (e.key === "Home") onCommit(MIN_WIDTH)
        else if (e.key === "End") onCommit(maxWidth())
        else return
        e.preventDefault()
      }}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-[width,background-color] group-hover:w-0.5 group-hover:bg-primary/60 group-focus-visible:w-0.5 group-focus-visible:bg-primary",
          active && "w-0.5 bg-primary",
        )}
      />
    </div>
  )
}

// ---------- Viewer ----------

type SideTab = "tokens" | "html" | "css"

export function PageViewer({ page, onClose }: { page: Page; onClose: () => void }) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop")
  const key = device === "desktop" ? page.desktopKey : page.mobileKey
  const [width, setWidth, commitWidth] = useSidebarWidth()
  const [open, setOpenState] = useState(() => readPref(OPEN_KEY, window.innerWidth >= 1024 ? "1" : "0") === "1")
  const setOpen = (v: boolean) => {
    setOpenState(v)
    writePref(OPEN_KEY, v ? "1" : "0")
  }

  const tabs = useMemo(() => {
    const t: { value: SideTab; label: string }[] = []
    if (page.tokens) t.push({ value: "tokens", label: "Tokens" })
    if (page.snapshotKey) t.push({ value: "html", label: "HTML" })
    if (page.stylesKey) t.push({ value: "css", label: "CSS" })
    return t
  }, [page.tokens, page.snapshotKey, page.stylesKey])
  const [tabPref, setTabPref] = useState<SideTab>(() => readPref<SideTab>(TAB_KEY, "tokens"))
  const tab = tabs.some((t) => t.value === tabPref) ? tabPref : tabs[0]?.value

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = ""
    }
  }, [onClose])

  const showSidebar = open && tabs.length > 0

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background" role="dialog" aria-modal="true">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
        <div className="min-w-0 flex-1 basis-40">
          <div className="truncate text-sm font-medium">{page.title || page.path}</div>
          <a href={page.url} target="_blank" rel="noreferrer" className="block truncate text-2xs text-muted-foreground hover:text-foreground">
            {page.url}
          </a>
        </div>
        <ToggleGroup variant="outline" size="sm" value={[device]} onValueChange={(v) => v[0] && setDevice(v[0] as "desktop" | "mobile")}>
          <ToggleGroupItem value="desktop" aria-label="Desktop">
            <MonitorIcon /> <span className="hidden sm:inline">Desktop</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="mobile" aria-label="Mobile">
            <SmartphoneIcon /> <span className="hidden sm:inline">Mobile</span>
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="flex flex-1 basis-0 justify-end">
          {tabs.length > 0 && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={open ? "Hide sidebar" : "Show sidebar"}
              aria-pressed={open}
              title={open ? "Hide sidebar" : "Show tokens, HTML and CSS"}
              onClick={() => setOpen(!open)}
            >
              {open ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-fill-1 p-4 sm:p-6">
          {key ? (
            <img
              src={fileUrl(key)}
              alt=""
              className={device === "desktop" ? "mx-auto w-full max-w-6xl rounded-lg shadow-card" : "mx-auto w-[390px] max-w-full rounded-3xl shadow-card"}
            />
          ) : (
            <p className="py-24 text-center text-sm text-muted-foreground">No {device} screenshot.</p>
          )}
        </div>

        {showSidebar && tab && (
          <>
            <ResizeHandle width={width} onDrag={setWidth} onCommit={commitWidth} />
            <aside
              style={{ "--sidebar-w": `${width}px` } as React.CSSProperties}
              className="flex h-[45svh] min-h-0 w-full shrink-0 flex-col border-t border-border lg:h-auto lg:w-(--sidebar-w) lg:border-t-0"
            >
              <Tabs
                value={tab}
                onValueChange={(v) => {
                  setTabPref(v as SideTab)
                  writePref(TAB_KEY, v as string)
                }}
                className="min-h-0 flex-1 flex-col gap-0"
              >
                <div className="flex shrink-0 items-center px-4 pt-3 pb-2">
                  <TabsList>
                    {tabs.map((t) => (
                      <TabsTrigger key={t.value} value={t.value}>
                        {t.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
                {page.tokens && (
                  <TabsContent value="tokens" className="min-h-0 overflow-y-auto px-4 pt-2 pb-6">
                    <TokensPanel tokens={page.tokens} compact />
                  </TabsContent>
                )}
                {page.snapshotKey && (
                  <TabsContent value="html" className="flex min-h-0 flex-col">
                    <HtmlPanel fileKey={page.snapshotKey} />
                  </TabsContent>
                )}
                {page.stylesKey && (
                  <TabsContent value="css" className="flex min-h-0 flex-col">
                    <CssPanel fileKey={page.stylesKey} />
                  </TabsContent>
                )}
              </Tabs>
            </aside>
          </>
        )}
      </div>
    </div>
  )
}

// ---------- Captured files ----------

function useFileText(key: string) {
  const [state, setState] = useState<{ text?: string; error?: string }>({})
  useEffect(() => {
    const controller = new AbortController()
    setState({})
    // Captures already use the browser's immutable HTTP cache. Keep the decoded
    // text only while its panel is mounted, and cancel unfinished reads on close.
    fetch(fileUrl(key)!, { credentials: "same-origin", signal: controller.signal }).then((r) => {
      if (!r.ok) throw new Error(r.status === 404 ? "File missing from storage" : `Could not load (HTTP ${r.status})`)
      return r.text()
    }).then(
      (text) => !controller.signal.aborted && setState({ text }),
      (e: Error) => !controller.signal.aborted && setState({ error: e.message }),
    )
    return () => controller.abort()
  }, [key])
  return state
}

const copyText = (text: string, what: string) => {
  navigator.clipboard?.writeText(text).then(
    () => notify(`Copied ${what}`),
    () => notify("Copy failed"),
  )
}

const formatSize = (chars: number) => (chars < 1024 ? `${chars} B` : chars < 1024 * 1024 ? `${(chars / 1024).toFixed(0)} KB` : `${(chars / 1024 / 1024).toFixed(1)} MB`)

function PanelState({ error }: { error?: string }) {
  return (
    <div className="grid flex-1 place-items-center p-6 text-xs text-muted-foreground">
      {error ? error : <Spinner />}
    </div>
  )
}

function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pb-2">{children}</div>
}

const codeBox = "min-h-0 flex-1 overflow-auto border-t border-border bg-fill-1 px-4 py-3 font-mono text-[11px] leading-relaxed"

// ---------- HTML ----------

const HTML_STEP = 150_000

/** Long data: URIs (inlined fonts and images) make snapshots unreadable; shorten them for display only. */
const shortenDataUris = (html: string) => html.replace(/data:([\w/+.-]+)?[;,][^"')\s]{80,}/g, (m, type: string | undefined) => `data:${type ?? ""}…(${formatSize(m.length)})`)

function HtmlPanel({ fileKey }: { fileKey: string }) {
  const { text, error } = useFileText(fileKey)
  const [wrap, setWrap] = useState(true)
  const [limit, setLimit] = useState(HTML_STEP)
  const display = useMemo(() => (text ? shortenDataUris(text) : ""), [text])
  const shown = display.slice(0, limit)

  return (
    <>
      <Toolbar>
        <span className="mr-auto text-2xs text-muted-foreground">{text ? `Snapshot · ${formatSize(text.length)}` : "Snapshot"}</span>
        <Button variant="ghost" size="xs" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
          {wrap ? "No wrap" : "Wrap"}
        </Button>
        <Button variant="outline" size="xs" disabled={!text} onClick={() => text && copyText(text, "HTML")}>
          <CopyIcon data-icon="inline-start" /> Copy
        </Button>
        <Button variant="outline" size="xs" render={<a href={fileUrl(fileKey)} target="_blank" rel="noreferrer" />} nativeButton={false}>
          <ExternalLinkIcon data-icon="inline-start" /> Open
        </Button>
      </Toolbar>
      {text === undefined ? (
        <PanelState error={error} />
      ) : (
        <div className={codeBox}>
          <pre className={cn(wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre")}>
            <HighlightedHtml html={shown} />
          </pre>
          {display.length > limit && (
            <Button variant="outline" size="xs" className="mt-3" onClick={() => setLimit((l) => l + HTML_STEP)}>
              Show more ({formatSize(display.length - limit)} left)
            </Button>
          )}
        </div>
      )}
    </>
  )
}

function HighlightedHtml({ html }: { html: string }) {
  const parts = useMemo(() => html.split(/(<[^>]*>)/g), [html])
  return (
    <>
      {parts.map((part, i) => {
        if (!part.startsWith("<")) return part
        const m = /^<(\/?)([\w:-]+)([\s\S]*)$/.exec(part)
        if (!m) return <span key={i} className="text-muted-foreground">{part}</span>
        return (
          <span key={i} className="text-muted-foreground">
            {"<"}
            {m[1]}
            <span className="text-primary">{m[2]}</span>
            {m[3]}
          </span>
        )
      })}
    </>
  )
}

// ---------- CSS ----------

type StyleMap = Record<string, string>
type StyleElement = { sel?: string; tag?: string; text?: string; rect?: { w: number; h: number }; styles?: StyleMap; before?: StyleMap; after?: StyleMap }
type Styles = {
  truncated?: boolean
  elements?: StyleElement[]
  keyframes?: { name: string; css: string }[]
  hoverRules?: string[]
  fontFaces?: string[]
  cssVariables?: StyleMap
}
type CssSection = "elements" | "variables" | "keyframes" | "hover" | "fonts"

type Rule = { selector: string; decls: [string, string][]; note?: string }

const ELEMENT_STEP = 120

const ruleText = (r: Rule) => `${r.note ? `/* ${r.note} */\n` : ""}${r.selector} {\n${r.decls.map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}`

/**
 * Rule text from the stylesheet is one line; break it into one declaration per line.
 * Quoted strings (data: URLs, font names) are never reformatted.
 * With `shorten`, long data: URLs are elided for display only.
 */
function prettyRule(css: string, shorten = false) {
  let out = ""
  let depth = 0
  const pad = () => "  ".repeat(depth)
  for (const [i, part] of css.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g).entries()) {
    if (i % 2) {
      out += shorten && part.length > 200 && /^["']data:/.test(part) ? `${part.slice(0, 40)}…${part[0]}` : part
      continue
    }
    for (const ch of part) {
      if (ch === "{") {
        depth++
        out = out.trimEnd() + " {\n" + pad()
      } else if (ch === ";") out = out.trimEnd() + ";\n" + pad()
      else if (ch === "}") {
        depth = Math.max(0, depth - 1)
        out = out.trimEnd() + "\n" + pad() + "}\n" + pad()
      } else if (/\s/.test(ch) && /\s$/.test(out)) continue
      else out += ch
    }
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim()
}

type RawBlock = { display: string; copy: string }
// Copy the captured rule verbatim; display formatting must never change its meaning.
const rawBlock = (css: string): RawBlock => ({ display: prettyRule(css, true), copy: css })

function elementRules(e: StyleElement): Rule[] {
  const sel = e.sel || e.tag || "element"
  const out: Rule[] = []
  const decls = Object.entries(e.styles ?? {})
  const note = [e.text ? `"${e.text.slice(0, 60)}${e.text.length > 60 ? "…" : ""}"` : null, e.rect ? `${e.rect.w}×${e.rect.h}` : null].filter(Boolean).join(" · ")
  if (decls.length || e.before || e.after) out.push({ selector: sel, decls, note: note || undefined })
  if (e.before) out.push({ selector: `${sel}::before`, decls: Object.entries(e.before) })
  if (e.after) out.push({ selector: `${sel}::after`, decls: Object.entries(e.after) })
  return out
}

function CssPanel({ fileKey }: { fileKey: string }) {
  const { text, error: loadError } = useFileText(fileKey)
  const parsed = useMemo(() => {
    if (text === undefined) return null
    try {
      return { styles: JSON.parse(text) as Styles }
    } catch {
      return { error: "The styles file could not be parsed." }
    }
  }, [text])
  const s = parsed?.styles
  const [section, setSection] = useState<CssSection>("elements")
  const [filter, setFilter] = useState("")
  const [limit, setLimit] = useState(ELEMENT_STEP)
  useEffect(() => setLimit(ELEMENT_STEP), [filter, section, fileKey])

  const counts: Record<CssSection, number> = {
    elements: s?.elements?.length ?? 0,
    variables: Object.keys(s?.cssVariables ?? {}).length,
    keyframes: s?.keyframes?.length ?? 0,
    hover: s?.hoverRules?.length ?? 0,
    fonts: s?.fontFaces?.length ?? 0,
  }

  const q = filter.trim().toLowerCase()
  const elementRuleList = useMemo(() => {
    if (!s?.elements || section !== "elements") return []
    return s.elements
      .filter((e) => !q || e.sel?.toLowerCase().includes(q) || e.text?.toLowerCase().includes(q))
      .flatMap(elementRules)
  }, [s, section, q])

  const blocks = useMemo(() => {
    if (!s || section === "elements") return []
    const match = (x: string) => !q || x.toLowerCase().includes(q)
    if (section === "variables") {
      const decls = Object.entries(s.cssVariables ?? {}).filter(([k, v]) => match(k) || match(v))
      if (!decls.length) return []
      const text = ruleText({ selector: ":root", decls })
      return [{ display: text, copy: text }]
    }
    if (section === "keyframes") return (s.keyframes ?? []).filter((k) => match(k.css)).map((k) => rawBlock(k.css))
    if (section === "hover") return (s.hoverRules ?? []).filter(match).map(rawBlock)
    return (s.fontFaces ?? []).filter(match).map(rawBlock)
  }, [s, section, q])

  const total = section === "elements" ? elementRuleList.length : blocks.length
  const allText = () => (section === "elements" ? elementRuleList.map(ruleText) : blocks.map((b) => b.copy)).join("\n\n")

  return (
    <>
      <Toolbar>
        <NativeSelect size="sm" value={section} onChange={(e) => setSection(e.target.value as CssSection)} aria-label="CSS section" className="min-w-0">
          <NativeSelectOption value="elements">Elements ({counts.elements})</NativeSelectOption>
          <NativeSelectOption value="variables">Variables ({counts.variables})</NativeSelectOption>
          <NativeSelectOption value="keyframes">Keyframes ({counts.keyframes})</NativeSelectOption>
          <NativeSelectOption value="hover">Hover rules ({counts.hover})</NativeSelectOption>
          <NativeSelectOption value="fonts">Font faces ({counts.fonts})</NativeSelectOption>
        </NativeSelect>
        <span className="mr-auto" />
        <Button variant="outline" size="xs" disabled={!total} onClick={() => copyText(allText(), q ? `${total} matching rules` : "CSS")}>
          <CopyIcon data-icon="inline-start" /> Copy
        </Button>
        <Button variant="outline" size="xs" render={<a href={`${fileUrl(fileKey)}?download=1`} />} nativeButton={false} title="Download the raw computed styles JSON">
          <DownloadIcon data-icon="inline-start" /> JSON
        </Button>
      </Toolbar>
      <div className="shrink-0 px-4 pb-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={section === "elements" ? "Filter by selector or text, e.g. nav, button" : "Filter"}
          className="h-7 text-xs"
          aria-label="Filter CSS"
        />
      </div>
      {!parsed || parsed.error ? (
        <PanelState error={parsed?.error ?? loadError} />
      ) : (
        <div className={codeBox}>
          <p className="mb-3 font-sans text-2xs text-muted-foreground">
            Computed styles from the desktop render, minus browser defaults. These are observed values, not the site's source CSS.
            {section === "elements" && s?.truncated && " Element capture hit its limit, so later elements are missing."}
          </p>
          {!total && <p className="font-sans text-xs text-muted-foreground">{q ? "No matches." : "Nothing captured here."}</p>}
          {section === "elements" ? (
            <>
              {elementRuleList.slice(0, limit).map((r, i) => (
                <RuleView key={i} rule={r} />
              ))}
              {total > limit && (
                <Button variant="outline" size="xs" className="font-sans" onClick={() => setLimit((l) => l + ELEMENT_STEP)}>
                  Show more ({total - limit} left)
                </Button>
              )}
            </>
          ) : (
            blocks.map((b, i) => <RawRule key={i} block={b} />)
          )}
        </div>
      )}
    </>
  )
}

function RuleView({ rule }: { rule: Rule }) {
  return (
    <pre className="group/rule relative mb-3 break-all whitespace-pre-wrap">
      <CopyRuleButton text={ruleText(rule)} />
      {rule.note && <span className="text-muted-foreground/70">{`/* ${rule.note} */\n`}</span>}
      <span className="text-primary">{rule.selector}</span>
      {" {\n"}
      {rule.decls.map(([k, v]) => (
        <span key={k}>
          {"  "}
          <span className="text-muted-foreground">{k}</span>: {v};{"\n"}
        </span>
      ))}
      {"}"}
    </pre>
  )
}

function RawRule({ block }: { block: RawBlock }) {
  return (
    <pre className="group/rule relative mb-3 break-all whitespace-pre-wrap">
      <CopyRuleButton text={block.copy} />
      {block.display}
    </pre>
  )
}

function CopyRuleButton({ text }: { text: string }) {
  return (
    <button
      aria-label="Copy rule"
      title="Copy rule"
      onClick={() => copyText(text, "rule")}
      className="absolute top-0 right-0 grid size-6 place-items-center rounded-md bg-background text-muted-foreground opacity-0 ring-1 ring-border transition-opacity group-hover/rule:opacity-100 hover:text-foreground focus-visible:opacity-100 [&_svg]:size-3"
    >
      <CopyIcon />
    </button>
  )
}
