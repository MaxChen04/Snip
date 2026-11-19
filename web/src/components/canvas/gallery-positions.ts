import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { api, type LibraryPosition, type LibraryPositionsSnapshot } from "@/lib/api"
import type { Point } from "./gallery-placement"

type LayoutMove = { before: LibraryPosition[]; after: LibraryPosition[] }

export function tilePosition(key: string, point: Point): LibraryPosition {
  const i = key.indexOf(":")
  return { kind: key.slice(0, i) as LibraryPosition["kind"], id: key.slice(i + 1), x: point.x, y: point.y }
}

export function useGalleryPositions(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<LibraryPositionsSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const [optimistic, setOptimistic] = useState<LibraryPosition[]>([])
  const saved = useRef<LibraryPositionsSnapshot | null>(null)
  const busy = useRef(false)
  const queue = useRef<LibraryPosition[][]>([])
  const undo = useRef<LayoutMove[]>([])
  const redo = useRef<LayoutMove[]>([])

  const accept = useCallback((next: LibraryPositionsSnapshot) => {
    saved.current = next
    setSnapshot(next)
  }, [])

  const refresh = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      const next = await api.libraryPositions()
      if (saved.current && next.version !== saved.current.version) {
        undo.current = []
        redo.current = []
      }
      accept(next)
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      busy.current = false
    }
  }, [accept])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [enabled, refresh])

  const seed = useCallback(async (positions: LibraryPosition[]) => {
    if (!saved.current || busy.current || failed || positions.length === 0) return
    busy.current = true
    try {
      accept(await api.seedLibraryPositions(positions))
    } catch {
      setFailed(true)
    } finally {
      busy.current = false
    }
  }, [accept, failed])

  const send = (positions: LibraryPosition[]) => {
    queue.current.push(positions)
    setOptimistic(queue.current.flat())
    if (busy.current) return
    busy.current = true
    void (async () => {
      try {
        while (queue.current.length) {
          accept(await api.moveLibraryPositions(saved.current!.version, queue.current[0]!))
          queue.current.shift()
          setOptimistic(queue.current.flat())
        }
      } catch (error) {
        queue.current = []
        undo.current = []
        redo.current = []
        setOptimistic([])
        toast.error((error as { status?: number }).status === 409
          ? "The layout changed in another window. Your last moves weren’t saved."
          : "Couldn’t save the layout. Your last moves weren’t saved.")
        busy.current = false
        void refresh()
        return
      }
      busy.current = false
    })()
  }

  const move = (before: LibraryPosition[], after: LibraryPosition[]) => {
    if (!saved.current || failed || (busy.current && !queue.current.length)) return false
    undo.current.push({ before, after })
    redo.current = []
    send(after)
    return true
  }

  const step = (forward: boolean) => {
    if (!saved.current || failed || (busy.current && !queue.current.length)) return false
    const [from, to] = forward ? [redo, undo] : [undo, redo]
    const action = from.current.pop()
    if (!action) return false
    to.current.push(action)
    send(forward ? action.after : action.before)
    return true
  }

  const positions = useMemo(() => {
    const fixed = new Map<string, LibraryPosition>()
    for (const p of snapshot?.positions ?? []) fixed.set(`${p.kind}:${p.id}`, p)
    for (const p of optimistic) fixed.set(`${p.kind}:${p.id}`, p)
    return fixed
  }, [snapshot, optimistic])
  return { loaded: snapshot !== null, positions, failed, seed, move, step, refresh }
}
