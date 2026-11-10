import { useEffect, useMemo, useRef, useState } from "react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { fileUrl, type Page } from "@/lib/api"
import { readPref, writePref } from "@/lib/prefs"
import type { PageSection } from "../../shared/types"

// How a page's screenshot is shown, for the two viewers that open pages: the page viewer and the canvas inspector.

const LIVE_KEY = "snip.viewer.live"
const SCHEME_KEY = "snip.viewer.scheme"

/**
 * Live plays each moving section's clip over the screenshot; the other color scheme swaps in its own screenshot.
 * Clips are recorded only in the scheme the page was captured in, so they cannot play over the other one:
 * while the other scheme shows, nothing plays and Live reads Static. Choosing Live comes back to the captured
 * scheme; choosing the other scheme leaves the Live choice alone, so coming back plays again.
 * `desktop` is false while a viewer shows the mobile screenshot, which has neither.
 */
export function usePageLook(page: Page | undefined, desktop: boolean) {
  // A page whose site has a theme for the other color scheme carries it as altScheme (desktop only).
  const alt = page?.altScheme ?? null
  const captured = alt && (alt.scheme === "dark" ? "light" : "dark")
  const [schemePref, setSchemePrefState] = useState(() => readPref<string>(SCHEME_KEY, ""))
  const setSchemePref = (v: string) => {
    setSchemePrefState(v)
    writePref(SCHEME_KEY, v)
  }
  const showAlt = desktop && !!alt && schemePref === alt.scheme

  // Off by default for people who ask for less motion.
  const [live, setLiveState] = useState(() => readPref(LIVE_KEY, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "0" : "1") === "1")
  const setLive = (v: boolean) => {
    setLiveState(v)
    writePref(LIVE_KEY, v ? "1" : "0")
  }
  // Neighbouring sections recorded together share one clip: draw each clip once, at its own top edge.
  const sections = page?.sections
  const clips = useMemo(
    () => [...new Map((sections ?? []).flatMap((s) => (s.live ? [[s.live.key, { key: s.live.key, y: s.live.y ?? s.y, height: s.live.height }] as const] : []))).values()],
    [sections],
  )
  const playing = desktop && live && !showAlt && clips.length > 0

  return {
    /** The other scheme's capture while it is showing, otherwise null. */
    alt: showAlt ? alt : null,
    clips,
    playing,
    /** A section's image: the other scheme's crop while that shows, where it has one. */
    sectionKey: (s: PageSection, i: number) => (showAlt ? alt.sectionKeys[i] : null) ?? s.key,
    scheme:
      desktop && alt
        ? {
            value: showAlt ? alt.scheme : captured!,
            onChange: (v: string) => v !== (showAlt ? alt.scheme : captured) && setSchemePref(v),
          }
        : null,
    live:
      desktop && clips.length > 0
        ? {
            value: playing ? "live" : "static",
            onChange: (v: string) => {
              if (v === (playing ? "live" : "static")) return
              setLive(v === "live")
              if (v === "live" && showAlt) setSchemePref(captured!)
            },
          }
        : null,
  }
}

export type PageLook = ReturnType<typeof usePageLook>

/** The Light/Dark toggle (when the page has another scheme) and the Static/Live toggle (when sections move). */
export function LookToggles({ look }: { look: PageLook }) {
  return (
    <>
      {look.scheme && (
        <ToggleGroup variant="outline" size="sm" value={[look.scheme.value]} onValueChange={(v) => v[0] && look.scheme!.onChange(v[0] as string)}>
          {(["light", "dark"] as const).map((s) => (
            <ToggleGroupItem key={s} value={s} aria-label={`${s === "light" ? "Light" : "Dark"} mode`}>
              {s === "light" ? "Light" : "Dark"}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      {look.live && (
        <ToggleGroup variant="outline" size="sm" value={[look.live.value]} onValueChange={(v) => v[0] && look.live!.onChange(v[0] as string)}>
          <ToggleGroupItem value="static" aria-label="Static screenshot" title="Static screenshot">
            Static
          </ToggleGroupItem>
          <ToggleGroupItem value="live" aria-label="Live: play sections that move" title="Play sections that move, as recorded">
            Live
          </ToggleGroupItem>
        </ToggleGroup>
      )}
    </>
  )
}

/** The page's clips, laid over its screenshot at their own positions. Goes inside the box that wraps the image. */
export function LiveClips({ page, look }: { page: Page; look: PageLook }) {
  const height = page.desktopHeight
  if (!look.playing || !height) return null
  return look.clips.map((c) => (
    <LiveClip key={c.key} src={fileUrl(c.key)!} style={{ top: `${(c.y / height) * 100}%`, height: `${(c.height / height) * 100}%` }} />
  ))
}

/** One section's recorded clip, laid over its place in the screenshot. Plays only while on screen. */
function LiveClip({ src, style }: { src: string; style: React.CSSProperties }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    const io = new IntersectionObserver(([entry]) => (entry?.isIntersecting ? video.play().catch(() => {}) : video.pause()), { rootMargin: "200px" })
    io.observe(video)
    return () => io.disconnect()
  }, [])
  return <video ref={ref} src={src} muted loop playsInline preload="metadata" aria-hidden className="pointer-events-none absolute inset-x-0 w-full object-cover object-top" style={style} />
}

/** Marks a section that moves. */
export function LiveTag() {
  return (
    <span className="font-medium text-primary" title="This section moves; turn on Live to play it">
      Live
    </span>
  )
}
