import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useLocation } from "wouter"
import { AddReferenceDialog } from "@/components/add-reference-dialog"
import { trackCapture } from "@/components/canvas/capture-card"
import { ConnectMcpDialog } from "@/components/connect-mcp-dialog"
import { extractUrls } from "@/lib/site-url"

// One place that owns the "Create" dialogs so the top bar, board views and empty
// states on any page open the same flow.

type Ctx = { addReference: (collectionId?: string, url?: string) => void; connectMcp: () => void }
const AddFlowCtx = createContext<Ctx>({ addReference: () => {}, connectMcp: () => {} })
export const useAddFlow = () => useContext(AddFlowCtx)

/** True while the user is typing somewhere, so global shortcuts stay out of the way. */
const typing = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
}
const dialogOpen = () => !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')
/** The board being viewed (/b/:id, or the older /?collection=:id), so new material lands on it. */
const currentBoard = () =>
  window.location.pathname.match(/^\/b\/([^/]+)/)?.[1] ?? new URLSearchParams(window.location.search).get("collection") ?? undefined

export function AddFlowProvider({ children }: { children: ReactNode }) {
  const [adding, setAdding] = useState<{ collection?: string; url?: string; n: number } | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [location, navigate] = useLocation()
  const open = (collection?: string, url?: string) => setAdding((a) => ({ collection, url, n: (a?.n ?? 0) + 1 }))

  // The bookmarklet sends the current tab to /add?url=…
  useEffect(() => {
    // Checks the real URL so a repeated effect (React strict mode) can't open it twice.
    if (location !== "/add" || window.location.pathname !== "/add") return
    const url = new URLSearchParams(window.location.search).get("url") ?? undefined
    navigate("/", { replace: true })
    open(undefined, url)
  }, [location, navigate])

  // Paste a URL anywhere in the app to add it; "/" jumps to search.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // The canvas capture card takes its own pastes (data-capture-input).
      if (typing(e.target) || (e.target as Element | null)?.closest?.("[data-capture-input]") || dialogOpen()) return
      const text = e.clipboardData?.getData("text") ?? ""
      const found = extractUrls(text)
      if (!found.length) return
      e.preventDefault()
      open(currentBoard(), found.map((u) => u.href).join(" "))
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || dialogOpen()) return
      const search = document.querySelector<HTMLInputElement>("[data-search]")
      if (!search) return
      e.preventDefault()
      search.focus()
      search.select()
    }
    window.addEventListener("paste", onPaste)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("paste", onPaste)
      window.removeEventListener("keydown", onKey)
    }
  }, [])

  return (
    <AddFlowCtx.Provider
      value={{
        addReference: open,
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
        // Captures started here show on the canvas capture card too.
        onCreated={(r) => trackCapture(r.id)}
      />
      <ConnectMcpDialog open={connecting} onOpenChange={setConnecting} />
    </AddFlowCtx.Provider>
  )
}
