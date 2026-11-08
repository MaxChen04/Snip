import { signInPath } from "../../shared/safe-next"

// The public site (usesnip.dev) is a static build of the signed-out pages.
// It has no Worker API behind it, so it never calls /api/me and its CTAs
// send people to GitHub instead of to a sign-in only the owner can use.
export const PUBLIC_SITE = import.meta.env.VITE_PUBLIC_SITE === "1"

export const REPO_URL = "https://github.com/MaxChen04/Snip"

/** The passkey sign-in page, returning here afterwards. `/auth/login` is GitHub-only and optional. */
export const signInHref = () => signInPath(location.pathname + location.search)
