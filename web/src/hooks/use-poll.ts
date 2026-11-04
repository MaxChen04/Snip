import { useEffect, useRef } from "react"

/** Poll without overlapping requests; pause in hidden tabs and refresh when shown. */
export function usePoll(fn: () => unknown, active: boolean, { minMs = 4_000, maxMs = 30_000 } = {}) {
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!active) return
    let delay = minMs
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let running = false
    let refreshOnFinish = false
    let resetAfterRefresh = false

    const schedule = () => {
      clearTimeout(timer)
      if (!stopped && !document.hidden) timer = setTimeout(() => void poll(), delay)
    }
    const poll = async () => {
      if (stopped || document.hidden) return
      if (running) {
        refreshOnFinish = true
        return
      }
      running = true
      try {
        await fnRef.current()
      } catch {
        // The caller owns error display; a rejected refresh must not stop polling.
      } finally {
        running = false
        if (stopped || document.hidden) return
        if (refreshOnFinish) {
          refreshOnFinish = false
          void poll()
        } else {
          if (resetAfterRefresh) resetAfterRefresh = false
          else delay = Math.min(maxMs, Math.round(delay * 1.5))
          schedule()
        }
      }
    }
    const onVisibility = () => {
      clearTimeout(timer)
      if (document.hidden) {
        refreshOnFinish = false
        return
      }
      delay = minMs
      resetAfterRefresh = true
      void poll()
    }
    schedule()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [active, minMs, maxMs])
}
