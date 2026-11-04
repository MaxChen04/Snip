import { useEffect, useState, type Dispatch, type SetStateAction } from "react"

declare global {
  interface Window {
    snipDesktop?: {
      initialState: Record<string, unknown>
      remember: (key: string, value: unknown) => void
      checkQueue: () => void
    }
  }
}

// Only the desktop window stores this transient view state. It stays in the
// launcher while an idle renderer is released, and in its private restart cache.
export function useDesktopState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (window.snipDesktop) {
      try {
        const current = sessionStorage.getItem(key)
        if (current !== null) return JSON.parse(current) as T
      } catch {}
    }
    const saved = window.snipDesktop?.initialState[key]
    return saved === undefined ? initial : saved as T
  })
  useEffect(() => {
    if (!window.snipDesktop) return
    try {
      const serialized = JSON.stringify(value)
      const bytes = (text: string) => new TextEncoder().encode(text).length
      if (bytes(serialized) <= 16000) {
        const keys = Object.keys(sessionStorage).filter(name => name.startsWith("snip:") && name !== key)
        let size = keys.reduce((total, name) => total + bytes(sessionStorage.getItem(name) ?? ""), bytes(serialized))
        while (keys.length && (keys.length >= 40 || size > 48000)) {
          const oldest = keys.shift()!
          size -= bytes(sessionStorage.getItem(oldest) ?? "")
          sessionStorage.removeItem(oldest)
        }
        sessionStorage.setItem(key, serialized)
      }
    } catch {}
    window.snipDesktop.remember(key, value)
  }, [key, value])
  return [value, setValue]
}

// Keep the current reference view in the URL so fresh links and desktop
// renderer restoration both resolve to the same user-visible state.
export function referenceViewUrl(path: string, query: string, key: "tab" | "page", value: string | null) {
  const params = new URLSearchParams(query)
  if (value === null || (key === "tab" && value === "pages")) params.delete(key)
  else params.set(key, value)
  const next = params.toString()
  return `${path}${next ? `?${next}` : ""}`
}
