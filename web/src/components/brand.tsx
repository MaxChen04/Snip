import { cn } from "@/lib/utils"

export function Logo({ className }: { className?: string }) {
  return <img src="/logo.png" alt="" aria-hidden="true" draggable={false} className={cn("object-contain select-none", className)} />
}
