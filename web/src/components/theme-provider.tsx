import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

export type Theme = "light" | "dark" | "system"

// The same key and values next-themes used, so a saved choice carries over.
const KEY = "theme"
const DARK = "(prefers-color-scheme: dark)"

const stored = (): Theme => {
  try {
    const value = localStorage.getItem(KEY)
    return value === "light" || value === "dark" ? value : "system"
  } catch {
    return "system"
  }
}

const resolve = (theme: Theme) => (theme === "system" ? (matchMedia(DARK).matches ? "dark" : "light") : theme)

/** The class Tailwind's dark variant keys off, plus color-scheme for built-in controls and scrollbars. */
function apply(resolved: "light" | "dark") {
  const root = document.documentElement
  root.classList.remove("light", "dark")
  root.classList.add(resolved)
  root.style.colorScheme = resolved
}

// Before the first render, so the first painted frame already has the right theme. The app's index.html does the
// same before any script loads. This is the job next-themes' inline <script> had; React never runs a <script> it
// renders on the client, so in this app it never did it.
apply(resolve(stored()))

const ThemeContext = createContext<{ theme: Theme; resolvedTheme: "light" | "dark"; setTheme: (theme: Theme) => void } | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState(stored)
  const [systemDark, setSystemDark] = useState(() => matchMedia(DARK).matches)
  const resolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme

  useEffect(() => apply(resolvedTheme), [resolvedTheme])
  useEffect(() => {
    const query = matchMedia(DARK)
    const onChange = () => setSystemDark(query.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  // A choice made in another window.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === KEY && setThemeState(stored())
    addEventListener("storage", onStorage)
    return () => removeEventListener("storage", onStorage)
  }, [])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    try {
      localStorage.setItem(KEY, next)
    } catch {}
  }, [])
  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error("useTheme needs a ThemeProvider")
  return context
}
