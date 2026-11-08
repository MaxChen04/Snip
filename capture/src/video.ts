import { readFileSync } from "node:fs"
import type { Browser, Page } from "playwright"
import { gifWriter, imageSize, type Frame } from "./gif"
import { renderer } from "./sheet"
import { muxWebm, type ColorSpace } from "./webm"

// Scroll and hover recordings are WebM (VP9), encoded with WebCodecs in the browser the agent already runs:
// usually several times smaller than the same GIF, at full colour. SNIP_RECORDING_FORMAT=gif keeps GIFs, and
// a browser that can't encode VP9 falls back to them. Callers must opt in to WebM only when the destination
// Worker advertises support; an older Worker accepts uploads but can only display GIF recordings.
const ENCODER_JS = readFileSync(new URL("./inpage/video-encoder.js", import.meta.url), "utf8")
const FORMAT = process.env.SNIP_RECORDING_FORMAT === "gif" ? "gif" : "webm"
const CODEC = "vp09.00.10.08" // VP9 profile 0, 8-bit 4:2:0
// Constant quality: 0 is best, 63 smallest. Screen content (text, flat colour) stays sharp well into the 30s.
const QUANTIZER = Math.min(63, Math.max(0, Number(process.env.SNIP_VIDEO_QUANTIZER ?? 34)))
const KEYFRAME_MS = 5000 // seek points; every frame of a scroll changes, so keyframes cost little extra
const MIN_FRAME_MS = 20 // as GIF players do, and as buildStills counts playback time

export interface Recording {
  bytes: Buffer
  width: number
  height: number
  ext: "webm" | "gif"
  contentType: string
}

export interface RecordingWriter {
  /** "webm" takes PNG or JPEG frames; "gif" keeps its palette best from PNG. */
  format: Recording["ext"]
  /** Await each add() before the next. `delay` is how long the frame stays on screen. */
  add(image: Buffer, delay: number): Promise<void>
  finish(): Promise<Recording>
}

declare global {
  interface Window {
    snipVideo: {
      supported(config: object): Promise<boolean>
      start(opts: { config: object; q: number | null }): Promise<void>
      add(opts: { image: string; mime: string; timestamp: number; key: boolean }): Promise<void>
      finish(): Promise<{ data: string; chunks: { t: number; k: boolean; n: number }[]; colorSpace: ColorSpace | null }>
    }
  }
}

async function encoderPage(browser: Browser) {
  const page = await renderer(browser)
  // Stills replace the helper page's document between recordings, so install the encoder each time.
  if (!(await page.evaluate(() => "snipVideo" in window))) await page.evaluate(`(${ENCODER_JS})()`)
  return page
}

const config = (width: number, height: number) => ({ codec: CODEC, width, height, bitrateMode: "quantizer", latencyMode: "quality" })

const support = new WeakMap<Browser, Promise<boolean>>()
/** Whether this browser can encode VP9, checked once per browser. */
function canEncode(browser: Browser) {
  let ok = support.get(browser)
  if (!ok) {
    ok = encoderPage(browser).then((page) => page.evaluate((c) => window.snipVideo.supported(c), config(640, 360))).catch(() => false)
    support.set(browser, ok)
  }
  return ok
}

function webmWriter(browser: Browser, scale: number): RecordingWriter {
  let page: Page | null = null
  let width = 0
  let height = 0
  let t = 0 // ms
  let lastKey = -Infinity
  return {
    format: "webm",
    async add(png, delay) {
      const size = imageSize(png)
      // Even sizes: 4:2:0 video stores colour per 2x2 pixels.
      const w = Math.max(2, Math.floor(size.width / scale / 2) * 2)
      const h = Math.max(2, Math.floor(size.height / scale / 2) * 2)
      if (!page) {
        page = await encoderPage(browser)
        width = w
        height = h
        await page.evaluate((o) => window.snipVideo.start(o), { config: config(w, h), q: QUANTIZER })
      } else if (w !== width || h !== height) return // as with GIFs, a frame of another size is skipped
      const key = t - lastKey >= KEYFRAME_MS
      if (key) lastKey = t
      await page.evaluate((o) => window.snipVideo.add(o), { image: png.toString("base64"), mime: png[0] === 0xff ? "image/jpeg" : "image/png", timestamp: t * 1000, key })
      t += Math.max(MIN_FRAME_MS, Math.round(delay))
    },
    async finish() {
      if (!page) throw new Error("No frames were recorded")
      const out = await page.evaluate(() => window.snipVideo.finish())
      const data = Buffer.from(out.data, "base64")
      let at = 0
      const frames = out.chunks.map((c) => {
        const frame = { data: data.subarray(at, at + c.n), timestamp: c.t, key: c.k }
        at += c.n
        return frame
      })
      const bytes = muxWebm({ codecId: "V_VP9", width, height, frames, durationMs: t, colorSpace: out.colorSpace })
      return { bytes, width, height, ext: "webm", contentType: "video/webm" }
    },
  }
}

function gifRecording(scale: number): RecordingWriter {
  const gif = gifWriter({ scale })
  return {
    format: "gif",
    add: (png, delay) => gif.add(png, delay),
    finish: async () => ({ ...gif.finish(), ext: "gif", contentType: "image/gif" }),
  }
}

let warned = false
type RecordingOptions = { scale?: number; format?: Recording["ext"] }
/** A writer for one recording. GIF unless the caller requests WebM for a destination that supports it. */
export async function recordingWriter(browser: Browser, opts: RecordingOptions = {}): Promise<RecordingWriter> {
  const scale = Math.max(1, opts.scale ?? 1)
  if (opts.format === "webm" && FORMAT === "webm") {
    if (await canEncode(browser)) return webmWriter(browser, scale)
    if (!warned) console.log("  this browser can't encode VP9 video; recording GIFs instead")
    warned = true
  }
  return gifRecording(scale)
}

/** Encode finished PNG frames into one recording. */
export async function encodeRecording(browser: Browser, frames: Frame[], opts: RecordingOptions = {}) {
  const writer = await recordingWriter(browser, opts)
  for (const f of frames) await writer.add(f.png!, f.delay)
  return writer.finish()
}
