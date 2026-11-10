"use client"

import { cn } from "cn"
import { useTheme } from "@/components/theme-provider"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "@/components/icons"

const Toaster = ({
  className,
  style,
  icons,
  toastOptions,
  ...props
}: ToasterProps) => {
  const { theme } = useTheme()
  const classNames = toastOptions?.classNames

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className={cn("toaster group font-sans!", className)}
      icons={{
        success: <CircleCheckIcon className="size-4 text-(--green-11)" />,
        info: <InfoIcon className="size-4 text-muted-foreground" />,
        warning: <TriangleAlertIcon className="size-4 text-(--note-ink)" />,
        error: <OctagonXIcon className="size-4 text-(--red-11)" />,
        loading: (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ),
        ...icons,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius-xl)",
          "--toast-icon-margin-start": "0px",
          "--toast-icon-margin-end": "0px",
          "--toast-svg-margin-start": "0px",
          "--toast-svg-margin-end": "0px",
          ...style,
        } as React.CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        classNames: {
          ...classNames,
          toast: cn(
            "cn-toast items-start! gap-3! text-sm! data-[styled=true]:border-0! data-[styled=true]:shadow-menu! data-[styled=true]:focus-visible:outline-2 data-[styled=true]:focus-visible:outline-focus-ring [&[data-styled=false]_[data-title]>*]:shadow-menu",
            classNames?.toast
          ),
          title: cn("leading-5!", classNames?.title),
          description: cn(
            "text-sm! leading-5! text-muted-foreground!",
            classNames?.description
          ),
          icon: cn("mt-0.5", classNames?.icon),
          actionButton: cn(
            "h-6! rounded-md! bg-primary! px-2.5! text-xs! font-medium! text-primary-foreground! shadow-primary! transition-[scale,background-color] duration-150 ease-out active:scale-[0.97] hover:bg-(--primary-hover)! [[data-cancel]+&]:-ml-1.5!",
            classNames?.actionButton
          ),
          cancelButton: cn(
            "h-6! rounded-md! bg-control! px-2.5! text-xs! font-medium! text-foreground! shadow-button! hover:bg-control-hover!",
            classNames?.cancelButton
          ),
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
