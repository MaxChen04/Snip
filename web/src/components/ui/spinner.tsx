import { cn } from "cn"
import { Loader2Icon } from "@/components/icons"

/** Activity: an action is running. The one spinner in the app; see the loading notes in index.css. */
function Spinner({ className, ...props }: Omit<React.ComponentProps<"svg">, "strokeWidth">) {
  return <Loader2Icon data-slot="spinner" role="status" aria-label="Loading" className={cn("spinner size-4 shrink-0", className)} {...props} />
}

export { Spinner }
