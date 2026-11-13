// A synthetic Snip library for discovery evals: fictional websites (so no model already knows them),
// each with the things search can read: the user's note, page titles and paths, section labels and the
// text captured on each section. Some pages are older captures with no text or sections, as in a real
// library. Screenshots are 1x1 placeholders: these evals measure finding the right reference, not
// judging how it looks (see README.md for the design-output stage).

import type { PageSection, PageUpload } from "../../web/shared/types"

export interface FixtureSection {
  kind: PageSection["kind"]
  label: string
  text: string
}

export interface FixturePage {
  path: string
  title: string
  /** Absent: captured before sections and page text existed. */
  sections?: FixtureSection[]
}

export interface FixtureSite {
  url: string
  title: string
  description: string
  notes?: string
  pages: FixturePage[]
}

const S = (kind: FixtureSection["kind"], label: string, text: string): FixtureSection => ({ kind, label, text })
const header = (brand: string, links: string) => S("header", brand, `${brand}\n${links}`)
const footer = (text: string) => S("footer", "Footer", text)

export const LIBRARY: FixtureSite[] = [
  {
    url: "https://quillbase.test",
    title: "Quillbase: docs your team will read",
    description: "Write, publish and search product documentation.",
    notes: "Borrow this navigation and spacing for our docs sidebar.",
    pages: [
      { path: "/", title: "Quillbase", sections: [
        header("Quillbase", "Product Docs Pricing Sign in"),
        S("hero", "Docs your team will actually read", "Docs your team will actually read\nWrite once, publish everywhere, search instantly.\nStart free"),
        S("section", "Write in Markdown", "Write in Markdown\nLive preview, versioning and review requests."),
        footer("Quillbase Inc. Privacy Terms Status"),
      ] },
      { path: "/docs/getting-started", title: "Getting started · Quillbase Docs", sections: [
        header("Quillbase Docs", "Guides API reference Changelog Search docs"),
        S("section", "Getting started", "Getting started\nInstall the CLI\nnpm install -g quillbase\nCreate your first space\nInvite your team"),
        S("section", "Next steps", "Next steps\nConfigure your sidebar\nCustom domains\nAccess control"),
        footer("Was this page helpful? Edit on GitHub"),
      ] },
      { path: "/pricing", title: "Pricing · Quillbase", sections: [
        header("Quillbase", "Product Docs Pricing"),
        S("hero", "Plans", "Plans\nFree for small teams. Pro $8 per editor per month."),
        S("section", "FAQ", "FAQ\nCan I change plans later?\nDo readers need a seat?"),
        footer("Quillbase Inc."),
      ] },
    ],
  },
  {
    url: "https://ferrous.test",
    title: "Ferrous: deploy infrastructure in seconds",
    description: "Edge compute and databases for developers.",
    notes: "Dark hero with an animated glowing grid; great for our launch page.",
    pages: [
      { path: "/", title: "Ferrous", sections: [
        header("Ferrous", "Products Docs Changelog Customers"),
        S("hero", "Deploy infrastructure in seconds", "Deploy infrastructure in seconds\nGlobal edge compute, Postgres and queues.\nGet started\nRead the docs"),
        S("section", "Built for scale", "Built for scale\n3.2 billion requests a day\n99.99% uptime"),
        footer("Ferrous Labs Careers Security"),
      ] },
      { path: "/changelog", title: "Changelog · Ferrous", sections: [
        header("Ferrous", "Products Docs Changelog"),
        S("section", "Changelog", "Changelog\nNew features, improvements and fixes, every week.\nNovember 4 Queues are generally available\nOctober 28 Branching for Postgres"),
        footer("Subscribe to updates via RSS"),
      ] },
      { path: "/customers", title: "Customers · Ferrous", sections: [
        S("hero", "Teams shipping on Ferrous", "Teams shipping on Ferrous\nRead their stories"),
        S("section", "Case studies", "Case studies\nHow Lumen cut latency by 60%"),
      ] },
    ],
  },
  {
    url: "https://plainleaf.test",
    title: "Plainleaf: accounting for small business",
    description: "Bookkeeping, invoicing and payroll in one place.",
    notes: "Pricing cards with a monthly/annual toggle. The one to copy for our pricing page.",
    pages: [
      { path: "/", title: "Plainleaf", sections: [
        header("Plainleaf", "Features Pricing Accountants Log in"),
        S("hero", "Close your books in days, not weeks", "Close your books in days, not weeks\nBookkeeping, invoicing and payroll for small business.\nTry free for 30 days"),
        S("section", "Everything in one ledger", "Everything in one ledger\nBank feeds\nReceipts\nTax-ready reports"),
        footer("Plainleaf Ltd. Help center"),
      ] },
      { path: "/pricing", title: "Pricing · Plainleaf", sections: [
        header("Plainleaf", "Features Pricing Log in"),
        S("hero", "Simple pricing for growing teams", "Simple pricing for growing teams\nMonthly Annual save 20%"),
        S("section", "Choose a plan", "Starter $12 per month\nGrowth $29 per month Most popular\nScale $59 per month\nStart free trial"),
        S("section", "Compare plans", "Compare plans\nInvoices Bank feeds Payroll Multi-currency"),
        S("section", "Frequently asked questions", "Frequently asked questions\nCan I cancel anytime?"),
        footer("Plainleaf Ltd."),
      ] },
    ],
  },
  {
    url: "https://tallyho.test",
    title: "Tallyho analytics",
    description: "Product analytics without the SQL.",
    pages: [
      { path: "/", title: "Tallyho", sections: [
        header("Tallyho", "Product Pricing Docs"),
        S("hero", "Answers about your product, without SQL", "Answers about your product, without SQL\nFunnels, retention and dashboards."),
        footer("Tallyho"),
      ] },
      { path: "/pricing", title: "Pricing · Tallyho", sections: [
        S("hero", "Pricing", "Pricing\nFree up to 10k events. Team $99 per month. Enterprise: talk to sales."),
        S("section", "Enterprise", "Enterprise\nSSO, audit logs, dedicated support"),
      ] },
    ],
  },
  {
    url: "https://orbitly.test",
    title: "Orbitly: scheduling that respects your calendar",
    description: "Booking links and team scheduling.",
    notes: "Testimonials wall: masonry of customer quotes with avatars.",
    pages: [
      { path: "/", title: "Orbitly", sections: [
        header("Orbitly", "Product Teams Pricing"),
        S("hero", "Scheduling that respects your calendar", "Scheduling that respects your calendar\nShare one link. Never double-book."),
        S("section", "Loved by teams", "Loved by teams\n\"Orbitly saved our sales team hours every week.\" Dana, Head of Sales\n\"Finally, a booking page our customers like.\" Priya, Founder"),
        footer("Orbitly"),
      ] },
    ],
  },
  {
    url: "https://kiln.test",
    title: "Kiln Studio",
    description: "Brand and product design studio.",
    notes: "Big serif type and a case-study grid.",
    pages: [
      { path: "/", title: "Kiln Studio", sections: [
        S("hero", "We shape brands that last", "We shape brands that last\nIndependent design studio in Lisbon."),
        footer("hello@kiln.test Instagram"),
      ] },
      { path: "/work", title: "Work · Kiln Studio", sections: [
        S("section", "Selected work", "Selected work\nAtlas Coffee rebrand\nMeridian banking app\nField Notes editorial site"),
      ] },
    ],
  },
  {
    url: "https://brightpath.test",
    title: "Brightpath: online courses",
    description: "Learn design and code from working professionals.",
    // An older capture: no sections, no page text.
    pages: [{ path: "/", title: "Brightpath" }, { path: "/courses", title: "Courses · Brightpath" }],
  },
  {
    url: "https://mosaic.test",
    title: "Mosaic CRM",
    description: "The CRM for small sales teams.",
    notes: "Clean two-column signup form with social login.",
    pages: [
      { path: "/", title: "Mosaic CRM", sections: [S("hero", "Close more deals", "Close more deals\nThe CRM small teams actually use.")] },
      { path: "/signup", title: "Create your account · Mosaic", sections: [
        S("section", "Create your account", "Create your account\nContinue with Google\nWork email\nPassword\nStart free"),
      ] },
    ],
  },
  {
    url: "https://harbor.test",
    title: "Harbor Security",
    description: "Cloud security posture management.",
    notes: "Footer with four link columns and a newsletter field.",
    pages: [
      { path: "/", title: "Harbor Security", sections: [
        header("Harbor", "Platform Solutions Resources"),
        S("hero", "See every risk in your cloud", "See every risk in your cloud\nBook a demo"),
        S("section", "Trusted by", "Trusted by security teams\nSOC 2 Type II ISO 27001"),
        footer("Platform Solutions Resources Company\nSubscribe to our newsletter\nEmail address"),
      ] },
    ],
  },
  {
    url: "https://cadence.test",
    title: "Cadence: music for creators",
    description: "Royalty-free music for videos and podcasts.",
    pages: [
      { path: "/", title: "Cadence", sections: [S("hero", "Music that fits your story", "Music that fits your story\nBrowse 40,000 tracks")] },
      { path: "/features", title: "Features · Cadence", sections: [
        S("section", "Everything you need", "Everything you need\nBento grid of features: stems, loops, licensing, search by mood"),
        S("section", "Integrations", "Integrations\nPremiere Pro Final Cut DaVinci Resolve"),
      ] },
    ],
  },
  {
    url: "https://pebble.test",
    title: "Pebble",
    description: "Notes for people who think in lists.",
    pages: [
      { path: "/", title: "Pebble", sections: [S("hero", "Think in lists", "Think in lists\nDownload for Mac")] },
      { path: "/blog", title: "Blog · Pebble", sections: [
        S("section", "Latest posts", "Latest posts\nWhy we built Pebble\nKeyboard shortcuts we love\nRead more"),
      ] },
    ],
  },
  {
    url: "https://northstar.test",
    title: "Northstar",
    description: "Navigation hardware for sailors.",
    notes: "Team grid with hover portraits.",
    pages: [
      { path: "/about", title: "About · Northstar", sections: [
        S("section", "Our team", "Our team\nMarta, CEO\nJonas, Engineering\nAki, Design"),
        S("section", "Timeline", "Timeline\n2014 founded in Kiel\n2019 first ocean crossing"),
      ] },
    ],
  },
]

/** Section heights for placeholder pages, in CSS px. */
const SECTION_PX = 600

/** One fixture page as the capture agent would upload it. */
export function pageUpload(referenceId: string, attempt: string, page: FixturePage, ord: number, base: string): PageUpload {
  const p = `refs/${referenceId}/${attempt}/p${ord}`
  const sections = page.sections?.map((s, i): PageSection => ({ kind: s.kind, label: s.label, y: i * SECTION_PX, height: SECTION_PX, key: `${p}/section-${i}.jpg` }))
  const height = Math.max(1, (page.sections?.length ?? 1) * SECTION_PX)
  return {
    url: base + page.path,
    path: page.path,
    title: page.title,
    ord,
    desktopKey: `${p}/desktop.jpg`,
    desktopThumbKey: `${p}/desktop-thumb.jpg`,
    desktopWidth: 1440,
    desktopHeight: height,
    mobileKey: null,
    mobileThumbKey: null,
    mobileWidth: null,
    mobileHeight: null,
    snapshotKey: null,
    stylesKey: null,
    tokens: null,
    ...(sections ? { sections, text: { body: page.sections!.map((s) => s.text).join("\n"), sections: page.sections!.map((s) => s.text) } } : {}),
    animations: [],
  }
}

const FILLER_WORDS = ["Acme", "Birch", "Copper", "Delta", "Ember", "Fjord", "Garnet", "Helix", "Indigo", "Juniper", "Koda", "Lumen", "Maple", "Nimbus", "Onyx", "Pine", "Quartz", "Rook", "Sable", "Tundra"]

/**
 * Filler websites that answer no task, to make a library the size of a real one: browsing every
 * reference stops being cheap, so the cost of finding things shows. Their words avoid the tasks' words.
 */
export function distractors(n: number): FixtureSite[] {
  return Array.from({ length: n }, (_, i) => {
    const name = `${FILLER_WORDS[i % FILLER_WORDS.length]} ${Math.floor(i / FILLER_WORDS.length) + 1}`
    const slug = name.toLowerCase().replace(/\s+/g, "")
    return {
      url: `https://${slug}.test`,
      title: `${name}: tools for modern teams`,
      description: "Software that helps teams move faster.",
      pages: [
        { path: "/", title: name, sections: [
          header(name, "Product Company Contact"),
          S("hero", "Work better together", `Work better together\n${name} helps your team move faster.\nGet started`),
          S("section", "How it works", "How it works\nConnect your tools\nInvite people\nShip"),
          footer(`${name} Inc. Contact`),
        ] },
        { path: "/about", title: `About · ${name}`, sections: [S("section", "Our mission", `Our mission\n${name} was started to make work simpler.`)] },
      ],
    }
  })
}
