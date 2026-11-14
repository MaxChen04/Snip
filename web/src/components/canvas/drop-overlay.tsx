import { useEffect, useRef, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"
import { ImageIcon, Link2 } from "@/components/icons"
import { notify } from "@/components/notify"
import { captureLink, uploadFailureText } from "@/components/canvas/capture-card"
import { reloadCanvas } from "@/components/canvas/types"
import type { SavedImage } from "@/lib/api"
import { useCollections } from "@/lib/collections"
import { IMAGE_TYPES, uploadImages } from "@/lib/images"
import { extractUrls } from "@/lib/site-url"

const isImageType = (type: string) => (IMAGE_TYPES as readonly string[]).includes(type)
const EASE = [0.23, 1, 0.32, 1] as const

/**
 * Window-level drop target. Dragging image files (or a link) from outside the page shows the overlay;
 * dropping uploads the images (or captures the link), fires reloadCanvas(), then onDropped.
 * Drags that start inside the page are ignored.
 */
export function DropOverlay({
  boardId,
  onDropped,
}: {
  /** Uploads also go on this board. */
  boardId?: string
  /** Called after uploads finish, with the drop point so a board can place them there. */
  onDropped?: (images: SavedImage[], at: { clientX: number; clientY: number }) => void
}) {
  // files: dragging files (else a link). count: image files the browser lets us see before the drop (0 = unknown).
  const [drag, setDrag] = useState<{ files: boolean; count: number } | null>(null)
  const reduce = useReducedMotion()
  const { collections } = useCollections()
  const props = useRef({ boardId, onDropped })
  props.current = { boardId, onDropped }

  useEffect(() => {
    let depth = 0 // dragenter/dragleave pairs, so moving between elements doesn't flicker the overlay
    let internal = false // a drag that started in this page
    let cancelled = false // Esc pressed: ignore this drag until it ends

    const types = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? [])
    const external = (e: DragEvent) => {
      const t = types(e)
      return !internal && (t.includes("Files") || t.includes("text/uri-list"))
    }
    const reset = () => {
      depth = 0
      cancelled = false
      setDrag(null)
    }

    const onStart = () => void (internal = true)
    const onEnd = () => void (internal = false)
    const onEnter = (e: DragEvent) => {
      if (!external(e)) return
      e.preventDefault()
      if (depth++ > 0 || cancelled) return
      const items = Array.from(e.dataTransfer?.items ?? [])
      setDrag({ files: types(e).includes("Files"), count: items.filter((i) => i.kind === "file" && isImageType(i.type)).length })
    }
    const onOver = (e: DragEvent) => {
      if (!external(e)) return
      // Always claim external drags: otherwise the browser opens a dropped file in place of the app.
      e.preventDefault()
      e.dataTransfer!.dropEffect = cancelled ? "none" : "copy"
    }
    const onLeave = (e: DragEvent) => {
      if (external(e) && --depth <= 0) reset()
    }
    const onDrop = (e: DragEvent) => {
      if (!external(e)) return
      e.preventDefault()
      const skip = cancelled
      reset()
      if (skip || !e.dataTransfer) return
      // Read everything now: the browser empties the DataTransfer once this handler returns.
      const files = Array.from(e.dataTransfer.files)
      const link = extractUrls(e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain"))[0]
      void (files.length ? upload(files, { clientX: e.clientX, clientY: e.clientY }) : link && capture(link))
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !depth) return
      cancelled = true
      setDrag(null)
    }
    // No mouse events fire during a drag, so one arriving means any drag is over. Covers a missed dragleave,
    // and a missed dragend when the dragged element unmounted mid-drag.
    const onMove = () => {
      internal = false
      if (depth || cancelled) reset()
    }

    const on: [string, (e: never) => void][] = [
      ["dragstart", onStart],
      ["dragend", onEnd],
      ["dragenter", onEnter],
      ["dragover", onOver],
      ["dragleave", onLeave],
      ["drop", onDrop],
      ["keydown", onKey],
      ["mousemove", onMove],
    ]
    for (const [type, fn] of on) window.addEventListener(type, fn as EventListener)
    return () => {
      for (const [type, fn] of on) window.removeEventListener(type, fn as EventListener)
    }
  }, [])

  const upload = async (files: File[], at: { clientX: number; clientY: number }) => {
    const images = files.filter((f) => isImageType(f.type))
    if (images.length < files.length) toast.error("Only PNG, JPEG, WebP, GIF or AVIF images")
    if (!images.length) return
    const { boardId, onDropped } = props.current
    const label = images.length === 1 ? "1 image" : `${images.length} images`
    const id = toast.loading(`Uploading ${label}…`)
    const { uploaded, failed } = await uploadImages(images, {
      collectionId: boardId,
      onProgress: (done, total) => done < total && toast.loading(`Uploading ${done + 1} of ${total}…`, { id }),
    })
    if (!failed.length) toast.success(`Added ${label}`, { id })
    else toast.error(uploaded.length ? `Added ${uploaded.length} of ${images.length}. ${uploadFailureText(failed)}` : uploadFailureText(failed), { id })
    if (!uploaded.length) return
    reloadCanvas()
    onDropped?.(uploaded, at)
  }

  const capture = async (url: URL) => {
    try {
      if (await captureLink(url, { mode: "single", boardId: props.current.boardId })) notify(`Capturing ${url.hostname}`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const board = (boardId && collections.find((c) => c.id === boardId)?.name) || "All saves"
  const title = !drag?.files ? "Drop to capture this link" : drag.count ? `Drop to add ${drag.count === 1 ? "1 image" : `${drag.count} images`}` : "Drop to add images"
  const Icon = drag?.files === false ? Link2 : ImageIcon

  return (
    <AnimatePresence>
      {drag && (
        // Visual only: drag events fall through to the canvas and bubble to the window listeners above.
        <motion.div
          key="drop"
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.18, ease: EASE } }}
          exit={{ opacity: 0, transition: { duration: 0.12, ease: EASE } }}
          className="pointer-events-none fixed inset-0 z-40 flex flex-col items-center justify-center gap-5 bg-background/70 p-4 backdrop-blur-[3px]"
        >
          <motion.div
            initial={reduce ? false : { scale: 0.97 }}
            animate={{ scale: 1, transition: { duration: 0.18, ease: EASE } }}
            exit={reduce ? undefined : { scale: 0.98, transition: { duration: 0.12, ease: EASE } }}
            className="flex h-[184px] w-[520px] max-w-full flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-ink-12 bg-card px-6 text-center shadow-modal"
          >
            <span className="grid size-11 place-items-center rounded-full bg-ink-3">
              <Icon className="size-5 text-ink-12" />
            </span>
            <span className="flex flex-col items-center gap-1">
              <span className="text-base text-ink-12">{title}</span>
              <span className="text-2xs text-ink-10">{drag.files ? `They land in ${board}.` : `Snip saves the page to ${board}.`}</span>
            </span>
          </motion.div>
          <p className="text-2xs text-ink-11">Release to drop · Esc to cancel</p>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
