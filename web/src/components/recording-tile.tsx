import { useEffect, useRef, useState } from "react"
import { fileUrl, type Animation } from "@/lib/api"
import { isVideoKey } from "../../shared/types"

export function RecordingTile({ a, bare }: { a: Animation; bare?: boolean }) {
  // Hover recordings are small element crops: show them at natural size, centered, instead of upscaling.
  const small = a.kind === "hover" && a.width < 480
  const frame = bare ? "rounded-lg bg-surface-top shadow-card" : "rounded-xl bg-surface-top shadow-card"
  const className = small ? "max-w-full rounded-md" : "w-full"
  const style = small ? { width: a.width } : { aspectRatio: `${a.width}/${a.height}` }
  return (
    <div className={small ? `grid place-items-center overflow-hidden p-8 ${frame}` : `overflow-hidden ${frame}`}>
      {isVideoKey(a.gifKey) ? (
        <RecordingVideo src={fileUrl(a.gifKey)} label={a.label ?? ""} className={className} style={style} />
      ) : (
        <img src={fileUrl(a.gifKey)} alt={a.label ?? ""} loading="lazy" className={className} style={style} />
      )}
    </div>
  )
}

/** A looping, muted recording that only loads and plays while near the viewport, like a lazy GIF. */
function RecordingVideo({ src, label, className, style }: { src: string | undefined; label: string; className: string; style: React.CSSProperties }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [near, setNear] = useState(false)
  const [loaded, setLoaded] = useState(false) // keep the source once loaded, so scrolling back doesn't refetch
  useEffect(() => {
    const video = ref.current
    if (!video) return
    const io = new IntersectionObserver(([entry]) => setNear(!!entry?.isIntersecting), { rootMargin: "200px" })
    io.observe(video)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    const video = ref.current
    if (!video) return
    if (near) {
      setLoaded(true)
      video.play().catch(() => {})
    } else video.pause()
  }, [near])
  return (
    <video
      ref={ref}
      src={near || loaded ? src : undefined}
      aria-label={label}
      muted
      loop
      playsInline
      preload="none"
      disablePictureInPicture
      className={className}
      style={style}
    />
  )
}
