import { useEffect, useState } from "react"
import { fileUrl } from "@/lib/api"
import { cn } from "@/lib/utils"

/** The icon saved with a website's capture, or the domain's first letter when there is none (older captures) or it can't load. */
export function SiteIcon({ domain, icon, className }: { domain: string; icon?: string | null; className?: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [icon])
  return icon && !broken ? (
    <img src={fileUrl(icon)} alt="" onError={() => setBroken(true)} className={cn("size-4 shrink-0 rounded-[4px]", className)} />
  ) : (
    <span className={cn("grid size-4 shrink-0 place-items-center rounded-[4px] bg-fill-3 text-[9px] font-semibold text-muted-foreground uppercase", className)}>
      {domain.replace(/^www\./, "").slice(0, 1)}
    </span>
  )
}
