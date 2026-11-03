import { useEffect, useRef } from "react"

/**
 * Calls `fn` while `active`, starting every 4s and backing off to 30s.
 * Pauses while the tab is hidden and polls once, with the delay reset, when it is shown again.
 */
export function usePoll(fn: () => unknown, active: boolean, { minMs = 4_000, maxMs = 30_000 } = {}) {
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!active) return
    let delay = minMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      clearTimeout(timer)
      if (document.hidden) return
      timer = setTimeout(() => {
        void fnRef.current()
        delay = Math.min(maxMs, Math.round(delay * 1.5))
        schedule()
      }, delay)
    }
    const onVisibility = () => {
      if (document.hidden) return clearTimeout(timer)
      delay = minMs
      void fnRef.current()
      schedule()
    }
    schedule()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [active, minMs, maxMs])
}
