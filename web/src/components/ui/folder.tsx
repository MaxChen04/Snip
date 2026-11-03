// Adapted from rare-ui's Folder component by Swami Malode (github.com/swamimalode07/rare-ui),
// MIT + Commons Clause + Attribution. Changes: the three document cards show page screenshots,
// the click-to-open toggle is removed (the folder links to the website), and hover is driven by
// the parent so the whole tile reacts.
import { useState } from "react"
import { motion } from "motion/react"
import { cn } from "@/lib/utils"

const themes = {
  black: {
    backFill: "#000",
    backInsetShadow: "inset 0 0 6px 2px rgba(255,255,255,0.37)",
    flapFill: "#292929",
    flapFillOpacity: 0.25,
    flapStroke: "#979797",
    flapInsetColor: "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.08 0",
  },
  white: {
    backFill: "#ffffff",
    backInsetShadow: "inset 0 0 6px 2px rgba(178,178,178,0.25)",
    flapFill: "#f5f5f5",
    flapFillOpacity: 0.85,
    flapStroke: "#d4d4d4",
    flapInsetColor: "0 0 0 0 0.6 0 0 0 0 0.6 0 0 0 0 0.6 0 0 0 0.15 0",
  },
  blue: {
    backFill: "#50B1FD",
    backInsetShadow: "inset 0 0 6px 2px rgba(255,255,255,0.35)",
    flapFill: "#3a9ae8",
    flapFillOpacity: 0.45,
    flapStroke: "#7ec8ff",
    flapInsetColor: "0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.12 0",
  },
} as const

export type FolderColor = keyof typeof themes
export const FOLDER_SCALE = { sm: 0.6, md: 0.8, lg: 1 } as const
export type FolderSize = keyof typeof FOLDER_SCALE

const W = 321
const H = 270
const CARD_W = 164
const CARD_H = 214
const FLAP_PATH =
  "M0 25C0 11.1929 11.1929 0 25 0H136.084C143.044 0 149.689 2.90139 154.42 8.00608L178.08 33.5343C182.811 38.639 189.456 41.5404 196.416 41.5404H296C309.807 41.5404 321 52.7333 321 66.5404V216C321 229.807 309.807 241 296 241H25C11.1929 241 0 229.807 0 216V25Z"

// Resting / hovered pose for the back, middle and front card (front card is drawn last).
const POSES = [
  { rest: { y: -34, x: 40, rotate: 10 }, hover: { y: -78, x: 66, rotate: 16 }, delay: 0.12 },
  { rest: { y: -44, x: 3, rotate: 2 }, hover: { y: -92, x: 2, rotate: -2 }, delay: 0.06 },
  { rest: { y: -48, x: -40, rotate: -5 }, hover: { y: -86, x: -62, rotate: -12 }, delay: 0 },
]

export function Folder({
  images,
  hovered,
  color = "blue",
  size = "md",
  className,
}: {
  /** Up to three screenshot URLs; missing slots show a blank page. */
  images: (string | undefined)[]
  hovered: boolean
  color?: FolderColor
  size?: FolderSize
  className?: string
}) {
  const theme = themes[color]
  const scale = FOLDER_SCALE[size]
  // Show the first page on the front card.
  const slots = [images[2], images[1], images[0]]

  return (
    <div className={cn("relative select-none", className)} style={{ width: W * scale, height: (H + 80) * scale }}>
      <div className="absolute left-1/2" style={{ top: 80 * scale, width: W, height: H, transform: `translateX(-50%) scale(${scale})`, transformOrigin: "top center", perspective: 800 }}>
        <div className="absolute inset-0" style={{ borderRadius: 25, backgroundColor: theme.backFill, boxShadow: theme.backInsetShadow }} />

        <div className="absolute inset-0 flex items-center justify-center">
          {POSES.map((p, i) => (
            <motion.div
              key={i}
              className="absolute"
              initial={false}
              animate={hovered ? p.hover : p.rest}
              transition={{ type: "spring", stiffness: 120, damping: 13, delay: hovered ? p.delay : 0 }}
            >
              <ShotCard src={slots[i]} />
            </motion.div>
          ))}
        </div>

        <motion.div
          className="absolute left-1/2 -translate-x-1/2"
          style={{ bottom: -1.5, transformOrigin: "bottom center", transformStyle: "preserve-3d", width: W, height: 241 }}
          initial={false}
          animate={{ rotateX: hovered ? -45 : -15 }}
          transition={{ type: "spring", stiffness: 120, damping: 14 }}
        >
          <div
            className="absolute inset-0"
            style={{ backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", clipPath: `path('${FLAP_PATH}')`, WebkitClipPath: `path('${FLAP_PATH}')`, transform: "translateZ(0)", backfaceVisibility: "hidden" }}
          />
          <svg className="absolute inset-0" width={W} height="241" viewBox="0 0 321 241" fill="none">
            <g filter={`url(#flap-${color})`}>
              <path d={FLAP_PATH} fill={theme.flapFill} fillOpacity={theme.flapFillOpacity} />
              <path
                d="M25 0.5H136.084C142.905 0.5 149.417 3.3431 154.054 8.3457L177.713 33.874C182.539 39.0808 189.317 42.04 196.416 42.04H296C309.531 42.04 320.5 53.0092 320.5 66.54V216C320.5 229.531 309.531 240.5 296 240.5H25C11.469 240.5 0.5 229.531 0.5 216V25C0.5 11.469 11.469 0.5 25 0.5Z"
                stroke={theme.flapStroke}
              />
            </g>
            <defs>
              <filter id={`flap-${color}`} x="-25.4" y="-25.4" width="371.8" height="291.8" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
                <feFlood floodOpacity="0" result="BackgroundImageFix" />
                <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
                <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
                <feOffset />
                <feGaussianBlur stdDeviation="2.65" />
                <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
                <feColorMatrix type="matrix" values={theme.flapInsetColor} />
                <feBlend mode="normal" in2="shape" result="inner" />
              </filter>
            </defs>
          </svg>
        </motion.div>
      </div>
    </div>
  )
}

/** A "document" in the folder: a page screenshot, or a blank sheet with text lines. */
function ShotCard({ src }: { src?: string }) {
  const [broken, setBroken] = useState(false)
  return (
    <div className="overflow-hidden bg-[#F1F1F1] shadow-[inset_3px_5px_6px_rgba(255,255,255,0.9),0_1px_2px_rgba(0,0,0,0.08)] ring-1 ring-[#E0E0E0]" style={{ width: CARD_W, height: CARD_H, borderRadius: 20 }}>
      {src && !broken ? (
        <img src={src} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} className="size-full object-cover object-top" />
      ) : (
        <div className="flex flex-col gap-2 px-3.5 pt-8">
          <span className="h-3 rounded-full bg-[#D4D4D4]" />
          {Array.from({ length: 8 }, (_, i) => (
            <span key={i} className="grid grid-cols-2 gap-1.5">
              <span className="h-1.5 rounded-full bg-[#D4D4D4]" />
              <span className="h-1.5 rounded-full bg-[#D4D4D4]" />
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
