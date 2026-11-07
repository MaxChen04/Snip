import type { ReactNode } from "react"
import { Link } from "wouter"
import { Logo } from "@/components/brand"
import { cn } from "@/lib/utils"

/**
 * The frame shared by the four small sign-in pages. Same surface, type scale and ring as the rest
 * of the app, held to one narrow column so nothing competes with the single action.
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
  wide,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  return (
    <div className="grid min-h-svh place-items-center bg-background px-4 py-10">
      <main className={cn("w-full", wide ? "max-w-[520px]" : "max-w-[400px]")}>
        <Link href="/" className="mb-6 flex items-center justify-center gap-2" aria-label="Snip">
          <Logo className="size-8" />
          <span className="text-[15px] font-semibold tracking-[-0.025em]">Snip</span>
        </Link>
        <div className="rounded-2xl bg-card p-6 shadow-card ring-1 ring-border/60">
          <h1 className="font-heading text-[17px] leading-snug font-medium tracking-[-0.02em] text-balance">{title}</h1>
          {description ? <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p> : null}
          <div className="mt-5">{children}</div>
        </div>
        {footer ? <div className="mt-4 text-center text-xs text-muted-foreground [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-foreground">{footer}</div> : null}
      </main>
    </div>
  )
}

/** Inline failure text, styled like the app's field errors rather than a browser alert. */
export function AuthError({ children }: { children?: ReactNode }) {
  if (!children) return null
  return (
    <p role="alert" className="mt-3 text-[12.5px] leading-relaxed text-destructive">
      {children}
    </p>
  )
}
