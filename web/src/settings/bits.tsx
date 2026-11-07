import type { ReactNode } from "react"
import { cn } from "cn"
import { Separator } from "@/components/ui/separator"

export function Panel({ title, badge, description, children, className }: { title: string; badge?: ReactNode; description?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={cn("overflow-hidden rounded-xl bg-card text-sm shadow-card", className)}>
      <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-heading text-sm font-medium">{title}</h2>
            {badge}
          </div>
          {description ? <p className="mt-1 text-xs leading-[1.5] text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {children}
    </section>
  )
}

export function Row({ icon, title, body, action, className }: { icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <>
      <Separator className="bg-border/60" />
      <div className={cn("flex items-start gap-3 px-5 py-3.5", className)}>
        {icon ? <span className="mt-0.5 text-ink-9">{icon}</span> : null}
        <div className="min-w-0 flex-1">
          <div className="text-sm leading-5">{title}</div>
          {body ? <div className="mt-0.5 text-xs leading-[1.5] text-muted-foreground">{body}</div> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-1.5">{action}</div> : null}
      </div>
    </>
  )
}

export function Meta({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>
}

/** "42 references" — never "1 references". */
export function references(count: number | null | undefined) {
  if (count == null) return "Some references"
  if (count === 1) return "1 reference"
  return `${count.toLocaleString()} references`
}
