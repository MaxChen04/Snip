import { useEffect, useMemo, useRef, useState } from "react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { fileUrl, type Page } from "@/lib/api"
import { readPref, writePref } from "@/lib/prefs"
import { cn } from "@/lib/utils"
import type { PageSection } from "../../shared/types"

// How a page's screenshot is shown, for the two viewers that open pages: the page viewer and the canvas inspector.

const LIVE_KEY = "snip.viewer.live"
const SCHEME_KEY = "snip.viewer.scheme"

/**
 * Live plays each moving section's clip over the screenshot; the other color scheme swaps in its own screenshot.
 * Clips are recorded only in the scheme the page was captured in, so they cannot play over the other one:
 * while the other scheme shows, nothing plays and Live reads Static. Choosing the other scheme saves that
 * choice and leaves the Live choice alone, so coming back to the captured scheme plays again. Choosing Live
 * while the other scheme shows brings back the captured scheme for this page only: the saved scheme is not
 * written, the next page opens in it again, and so does this one if you step away and return. Clicking the
 * scheme toggle on that page saves the choice and ends the hold.
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
  // The page that Live pulled back to its captured scheme. Keyed by page, so another page never inherits it.
  const [heldFor, setHeldFor] = useState<string | null>(null)
  useEffect(() => setHeldFor(null), [page?.id])
  const showAlt = desktop && !!alt && heldFor !== page?.id && schemePref === alt.scheme

  // Off by default for people who ask for less motion.
  const [live, setLiveState] = useState(() => readPref(LIVE_KEY, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "0" : "1") === "1")
  // Clips load the first time Live is on, then stay: Static pauses them where they are, so the motion stops in place.
  const [clipsLoaded, setClipsLoaded] = useState(live)
  const setLive = (v: boolean) => {
    setLiveState(v)
    if (v) setClipsLoaded(true)
    writePref(LIVE_KEY, v ? "1" : "0")
  }
  // Neighbouring sections recorded together share one clip: draw each clip once, at its own top edge.
  const sections = page?.sections
  const clips = useMemo(
    () =>
      [...new Map((sections ?? []).flatMap((s) => (s.live ? [[s.live.key, { key: s.live.key, y: s.live.y ?? s.y, height: s.live.height }] as const] : []))).values()].map((c) => ({
        ...c,
        // A clip is at most a viewport tall. Where its sections run on below it, its bottom edge fades into the screenshot.
        feather: Math.max(...sections!.filter((s) => s.live?.key === c.key).map((s) => s.y + s.height)) - (c.y + c.height) > 8,
      })),
    [sections],
  )
  const hasClips = desktop && clips.length > 0
  const playing = hasClips && live && !showAlt

  return {
    /** The other scheme's capture while it is showing, otherwise null. */
    alt: showAlt ? alt : null,
    clips,
    /** The clips are on the screenshot (once Live has been on); `playing` says whether they move. */
    shown: hasClips && clipsLoaded && !showAlt,
    playing,
    /** A section's image: the other scheme's crop while that shows, where it has one. */
    sectionKey: (s: PageSection, i: number) => (showAlt ? alt.sectionKeys[i] : null) ?? s.key,
    scheme:
      desktop && alt
        ? {
            value: showAlt ? alt.scheme : captured!,
            onChange: (v: string) => {
              if (v === (showAlt ? alt.scheme : captured)) return
              setSchemePref(v)
              setHeldFor(null)
            },
          }
        : null,
    live:
      hasClips
        ? {
            value: playing ? "live" : "static",
            onChange: (v: string) => {
              if (v === (playing ? "live" : "static")) return
              setLive(v === "live")
              if (v === "live" && showAlt) setHeldFor(page!.id)
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
  if (!look.shown || !height) return null
  return look.clips.map((c) => (
    <LiveClip
      key={c.key}
      src={fileUrl(c.key)!}
      playing={look.playing}
      feather={c.feather}
      style={{ top: `${(c.y / height) * 100}%`, height: `${(c.height / height) * 100}%` }}
    />
  ))
}

/**
 * One section's recorded clip, laid over its place in the screenshot. Plays only while on screen and `playing`;
 * otherwise it holds its frame. Hidden until its first frame is decoded, then faded in, and only then played:
 * captures paste that frame into the screenshot, so the swap shows nothing and the motion starts from the still.
 */
function LiveClip({ src, style, playing, feather }: { src: string; style: React.CSSProperties; playing: boolean; feather: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [ready, setReady] = useState(false)
  const shown = useRef(false)
  const visible = useRef(false)
  const want = useRef(playing)
  want.current = playing
  const sync = () => {
    const video = ref.current
    if (!video) return
    if (shown.current && visible.current && want.current) video.play().catch(() => {})
    else video.pause()
  }
  useEffect(() => {
    const io = new IntersectionObserver(([entry]) => {
      visible.current = !!entry?.isIntersecting
      sync()
    }, { rootMargin: "200px" })
    io.observe(ref.current!)
    return () => io.disconnect()
  }, [])
  useEffect(sync, [playing])
  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => {
      shown.current = true
      sync()
    }, 200) // the fade below
    return () => clearTimeout(t)
  }, [ready])
  return (
    <video
      ref={ref}
      src={src}
      muted
      loop
      playsInline
      preload="auto"
      aria-hidden
      onLoadedData={() => setReady(true)}
      className={cn(
        "pointer-events-none absolute inset-x-0 w-full object-cover object-top transition-opacity duration-200",
        ready ? "opacity-100" : "opacity-0",
        feather && "[mask-image:linear-gradient(to_bottom,black_calc(100%-48px),transparent)]",
      )}
      style={style}
    />
  )
}

/** Marks a section that moves. */
export function LiveTag() {
  return (
    <span className="font-medium text-primary" title="This section moves; turn on Live to play it">
      Live
    </span>
  )
}
