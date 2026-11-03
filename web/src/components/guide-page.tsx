import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  ArrowLeft,
  Clock,
  Database,
  Eye,
  HardDrive,
  KeyRound,
  Lock,
  Monitor,
  PenLine,
  Server,
  Terminal,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { GithubMark, Logo } from "@/App"
import { Footer } from "@/components/landing-page"
import { HL } from "@/lib/hairline/kernel.js"
import { LEADS, network } from "@/lib/hairline/network.js"

const LEAD_LABELS: Record<number, string> = { 0: "Machine", 2: "Worker", 3: "Storage" }

const sections = [
  { id: "privacy", title: "Your data stays yours" },
  { id: "setup", title: "Set it up" },
  { id: "agent-setup", title: "Let your agent set it up" },
  { id: "connect", title: "Connect your agent" },
  { id: "limits", title: "Limits and headroom" },
]

/** Highlights the section nearest the top of the viewport. */
function useActiveSection() {
  const [active, setActive] = useState(sections[0].id)
  useEffect(() => {
    const els = sections.map((s) => document.getElementById(s.id)).filter((el): el is HTMLElement => !!el)
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((e) => e.isIntersecting)
        if (hit) setActive(hit.target.id)
      },
      { rootMargin: "0px 0px -70% 0px" },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])
  return active
}

export function GuidePage({ signedIn }: { signedIn: boolean }) {
  const active = useActiveSection()
  useEffect(() => {
    document.title = "Setup and privacy · Snip"
    // The SPA renders after the initial hash jump, so scroll to the section once it exists.
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView()
    return () => {
      document.title = "Snip"
    }
  }, [])

  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-50 flex h-16 items-center justify-between border-b bg-background/90 px-4 backdrop-blur md:px-12 lg:px-24">
        <div className="flex min-w-0 items-center gap-2">
          <a href="/" className="flex items-center gap-2">
            <Logo className="size-7" />
            <span className="text-sm font-semibold tracking-[-0.025em]">Snip</span>
          </a>
          <span className="px-1 text-sm text-border">/</span>
          <span className="truncate text-sm font-medium text-muted-foreground">Setup and privacy</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a href="/" className="hidden h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-fill-2 hover:text-foreground sm:flex">
            <ArrowLeft className="size-3.5" />
            Back to home
          </a>
          <a href={signedIn ? "/" : "/auth/login?next=%2F"} className="flex h-8 items-center rounded-full bg-fill-2 px-3.5 text-xs font-medium transition-colors hover:bg-fill-3">
            {signedIn ? "Open library" : "Sign in"}
          </a>
        </div>
      </header>

      <div className="flex flex-col gap-5 border-b px-4 pt-20 pb-16 md:px-12 lg:px-24">
        <p className="text-xs font-medium text-muted-foreground">Guide</p>
        <h1 className="text-[40px] leading-[1.05] font-medium tracking-[-0.03em] md:text-[56px]">Setup and privacy</h1>
        <p className="max-w-[620px] text-lg leading-[1.6] text-muted-foreground">
          Snip runs on your own Cloudflare account and your own machine. Here’s where your data lives, who can reach it, and how to set it up.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {["5 setup steps", "Cloudflare free plan", "Node 22 + Chromium"].map((t) => (
            <span key={t} className="flex h-7 items-center rounded-full bg-fill-2 px-3 text-xs font-medium">
              {t}
            </span>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-16 px-4 pt-16 pb-24 md:px-12 lg:px-24">
        <nav aria-label="On this page" className="sticky top-24 hidden w-[220px] shrink-0 flex-col gap-1 pt-1 lg:flex">
          <p className="pb-3 text-xs font-medium text-muted-foreground">On this page</p>
          {sections.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              aria-current={active === s.id ? "location" : undefined}
              className={cn(
                "flex h-8 items-center border-l-2 pl-3 text-sm transition-colors",
                active === s.id ? "border-foreground font-medium text-foreground" : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {s.title}
            </a>
          ))}
        </nav>
        <main className="flex min-w-0 flex-1 flex-col gap-16">
          <PrivacySection />
          <SetupSection />
          <AgentSetupSection />
          <ConnectSection />
          <LimitsSection />
        </main>
      </div>
      <Footer />
    </div>
  )
}

function Section({ id, title, intro, children, first }: { id: string; title: string; intro: ReactNode; children: ReactNode; first?: boolean }) {
  return (
    <section id={id} className={cn("flex scroll-mt-24 flex-col gap-8", !first && "border-t pt-16")}>
      <div className="flex flex-col gap-3">
        <h2 className="text-[32px] leading-[1.15] font-medium tracking-[-0.025em]">{title}</h2>
        <p className="max-w-[640px] leading-[1.6] text-muted-foreground">{intro}</p>
      </div>
      {children}
    </section>
  )
}

function CodeBlock({ lines, label, wrap }: { lines: string[]; label?: string; wrap?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 overflow-x-auto rounded-xl bg-foreground px-4 py-3.5 text-background">
      {label && <span className="text-2xs text-background/60">{label}</span>}
      {lines.map((line) => (
        <code key={line} className={cn("font-mono text-xs leading-[1.6]", wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre")}>
          {line}
        </code>
      ))}
    </div>
  )
}

/** Snip's systems as a Hairline figure: the Worker at the hub, its stores and your machine on branches. Hover a tile and its route lights up hop by hop; until then it walks its own tour. */
function NetworkFigure() {
  const stage = useRef<HTMLDivElement>(null)
  const [readout, setReadout] = useState("rest")
  useEffect(() => {
    const el = stage.current
    if (!el) return
    HL.inject(document)
    const svg = HL.mk("svg", { viewBox: "0 0 400 320", "aria-hidden": "true" }, el)
    let text: string | null = "rest"
    const read = {
      get textContent() {
        return text
      },
      set textContent(v: string | null) {
        text = v
        setReadout(v ?? "")
      },
    }
    const figure = network.mount({ stage: el, svg, read }, network.range[1])
    const lap = HL.tour(el, network.tour ?? [])
    return () => {
      lap.stop()
      figure.destroy()
      svg.remove()
    }
  }, [])
  return (
    <div className="relative flex items-center rounded-2xl bg-card pt-10 ring-1 ring-border [--hairline-edge:color-mix(in_oklab,var(--foreground)_85%,transparent)] [--hairline-hi:var(--primary)] [--hairline-lo:color-mix(in_oklab,var(--foreground)_18%,transparent)] [--hairline-mid:color-mix(in_oklab,var(--foreground)_45%,transparent)] [--hairline-plate:var(--card)] [--hairline-stroke:1.15]">
      <p className="absolute top-4 left-5 text-xs text-muted-foreground">Hover a part to trace its route</p>
      <p aria-live="polite" className="absolute top-4 right-5 font-mono text-xs">{readout}</p>
      <div className="relative mx-auto w-full max-w-[560px]">
        <div ref={stage} data-hairline={network.name} role="img" aria-label={network.means} />
        {/* Labels at the ends of the figure's leader lines, in viewBox units (400 × 320). */}
        {LEADS.map(([part, y]) => (
          <span
            key={part}
            aria-hidden="true"
            className="absolute -translate-y-1/2 font-mono text-2xs tracking-wide text-muted-foreground uppercase"
            style={{ left: `${(348 / 400) * 100}%`, top: `${(y / 320) * 100}%` }}
          >
            {LEAD_LABELS[part]}
          </span>
        ))}
      </div>
    </div>
  )
}

function PrivacySection() {
  const systems = [
    { k: "Worker", v: "Gallery, API and the /mcp endpoint", Icon: Server },
    { k: "D1", v: "References, pages, animations, collections", Icon: Database },
    { k: "R2", v: "Screenshots, GIFs, HTML snapshots, styles", Icon: HardDrive },
    { k: "KV", v: "OAuth tokens for connected agents", Icon: KeyRound },
    { k: "Machine", v: "The capture agent: Playwright and Chromium. Polls your queue, records each page, uploads the files.", Icon: Monitor },
  ]
  const facts = [
    {
      t: "Only logins you list",
      b: "Sign-in goes through GitHub, and only accounts in ALLOWED_GITHUB_LOGINS get in. Sessions are signed cookies that last 30 days.",
      Icon: GithubMark,
    },
    {
      t: "Captures run on your laptop",
      b: "Chromium browses on your machine and uploads with your own CAPTURE_TOKEN. No shared crawler ever sees your list.",
      Icon: Monitor,
    },
    { t: "Agents ask before reading", b: "MCP clients send you through GitHub login and a consent screen before they can search or read anything.", Icon: Lock },
    { t: "File links expire", b: "Screenshot and snapshot URLs handed to agents are signed and stop working after 24 hours.", Icon: Clock },
  ]
  return (
    <Section
      id="privacy"
      first
      title="Your data stays yours"
      intro="There is no Snip server. You deploy the app to your Cloudflare account, and a capture agent on your laptop does the browsing. Every screenshot, snapshot and token is stored in resources you own."
    >
      <div className="grid grid-cols-1 gap-3 rounded-4xl bg-fill-1 p-3 ring-1 ring-border lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <NetworkFigure />
        <dl className="flex flex-col justify-center rounded-2xl bg-card px-6 py-2 ring-1 ring-border">
          {systems.map(({ k, v, Icon }, i) => (
            <div key={k} className={cn("flex items-start gap-3 py-3", i > 0 && "border-t")}>
              <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <dt className="w-16 shrink-0 font-mono text-xs leading-5 font-medium">{k}</dt>
              <dd className="text-sm text-muted-foreground">{v}</dd>
            </div>
          ))}
          <p className="border-t pt-3 pb-1 text-xs leading-[1.5] text-muted-foreground">Queued captures wait until the agent is running.</p>
        </dl>
      </div>
      <div className="grid grid-cols-1 gap-x-12 gap-y-8 pt-2 md:grid-cols-2">
        {facts.map(({ t, b, Icon }) => (
          <div key={t} className="flex gap-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-fill-2">
              <Icon className="size-4" />
            </span>
            <div className="flex flex-col gap-1.5">
              <p className="font-medium">{t}</p>
              <p className="text-[15px] leading-[1.6] text-muted-foreground">{b}</p>
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

function SetupSection() {
  const steps = [
    {
      t: "Create a GitHub OAuth app",
      b: "In GitHub, open Settings → Developer settings → OAuth Apps and add a new one with these two URLs.",
      c: ["Homepage URL   https://snip.<your-subdomain>.workers.dev", "Callback URL   https://snip.<your-subdomain>.workers.dev/auth/callback"],
    },
    {
      t: "Create the Cloudflare resources",
      b: "Paste the printed ids into web/wrangler.jsonc, then set PUBLIC_URL and ALLOWED_GITHUB_LOGINS in the same file.",
      c: ["cd web", "npx wrangler d1 create snip", "npx wrangler kv namespace create OAUTH_KV", "npx wrangler r2 bucket create snip-files"],
    },
    {
      t: "Add your secrets",
      b: "Generate SESSION_SECRET and CAPTURE_TOKEN with openssl rand -hex 32. Keep the capture token for step 5.",
      c: [
        "npx wrangler secret put GITHUB_CLIENT_ID",
        "npx wrangler secret put GITHUB_CLIENT_SECRET",
        "npx wrangler secret put SESSION_SECRET",
        "npx wrangler secret put CAPTURE_TOKEN",
      ],
    },
    {
      t: "Migrate and deploy",
      b: "This creates the database tables and publishes the gallery to your workers.dev subdomain.",
      c: ["npm run db:migrate:remote", "npm run deploy"],
    },
    {
      t: "Start the capture agent",
      b: "Point capture/.env at your Worker with the same CAPTURE_TOKEN, install Chromium once, then leave the agent running.",
      c: ["cp capture/.env.example capture/.env", "npx playwright install chromium", "npm run capture"],
    },
  ]
  return (
    <Section id="setup" title="Set it up" intro="Everything fits in Cloudflare’s free plan. You need a GitHub account, a Cloudflare account and Node 22.">
      <ol className="flex max-w-[760px] flex-col">
        {steps.map((s, i) => (
          <li key={s.t} className="flex gap-4 md:gap-6">
            <div className="flex shrink-0 flex-col items-center">
              <span className="grid size-8 place-items-center rounded-full bg-foreground text-xs font-semibold text-background">{i + 1}</span>
              {i < steps.length - 1 && <span className="w-px flex-1 bg-border" />}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1 pb-10">
              <h3 className="text-lg leading-[1.4] font-medium">{s.t}</h3>
              <p className="text-[15px] leading-[1.6] text-muted-foreground">{s.b}</p>
              <div className="mt-1">
                <CodeBlock lines={s.c} />
              </div>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex max-w-[760px] items-start gap-3 rounded-2xl bg-note p-5 text-note-ink">
        <Terminal className="mt-0.5 size-4 shrink-0" />
        <div className="flex flex-col gap-1">
          <p className="text-[15px] font-medium">Trying it locally first</p>
          <p className="text-sm leading-[1.6]">
            Copy web/.dev.vars.example to web/.dev.vars and run npm run dev. DEV_LOGIN skips GitHub sign-in on localhost only, so never set it in production.
          </p>
        </div>
      </div>
    </Section>
  )
}

function AgentSetupSection() {
  const llms = `${location.origin}/llms.txt`
  return (
    <Section
      id="agent-setup"
      title="Let your agent set it up"
      intro={
        <>
          <a href="/llms.txt" className="font-medium text-foreground underline-offset-4 hover:underline">
            llms.txt
          </a>{" "}
          describes the whole setup in plain text for coding agents. Paste this into Claude Code or any agent that can run commands.
        </>
      }
    >
      <div className="flex max-w-[760px] flex-col gap-4">
        <CodeBlock wrap label="Prompt" lines={[`Read ${llms} and set up Snip for me.`]} />
        <p className="max-w-[640px] text-[15px] leading-[1.6] text-muted-foreground">
          The agent runs the commands and stops for the parts only you can do: creating the GitHub OAuth app, signing in to Cloudflare and typing secret values.
        </p>
      </div>
    </Section>
  )
}

function ConnectSection() {
  const groups = [
    {
      g: "Read",
      Icon: Eye,
      tools: [
        ["search_references", "Search by text, collection or domain"],
        ["get_reference", "Tokens, every page and its GIFs"],
        ["get_page", "One page with an inline screenshot"],
        ["search_animations", "Scroll and hover GIFs across references"],
        ["list_collections", "Collections with counts"],
      ],
    },
    {
      g: "Write",
      Icon: PenLine,
      tools: [
        ["add_reference", "Queue a URL for capture"],
        ["create_collection", "Start a new collection"],
        ["set_collection_membership", "Add or remove a reference"],
      ],
    },
  ]
  return (
    <Section
      id="connect"
      title="Connect your agent"
      intro="Your Worker serves an MCP endpoint at /mcp. Clients register themselves, then send you through GitHub login and a consent screen."
    >
      <div className="flex max-w-[760px] flex-col gap-4">
        <CodeBlock label="Claude Code" lines={["claude mcp add --transport http snip https://snip.<your-subdomain>.workers.dev/mcp"]} />
        <p className="text-sm leading-[1.6] text-muted-foreground">For Claude.ai or Claude Desktop, add a custom connector with the same URL.</p>
      </div>
      <div className="grid max-w-[760px] grid-cols-1 items-start gap-6 md:grid-cols-2">
        {groups.map(({ g, Icon, tools }) => (
          <div key={g} className="flex flex-col gap-1 rounded-2xl bg-card p-5 ring-1 ring-border">
            <p className="flex items-center gap-2 pb-2 text-xs font-medium text-muted-foreground">
              <Icon className="size-3.5" />
              {g}
            </p>
            {tools.map(([name, desc]) => (
              <div key={name} className="flex flex-col gap-0.5 border-t py-2.5">
                <code className="font-mono text-xs font-medium">{name}</code>
                <span className="text-sm text-muted-foreground">{desc}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Section>
  )
}

function LimitsSection() {
  const stats = [
    { k: "R2 storage", v: "10 GB", d: "Roughly 1,500 to 3,000 captured pages" },
    { k: "D1 database", v: "5 GB", d: "References, pages and collections" },
    { k: "Worker requests", v: "100k", d: "Per day, gallery and agents combined" },
  ]
  const limits = [
    ["Page height", "Full-page screenshots stop at 16,000 px, Chromium’s texture limit."],
    ["Crawl scope", "Crawls stay on one hostname, with or without www, and ignore query strings."],
    ["Logins and bot walls", "Captures show what an anonymous browser sees. Obvious cookie banners are dismissed."],
    ["Hover GIFs", "Up to 6 elements per page. Shared nav and footer effects are recorded once per site."],
  ]
  return (
    <Section id="limits" title="Limits and headroom" intro="What the free plan holds, and what a capture can’t see.">
      <div className="grid max-w-[760px] grid-cols-1 divide-y rounded-2xl bg-card ring-1 ring-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {stats.map((s) => (
          <div key={s.k} className="flex flex-col gap-1.5 p-6">
            <p className="text-xs font-medium text-muted-foreground">{s.k}</p>
            <p className="text-[32px] leading-[1.2] font-medium tracking-[-0.025em] tabular-nums">{s.v}</p>
            <p className="text-sm leading-[1.5] text-muted-foreground">{s.d}</p>
          </div>
        ))}
      </div>
      <dl className="flex max-w-[760px] flex-col">
        {limits.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-1 border-t py-4 sm:flex-row sm:gap-6">
            <dt className="w-[180px] shrink-0 text-[15px] font-medium">{k}</dt>
            <dd className="text-[15px] leading-[1.6] text-muted-foreground">{v}</dd>
          </div>
        ))}
      </dl>
    </Section>
  )
}
