import { useEffect, useRef } from "react"
import { BookmarkIcon, XIcon } from "@/components/icons"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"

/** A bookmark that sends the current tab to this Snip's add dialog. */
export const bookmarkletCode = (origin: string) =>
  `javascript:(()=>{window.open(${JSON.stringify(`${origin}/add?url=`)}+encodeURIComponent(location.href),"_blank")})()`

export function BookmarkletDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const link = useRef<HTMLAnchorElement>(null)
  // React blocks javascript: URLs in JSX, so the href is set directly.
  useEffect(() => {
    if (open) requestAnimationFrame(() => link.current?.setAttribute("href", bookmarkletCode(location.origin)))
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-[420px]">
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <DialogTitle className="text-base font-medium">Snip from your browser</DialogTitle>
          <DialogClose className="press -mr-1.5 grid size-7 place-items-center rounded-md text-ink-10 hover:bg-ink-3 hover:text-foreground active:scale-[0.92]" aria-label="Close">
            <XIcon className="size-4" />
          </DialogClose>
        </div>
        <div className="flex flex-col gap-4 px-5 pb-5">
          <DialogDescription className="text-sm text-ink-11">
            Drag this button to your bookmarks bar. Click it on any website to open it in Snip, ready to save.
          </DialogDescription>
          <a
            ref={link}
            onClick={(e) => e.preventDefault()}
            draggable
            className="tactile press flex h-10 cursor-grab items-center justify-center gap-2 self-center rounded-full px-4 text-sm font-medium active:cursor-grabbing"
          >
            <BookmarkIcon className="size-4 text-ink-11" /> Snip it
          </a>
          <p className="text-2xs text-ink-10">
            Bookmarks bar hidden? Press ⌘⇧B (Ctrl+Shift+B on Windows and Linux). You can also paste a URL anywhere in Snip to add it.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
