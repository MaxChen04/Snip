import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  ArrowLeft,
  Database,
  Eye,
  HardDrive,
  KeyRound,
  LaptopIcon,
  Lock,
  Monitor,
  PenLine,
  Server,
} from "@/components/icons"
import { cn } from "@/lib/utils"
import { PUBLIC_SITE, REPO_URL } from "@/lib/site"
import { Logo } from "@/components/brand"
import { Footer } from "@/components/landing-page"
import { HL } from "@/lib/hairline/kernel.js"
import { LEADS, network } from "@/lib/hairline/network.js"

const LEAD_LABELS: Record<number, string> = { 0: "Machine", 2: "Worker", 3: "Storage" }

const sections = [
  { id: "privacy", title: "Your data stays yours" },
  { id: "setup", title: "Set it up" },
  { id: "cloud", title: "Use it on other devices" },
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
          <a href={signedIn ? "/" : PUBLIC_SITE ? REPO_URL : "/auth/login?next=%2F"} className="flex h-8 items-center rounded-full bg-fill-2 px-3.5 text-xs font-medium transition-colors hover:bg-fill-3">
            {signedIn ? "Open library" : PUBLIC_SITE ? "GitHub" : "Sign in"}
          </a>
        </div>
      </header>

      <div className="flex flex-col gap-5 border-b px-4 pt-20 pb-16 md:px-12 lg:px-24">
        <p className="text-xs font-medium text-muted-foreground">Guide</p>
        <h1 className="text-[40px] leading-[1.05] font-medium tracking-[-0.03em] md:text-[56px]">Setup and privacy</h1>
        <p className="max-w-[620px] text-lg leading-[1.6] text-muted-foreground">
          Snip runs on your Mac and keeps your library there. Here’s where your data lives, who can reach it, and how to add cloud access when you want it.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {["Runs on your Mac", "No account needed", "Cloudflare optional"].map((t) => (
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
          <CloudSection />
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
    <div className="network-figure relative flex items-center overflow-hidden rounded-2xl bg-card pt-10 ring-1 ring-border [--hairline-edge:color-mix(in_oklab,var(--foreground)_55%,transparent)] [--hairline-hi:var(--foreground)] [--hairline-lo:color-mix(in_oklab,var(--foreground)_18%,transparent)] [--hairline-mid:color-mix(in_oklab,var(--foreground)_45%,transparent)] [--hairline-plate:var(--card)] [--hairline-stroke:1.15]">
      <p className="absolute top-4 left-5 text-xs text-muted-foreground">Hover a part to trace its route</p>
      <p aria-live="polite" className="absolute top-4 right-5 font-mono text-xs">{readout}</p>
      <div className="relative mx-auto -my-[10%] w-full max-w-[640px]">
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
    { k: "Machine", v: "Runs the app and the capture agent. Queued captures wait until it is running.", Icon: Monitor },
  ]
  const facts = [
    {
      t: "Local by default",
      b: "Snip.app serves the gallery and the API from your Mac and keeps every capture in the library folder. No account, no server, no upload.",
      Icon: LaptopIcon,
    },
    {
      t: "Captures run on your Mac",
      b: "Chromium browses on your machine with your own capture token. No shared crawler ever sees your list.",
      Icon: Monitor,
    },
    {
      t: "Cloud is your own account",
      b: "If you host Snip, everything lives in Cloudflare resources you create. There is no Snip server in either mode.",
      Icon: Server,
    },
    {
      t: "Agents ask before reading",
      b: "Clients approve access first: a consent screen locally, GitHub login and a consent screen when hosted. File links they receive are signed and expire after 24 hours.",
      Icon: Lock,
    },
  ]
  return (
    <Section
      id="privacy"
      first
      title="Your data stays yours"
      intro="Snip.app runs the gallery, the API and the capture agent on your Mac. D1, R2 and KV are files in the library folder. Hosting the same app on your own Cloudflare account is optional."
    >
      <div className="flex flex-col gap-3 rounded-4xl bg-fill-1 p-3 ring-1 ring-border">
        <NetworkFigure />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-2xl bg-card px-5 py-4 ring-1 ring-border sm:grid-cols-3 lg:grid-cols-5">
          {systems.map(({ k, v, Icon }) => (
            <div key={k} className="flex flex-col gap-1">
              <dt className="flex items-center gap-1.5 font-mono text-xs font-medium">
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                {k}
              </dt>
              <dd className="text-xs leading-[1.5] text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="max-w-[760px] text-[15px] leading-[1.6] text-muted-foreground">
        Locally every store is a file on this Mac. In cloud mode they are the same four pieces in your Cloudflare account, and the app is the same app.
      </p>
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
      t: "Create the local config",
      b: "The app needs two random secrets. Copy the example and fill in SESSION_SECRET and CAPTURE_TOKEN with a value from openssl rand -hex 32, then apply the database migrations. DEV_LOGIN is the name you appear as; there is no sign-in locally.",
      c: ["cp web/.dev.vars.example web/.dev.vars", "npm run db:migrate:local -w web"],
    },
    {
      t: "Point the capture agent at the app",
      b: "capture/.env ships with SNIP_URL set to http://localhost:5173. Paste the same CAPTURE_TOKEN so the agent can claim jobs. The agent installs Chromium on its first capture.",
      c: ["cp capture/.env.example capture/.env"],
    },
    {
      t: "Build and open Snip.app",
      b: "This builds the app and installs it in /Applications. It starts the web app and the capture agent together. To work with hot reload instead, run npm run dev and npm run capture in two terminals and open http://localhost:5173.",
      c: ["npm run app"],
    },
    {
      t: "Check the setup",
      b: "The doctor reads both config files and the running app, then prints one line per problem with its fix.",
      c: ["npm run doctor"],
    },
  ]
  return (
    <Section
      id="setup"
      title="Set it up"
      intro="Everything runs on your Mac and fits in a few commands. You need Node 22.18+, and Snip.app needs an Apple Silicon Mac on macOS 14 or later."
    >
      <p className="max-w-[760px] text-[15px] leading-[1.6] text-muted-foreground">
        Clone the repository, install dependencies, and follow the steps from the repository root.
      </p>
      <CodeBlock lines={["git clone https://github.com/MaxChen04/Snip.git", "cd Snip", "npm install"]} />
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
        <Lock className="mt-0.5 size-4 shrink-0" />
        <div className="flex flex-col gap-1">
          <p className="text-[15px] font-medium">No account needed</p>
          <p className="text-sm leading-[1.6]">
            Local mode never asks you to sign in. DEV_LOGIN in web/.dev.vars names the local user, and nothing leaves the Mac. Never set it on a deployed Worker.
          </p>
        </div>
      </div>
    </Section>
  )
}

function CloudSection() {
  const steps = [
    {
      t: "Run the setup",
      b: "It signs you in to Cloudflare, asks for your GitHub login and workers.dev subdomain, creates the database, key-value store and storage bucket, then deploys. R2 has to be switched on once in the Cloudflare dashboard (R2 → Get started) before the bucket can be created. If capture/.env already points somewhere else, it asks before changing it and otherwise saves capture/.env.cloudflare.",
      c: ["npm run setup:cloudflare"],
    },
    {
      t: "Create a GitHub OAuth app when asked",
      b: "The setup prints both URLs. In GitHub, open Settings → Developer settings → OAuth Apps, add a new one, then paste its Client ID and a new Client secret into the setup. It generates the other secrets itself.",
      c: ["Homepage URL   https://snip.<your-subdomain>.workers.dev", "Callback URL   https://snip.<your-subdomain>.workers.dev/auth/callback"],
    },
    {
      t: "Sign in at the URL it prints",
      b: "Only the GitHub login you gave the setup can get in. To have this Mac's agent serve the hosted copy without moving the local one, run it with the cloud env file.",
      c: ["SNIP_CAPTURE_ENV_FILE=capture/.env.cloudflare npm run capture"],
    },
  ]
  return (
    <Section
      id="cloud"
      title="Use Snip on your other devices"
      intro="Optional. Snip works completely on your Mac. Cloud mode deploys the same app to your own Cloudflare account, so another Mac, a browser or a cloud agent such as Claude.ai can read the library. The account is yours; nothing is shared with anyone else."
    >
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
        <Server className="mt-0.5 size-4 shrink-0" />
        <div className="flex flex-col gap-1">
          <p className="text-[15px] font-medium">What this is today</p>
          <p className="text-sm leading-[1.6]">
            The setup deploys a separate Snip with its own library. Your local references are not copied to it, and the in-app Enable cloud button that will copy them
            is not released yet.{" "}
            <a href={`${REPO_URL}/blob/main/docs/deploy.md`} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
              Cloud mode
            </a>{" "}
            covers upgrading, turning it off and doing it by hand.
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
          describes the whole setup in plain text for coding agents, local first, with cloud mode as an optional second half. Paste this into Claude Code or any agent that can run commands.
        </>
      }
    >
      <div className="flex max-w-[760px] flex-col gap-4">
        <CodeBlock wrap label="Prompt" lines={[`Read ${llms} and set up Snip for me.`]} />
        <p className="max-w-[640px] text-[15px] leading-[1.6] text-muted-foreground">
          The agent runs the commands and stops for the parts only you can do: creating the GitHub OAuth app and signing in to Cloudflare, if you ask for cloud mode.
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
        ["get_reference", "An overview, then pages, animations or tokens in smaller parts"],
        ["get_page", "One page with an inline screenshot"],
        ["get_page_styles", "Computed styles filtered by element, text or section"],
        ["get_animation", "A contact sheet, sampled frame or original GIF"],
        ["search_pages", "Pages across references, or every page in a collection"],
        ["search_animations", "Scroll and hover GIFs across references"],
        ["get_capture_status", "Capture progress and whether your capture agent is online"],
        ["list_collections", "Collections with counts"],
      ],
    },
    {
      g: "Write",
      Icon: PenLine,
      tools: [
        ["add_reference", "Queue a URL for capture"],
        ["create_collection", "Start a new collection"],
        ["set_collection_membership", "Add or remove a website"],
        ["set_page_collection_membership", "Add or remove individual pages"],
      ],
    },
  ]
  return (
    <Section
      id="connect"
      title="Connect your agent"
      intro="Your Worker serves an MCP endpoint at /mcp. Locally that is http://localhost:5173/mcp, which only clients on this Mac can reach while Snip is running. Clients register themselves, ask for your approval and show a consent screen."
    >
      <div className="flex max-w-[760px] flex-col gap-4">
        <CodeBlock label="Claude Code" lines={["claude mcp add --transport http snip http://localhost:5173/mcp"]} />
        <CodeBlock label="Codex" lines={["codex mcp add snip --url http://localhost:5173/mcp", "codex mcp login snip"]} />
        <CodeBlock
          label="OpenCode · ~/.config/opencode/opencode.json, then opencode mcp auth snip"
          lines={['{ "mcp": { "snip": { "type": "remote", "url": "http://localhost:5173/mcp" } } }']}
        />
        <p className="text-sm leading-[1.6] text-muted-foreground">
          For Claude.ai or Claude Desktop, add a custom connector with the same URL. In cloud mode, use your deployed URL in every command and connector above.
        </p>
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
    ["Local storage", "Only limited by your disk. Every capture is a file in the library folder, and the account menu shows the bytes used."],
    ["Sign-in", "None locally: DEV_LOGIN names you. A hosted Snip signs in with GitHub, and only accounts in ALLOWED_GITHUB_LOGINS get in."],
    ["Page height", "Full-page screenshots stop at 16,000 px, Chromium’s texture limit."],
    ["Crawl scope", "Crawls stay on one hostname, with or without www, and ignore query strings."],
    ["Logins and bot walls", "Captures show what an anonymous browser sees, unless you tick “Use my saved sign-in” and point STORAGE_STATE at a Playwright sign-in file. Obvious cookie banners are dismissed."],
    ["Hover GIFs", "Up to 6 elements per page. Shared nav and footer effects are recorded once per site."],
  ]
  return (
    <Section id="limits" title="Limits and headroom" intro="Locally the library is limited only by your disk. In cloud mode, everything fits in Cloudflare’s free plan.">
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
