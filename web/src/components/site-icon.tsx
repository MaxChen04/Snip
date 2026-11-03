import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

/** Favicon for a domain, falling back to its first letter when the icon can't load. */
export function SiteIcon({ domain, className }: { domain: string; className?: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [domain])
  return broken ? (
    <span className={cn("grid size-4 shrink-0 place-items-center rounded-[4px] bg-fill-3 text-[9px] font-semibold text-muted-foreground uppercase", className)}>
      {domain.replace(/^www\./, "").slice(0, 1)}
    </span>
  ) : (
    <img src={`https://icons.duckduckgo.com/ip3/${domain}.ico`} alt="" onError={() => setBroken(true)} className={cn("size-4 shrink-0 rounded-[4px]", className)} />
  )
}
