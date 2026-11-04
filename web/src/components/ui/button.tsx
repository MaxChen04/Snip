import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center text-xs font-medium tracking-[-0.01em] whitespace-nowrap select-none transition-[scale,background-color,color,box-shadow,opacity] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60 aria-invalid:ring-2 aria-invalid:ring-destructive/20 aria-invalid:outline-destructive dark:aria-invalid:ring-destructive/40 dark:aria-invalid:outline-destructive/50 [&_[data-badge]]:inline-flex [&_[data-badge]]:h-5 [&_[data-badge]]:min-w-5 [&_[data-badge]]:shrink-0 [&_[data-badge]]:items-center [&_[data-badge]]:justify-center [&_[data-badge]]:rounded-xs [&_[data-badge]]:px-1 [&_[data-badge]]:text-2xs [&_[data-badge]]:font-medium [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // One per surface: the next step. A ring in the surface colour, no drop in light.
        default:
          "bg-primary text-primary-foreground shadow-primary hover:bg-(--primary-hover) dark:disabled:bg-ink-4 dark:disabled:text-ink-8 dark:disabled:opacity-100 dark:disabled:shadow-none [&_[data-badge]]:bg-primary-foreground/20",
        // Every other action: white and raised by a fine ring and a crisp drop, never grey.
        outline:
          "bg-control text-foreground shadow-button hover:bg-control-hover aria-expanded:bg-control-hover [&_svg]:text-ink-9 [&_[data-badge]]:bg-fill-2",
        secondary:
          "bg-control text-foreground shadow-button hover:bg-control-hover aria-expanded:bg-control-hover [&_svg]:text-ink-9 [&_[data-badge]]:bg-fill-2",
        ghost:
          "text-ink-11 hover:bg-fill-2 hover:text-foreground aria-expanded:bg-fill-2 aria-expanded:text-foreground [&_[data-badge]]:bg-fill-2",
        // Opens a destructive confirm: secondary with red text. Solid red only on the final yes.
        destructive:
          "bg-control text-(--red-11) shadow-button hover:bg-(--red-3) aria-expanded:bg-(--red-3) [&_[data-badge]]:bg-destructive/10",
        "destructive-confirm": "bg-(--red-9) text-white hover:bg-(--red-10) dark:shadow-[0_0_0_0.5px_var(--red-9),0_1px_2px_0_rgb(0_0_0/0.5)]",
        link: "text-foreground underline-offset-4 hover:underline active:scale-100 [&_[data-badge]]:bg-fill-2",
      },
      size: {
        default:
          "h-8 gap-1.5 rounded-lg px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 rounded-md px-2 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_[data-badge]]:h-4 [&_[data-badge]]:min-w-4 [&_[data-badge]]:px-0.5 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-7 gap-1.5 rounded-md px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        lg: "h-9 gap-1.5 rounded-lg px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xl: "h-10 gap-2 rounded-lg px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-8 rounded-lg",
        "icon-xs": "size-6 rounded-md active:scale-[0.92] [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-7 rounded-md active:scale-[0.92]",
        "icon-lg": "size-9 rounded-lg",
        "icon-xl": "size-10 rounded-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
