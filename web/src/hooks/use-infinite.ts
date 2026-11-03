import { useCallback, useEffect, useRef, useState } from "react"
import type { Paged } from "@/lib/api"

/** Cursor-paged list with load-more and an IntersectionObserver sentinel. */
export function useInfinite<T extends { id: string }>(
  fetchPage: (cursor: string | null) => Promise<Paged<T>>,
  deps: unknown[],
) {
  const [items, setItems] = useState<T[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const gen = useRef(0)
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage

  const load = useCallback(async (reset: boolean, from: string | null) => {
    const g = reset ? ++gen.current : gen.current
    setLoading(true)
    try {
      const page = await fetchRef.current(from)
      if (g !== gen.current) return
      setItems((prev) => (reset ? page.items : [...prev, ...page.items.filter((i) => !prev.some((p) => p.id === i.id))]))
      setCursor(page.nextCursor)
      setDone(!page.nextCursor)
      setError(null)
    } catch (e) {
      if (g === gen.current) setError(e as Error)
    } finally {
      if (g === gen.current) setLoading(false)
    }
  }, [])

  const reload = useCallback(() => load(true, null), [load])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void reload(), deps)

  const sentinel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loading && !done) void load(false, cursor)
      },
      { rootMargin: "800px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [cursor, done, loading, load])

  /** Re-fetch the loaded window in place (for polling in-progress captures). */
  const refreshHead = useCallback(async () => {
    try {
      const page = await fetchRef.current(null)
      setItems((prev) => {
        const fresh = new Map(page.items.map((i) => [i.id, i]))
        const merged = prev.map((p) => fresh.get(p.id) ?? p)
        const newOnes = page.items.filter((i) => !prev.some((p) => p.id === i.id))
        return [...newOnes, ...merged]
      })
    } catch {
      /* ignore */
    }
  }, [])

  return { items, setItems, loading, done, error, reload, refreshHead, sentinel }
}
