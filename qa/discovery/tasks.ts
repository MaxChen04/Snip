// Discovery tasks over the fixture library (library.ts). Each has:
// - query: what an agent would type into search, for the offline retrieval check;
// - prompt: what a user would say to an agent, for the agent runs (run.ts);
// - expect: the page (or website) that answers it, plus the section when one section is the answer.
// `kind` names what the answer can be found by. "visual" tasks describe how a page looks: word search
// solves them only where the user's note happens to say it, and they are kept to measure that gap.

export type TaskKind = "note" | "section" | "text" | "title" | "visual"

export interface DiscoveryTask {
  id: string
  kind: TaskKind
  query: string
  prompt: string
  expect: { site: string; path?: string; section?: string }
  /** Other pages that are also a right answer. */
  alsoAccept?: { site: string; path?: string }[]
}

export const TASKS: DiscoveryTask[] = [
  { id: "docs-nav", kind: "note", query: "navigation spacing", prompt: "I saved a site for its navigation and spacing. Find it and describe the sidebar it uses.", expect: { site: "https://quillbase.test", path: "/docs/getting-started" }, alsoAccept: [{ site: "https://quillbase.test" }] },
  { id: "pricing-to-copy", kind: "note", query: "pricing cards annual toggle", prompt: "Find the pricing page I said we should copy, the one with the monthly/annual toggle.", expect: { site: "https://plainleaf.test", path: "/pricing", section: "Simple pricing for growing teams" }, alsoAccept: [{ site: "https://plainleaf.test", path: "/pricing" }] },
  { id: "rounded-pricing", kind: "visual", query: "rounded pricing cards", prompt: "Find a reference with rounded pricing cards.", expect: { site: "https://plainleaf.test", path: "/pricing" } },
  { id: "testimonials", kind: "note", query: "testimonials", prompt: "Which reference has the testimonials wall I liked? Show me that section.", expect: { site: "https://orbitly.test", path: "/", section: "Loved by teams" } },
  { id: "changelog", kind: "section", query: "changelog", prompt: "Find a changelog page in my references.", expect: { site: "https://ferrous.test", path: "/changelog", section: "Changelog" } },
  { id: "books-days", kind: "text", query: "close your books in days", prompt: "Which site's hero says \"close your books in days, not weeks\"?", expect: { site: "https://plainleaf.test", path: "/", section: "Close your books in days, not weeks" } },
  { id: "soc2", kind: "text", query: "SOC 2 badges", prompt: "Find a page that shows SOC 2 and ISO compliance badges.", expect: { site: "https://harbor.test", path: "/", section: "Trusted by" } },
  { id: "signup", kind: "title", query: "signup form social login", prompt: "Find a signup form with social login I saved.", expect: { site: "https://mosaic.test", path: "/signup" } },
  { id: "team-grid", kind: "section", query: "team grid", prompt: "Find an about page with a team grid.", expect: { site: "https://northstar.test", path: "/about", section: "Our team" } },
  { id: "bento", kind: "text", query: "bento grid features", prompt: "Find a bento grid features section.", expect: { site: "https://cadence.test", path: "/features", section: "Everything you need" } },
  { id: "integrations", kind: "section", query: "integrations", prompt: "Show me an integrations section from my references.", expect: { site: "https://cadence.test", path: "/features", section: "Integrations" } },
  { id: "newsletter-footer", kind: "note", query: "footer newsletter", prompt: "Find the footer with a newsletter signup I saved.", expect: { site: "https://harbor.test", path: "/", section: "Footer" } },
  { id: "case-studies-grid", kind: "note", query: "case study grid", prompt: "Find a design studio's case-study grid.", expect: { site: "https://kiln.test", path: "/work", section: "Selected work" }, alsoAccept: [{ site: "https://kiln.test" }] },
  { id: "courses", kind: "title", query: "online courses", prompt: "I saved an online courses site. Find it.", expect: { site: "https://brightpath.test" } },
  { id: "blog-cards", kind: "section", query: "latest blog posts", prompt: "Find a blog index page with post cards.", expect: { site: "https://pebble.test", path: "/blog", section: "Latest posts" } },
  { id: "launch-hero", kind: "note", query: "dark hero glowing grid", prompt: "Find the dark hero with a glowing grid I wanted for our launch page.", expect: { site: "https://ferrous.test", path: "/", section: "Deploy infrastructure in seconds" }, alsoAccept: [{ site: "https://ferrous.test" }] },
  { id: "faq", kind: "section", query: "frequently asked questions", prompt: "Find a pricing FAQ section.", expect: { site: "https://plainleaf.test", path: "/pricing", section: "Frequently asked questions" }, alsoAccept: [{ site: "https://quillbase.test", path: "/pricing" }] },
  { id: "gradient-hero", kind: "visual", query: "purple gradient hero", prompt: "Find a hero with a purple gradient background.", expect: { site: "https://pebble.test", path: "/", section: "Think in lists" } },
  { id: "serif", kind: "visual", query: "big serif headline", prompt: "Find the site with big serif type.", expect: { site: "https://kiln.test" } },
]

/** Whether a page (site + path) answers a task. A task with no path is answered by any page of its site. */
export function answers(task: DiscoveryTask, site: string, path: string) {
  return [task.expect, ...(task.alsoAccept ?? [])].some((e) => e.site === site && (e.path == null || e.path === path))
}
