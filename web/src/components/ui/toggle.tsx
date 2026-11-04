"use client"

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center rounded-lg text-sm font-medium whitespace-nowrap text-ink-11 transition-[scale,background-color,color,box-shadow] duration-150 ease-out outline-none active:scale-[0.97] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-pressed:bg-control aria-pressed:text-foreground aria-pressed:shadow-toggle data-[pressed]:bg-control data-[pressed]:text-foreground data-[pressed]:shadow-toggle dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "bg-transparent",
      },
      size: {
        default: "h-8 min-w-8 gap-1.5 px-3",
        sm: "h-7 min-w-7 gap-1 rounded-md px-2.5",
        lg: "h-9 min-w-9 gap-1.5 px-3.5",
      },
    },
    compoundVariants: [
      { variant: "outline", size: "default", class: "px-2.75" },
      { variant: "outline", size: "sm", class: "px-2.25" },
      { variant: "outline", size: "lg", class: "px-3.25" },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
