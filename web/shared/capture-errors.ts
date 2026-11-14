/** A plain-language reading of a capture error and what Retry will do about it. */
export type CaptureDiagnosis = { summary: string; fix: string }

/** The progress text of a capture that is queued: nothing is capturing it, whether the agent is busy, asleep or not running. */
export const WAITING = "Waiting for the capture agent"

/** Error recorded when a capture is stopped before its first page finished. */
export const STOPPED_EMPTY = "Stopped before any pages were captured"

/** Error recorded when the capture agent has died on a capture too often to hand it out again. */
export const ABANDONED = "The capture agent stopped responding too many times while capturing this"

const KNOWN: { match: RegExp; diagnosis: CaptureDiagnosis }[] = [
  {
    match: /^Stopped before any pages were captured$/,
    diagnosis: { summary: "You stopped this capture before any pages were saved.", fix: "Retry starts it again from the first page." },
  },
  {
    match: /^The capture agent stopped responding too many times while capturing this$/,
    diagnosis: { summary: "Capturing this site kept stopping the capture agent.", fix: "Retry starts it again from the first page." },
  },
  {
    match: /Browser install failed/i,
    diagnosis: { summary: "Snip couldn't download the capture browser.", fix: "Check your internet connection, then retry." },
  },
  {
    match: /Executable doesn't exist at|playwright install/i,
    diagnosis: {
      summary: "The capture browser isn't installed. This usually happens after Snip updates Playwright.",
      fix: "Retry installs the browser automatically (about a minute, once), then captures again.",
    },
  },
  {
    match: /ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo/i,
    diagnosis: { summary: "The site's address couldn't be found.", fix: "Check the URL and your connection, then retry." },
  },
  {
    match: /Timeout \d+ms exceeded|ERR_TIMED_OUT|ERR_CONNECTION_(?:RESET|CLOSED|REFUSED|TIMED_OUT)|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED/i,
    diagnosis: { summary: "The site didn't respond in time or dropped the connection.", fix: "Retry usually works. Slow sites can take a second try." },
  },
  {
    match: /Target page, context or browser has been closed|Browser has been closed|browser has disconnected|Target crashed/i,
    diagnosis: { summary: "The capture browser closed unexpectedly.", fix: "Retry starts a fresh browser." },
  },
]

export function diagnoseCaptureError(error: string | null | undefined): CaptureDiagnosis | null {
  if (!error) return null
  return KNOWN.find((k) => k.match.test(error))?.diagnosis ?? null
}
