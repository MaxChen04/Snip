// The public site (usesnip.dev) is a static build of the signed-out pages.
// It has no Worker API behind it, so it never calls /api/me and its CTAs
// send people to GitHub instead of to a GitHub sign-in only the owner can use.
export const PUBLIC_SITE = import.meta.env.VITE_PUBLIC_SITE === "1"

export const REPO_URL = "https://github.com/MaxChen04/Snip"

export const signInHref = () => `/auth/login?next=${encodeURIComponent(location.pathname)}`
