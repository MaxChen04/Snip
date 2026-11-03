import { useEffect, useState } from "react"

export type GridSize = "s" | "m" | "l"

export const readPref = <T extends string>(key: string, fallback: T): T => {
  try {
    return (localStorage.getItem(key) as T) || fallback
  } catch {
    return fallback
  }
}

export const writePref = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* ignore */
  }
}

const EVENT = "rs:grid"

export function useGridSize(): [GridSize, (g: GridSize) => void] {
  const [grid, setGrid] = useState<GridSize>(() => readPref("rs.grid", "m"))
  useEffect(() => {
    const on = () => setGrid(readPref("rs.grid", "m"))
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [])
  return [
    grid,
    (g) => {
      writePref("rs.grid", g)
      window.dispatchEvent(new Event(EVENT))
    },
  ]
}

export const masonryCols: Record<GridSize, string> = {
  s: "columns-2 sm:columns-3 lg:columns-5 2xl:columns-6",
  m: "columns-1 sm:columns-2 lg:columns-4 2xl:columns-5",
  l: "columns-1 md:columns-2 xl:columns-3",
}
