import * as React from "react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full resize-none rounded-lg bg-field px-2.5 py-2 text-xs outline-0 transition-[color,background-color,box-shadow] duration-150 ease-out focus:bg-ink-4 placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-1 aria-invalid:ring-(--red-11)",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
