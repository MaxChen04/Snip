import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-xl bg-ink-3", className)}
      {...props}
    />
  )
}

export { Skeleton }
