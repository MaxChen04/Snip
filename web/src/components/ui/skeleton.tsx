import { cn } from "cn"

/**
 * Pending: content that will appear in this place. The one placeholder in the app; see the loading notes in index.css.
 * Children are a label for what is coming (a page's path, "6 more queued"), centred and still while the fill breathes.
 */
function Skeleton({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("skeleton rounded-xl", children != null && "flex flex-col items-center justify-center gap-1 px-3 text-2xs text-ink-11", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export { Skeleton }
