// The `next` path that sign-in returns to. It travels in a URL (`/sign-in?next=…`), so it is
// attacker-controllable and has to be validated on the side that navigates, not only where it is
// built. This is the one implementation: the Worker's GitHub flow uses it (auth.ts re-exports it as
// `safeNext`), and so does the browser before it moves.
//
// A valid `next` is always same-origin and path-only. Anything else falls back to the library,
// which is a safe place to land: a rejected redirect never strands the browser on another site.

/** Control characters and newlines, which parsers disagree about and could smuggle a second URL. */
const CONTROL = /[\u0000-\u001f\u007f]/

/** Longer than any real app path; a huge value is a probe, not a redirect. */
const MAX_LENGTH = 2048

/** The default destination: the library, which itself knows whether to show the gallery or landing. */
export const NEXT_HOME = "/"

/**
 * A same-origin, path-only `next`, or `fallback`.
 *
 * Rejects, in order: non-strings, anything not starting with `/`, protocol-relative `//host`,
 * backslashes (browsers normalise `\` to `/`, so `/\evil.example` is `//evil.example` in disguise,
 * including when percent-encoded), control characters, an unparseable escape, and absurd lengths.
 */
export function safeNext(value: unknown, fallback: string = NEXT_HOME): string {
  if (typeof value !== "string" || !value) return fallback
  if (value.length > MAX_LENGTH) return fallback
  if (!value.startsWith("/")) return fallback
  if (value.startsWith("//")) return fallback
  if (CONTROL.test(value)) return fallback
  if (value.includes("\\")) return fallback

  // Decode once to catch encoded backslashes and encoded leading slashes. A malformed escape is
  // not trusted: a path that cannot be parsed is not a path this app wrote.
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return fallback
  }
  if (decoded.includes("\\")) return fallback
  if (decoded.startsWith("//")) return fallback
  if (CONTROL.test(decoded)) return fallback

  return value
}

/**
 * `/sign-in?next=…`, with the parameter omitted when it would just point at the library.
 *
 * An invalid `nextTo` is dropped rather than propagated, so a crafted link cannot even round-trip a
 * hostile value through this helper.
 */
export function signInPath(nextTo?: string | null): string {
  // `""` as the fallback distinguishes "nothing to return to" from "return to the library".
  const target = safeNext(nextTo ?? null, "")
  return target === "" || target === NEXT_HOME ? "/sign-in" : `/sign-in?next=${encodeURIComponent(target)}`
}
