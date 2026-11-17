import { cn } from "cn"
import { Loader2Icon } from "@/components/icons"

/**
 * Activity: an action is running. The one spinner in the app; see the loading notes in index.css. On its own it is a
 * "Loading" status; beside words that already say what is happening (a button label, "Uploading…"), pass aria-hidden.
 */
function Spinner({ className, ...props }: Omit<React.ComponentProps<"svg">, "strokeWidth">) {
  return <Loader2Icon data-slot="spinner" role="status" aria-label="Loading" aria-hidden={false} className={cn("spinner size-4 shrink-0", className)} {...props} />
}

export { Spinner }
