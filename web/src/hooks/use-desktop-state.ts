import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react"

declare global {
  interface Window {
    snipDesktop?: {
      initialState: Record<string, unknown>
      remember: (key: string, value: unknown) => void
      checkQueue: () => void
    }
  }
}

function stored<T>(key: string, initial: T): T {
  if (window.snipDesktop) {
    try {
      const current = sessionStorage.getItem(key)
      if (current !== null) return JSON.parse(current) as T
    } catch {}
  }
  const saved = window.snipDesktop?.initialState[key]
  return saved === undefined ? initial : saved as T
}

// Only the desktop window stores this transient view state. It stays in the
// launcher while an idle renderer is released, and in its private restart cache.
// A new key (another website's selection) reads that key's own stored value.
export function useDesktopState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState(() => ({ key, value: stored(key, initial) }))
  if (state.key !== key) setState({ key, value: stored(key, initial) })
  const value = state.key === key ? state.value : stored(key, initial)
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => setState((s) => ({ key: s.key, value: typeof next === "function" ? (next as (prev: T) => T)(s.value) : next })),
    [],
  )
  useEffect(() => {
    if (!window.snipDesktop || state.key !== key) return
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
  }, [key, state.key, value])
  return [value, setValue]
}
