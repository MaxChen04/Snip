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
  { id: "turning-off", title: "Turning cloud off" },
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
          <TurningOffSection />
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
      b: "Chromium browses on your machine with your own capture token. No shared crawler ever sees your list, and a queued cloud capture waits until this Mac is awake.",
      Icon: Monitor,
    },
    {
      t: "Cloud is your own account",
      b: "If you enable it, the library is copied into Cloudflare resources you create. There is no Snip server in either mode, and the local copy is kept as a snapshot.",
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
      t: "Settings → Cloud → Enable cloud",
      b: "Snip shows what copies first: every reference, page, animation, collection, note, token and file. Your local library stays exactly where it is and becomes the snapshot you can go back to. Browser sessions and MCP grants don't move; agents sign in again at the new address. Then the copy starts, one step at a time, with a Retry button on any failure.",
    },
    {
      t: "Allow it in Cloudflare",
      b: "Your browser opens on Cloudflare. Sign in, choose the account that should own the library, and press Allow. If you belong to more than one account, pick one here.",
    },
    {
      t: "Turn on R2, if it has never been used",
      b: "Cloudflare asks for a card once to switch on R2, even though storage is free up to 10 GB. Snip opens the R2 page and waits; the setup continues by itself when you come back.",
    },
    {
      t: "Register your passkey",
      b: "A one-time owner link opens in your browser, registers a passkey (Touch ID on a Mac) and signs Snip.app back in. The link works once and expires after ten minutes. From then on, every other browser or device signs in at /sign-in with its own passkey; Passkeys and devices in the account menu adds or removes them. A passkey is owner-only, not an invitation: a second person signs in with GitHub.",
    },
  ]
  return (
    <Section
      id="cloud"
      title="Use Snip on your other devices"
      intro="Optional. Snip works completely on your Mac. Cloud mode copies the library into your own Cloudflare account, so another Mac, a browser or a cloud agent such as Claude.ai can read it. Capture still runs here."
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
            </div>
          </li>
        ))}
      </ol>
      <div className="grid max-w-[760px] grid-cols-1 gap-4 md:grid-cols-2">
        {[
          { t: "Waiting for your Mac", b: "A capture started from another device waits in the cloud queue until this Mac's capture agent checks in. The card and every agent status say Waiting for your Mac, whether the agent is busy or the Mac is asleep." },
          { t: "One Snip per account", b: "An older Snip you already deployed is recognised, not refused: if it's empty it's adopted, and if it has references you choose Use that library or Stop. A Worker named snip that isn't a Snip is refused, with instructions to rename or delete it or pick another account." },
          { t: "workers.dev only", b: "The address is https://snip.<your-subdomain>.workers.dev. Custom domains aren't supported in this release, because the address is what your passkey and agent connections are bound to." },
          { t: "GitHub is optional", b: "You sign in with your passkey. GitHub is how a second person or a cloud MCP client authorizes, registered in one click from Settings. There is no OAuth app to create and no secret to paste." },
        ].map(({ t, b }) => (
          <div key={t} className="flex flex-col gap-1.5 rounded-2xl bg-card p-5 ring-1 ring-border">
            <p className="text-[15px] font-medium">{t}</p>
            <p className="text-sm leading-[1.6] text-muted-foreground">{b}</p>
          </div>
        ))}
      </div>
      <div className="flex max-w-[760px] flex-col gap-4">
        <h3 className="text-lg leading-[1.4] font-medium">From a terminal, or from an agent</h3>
        <p className="max-w-[640px] text-[15px] leading-[1.6] text-muted-foreground">
          The button and the command line run the same engine. Use it to script a setup or to hand the job to an agent. It never prompts: a step that needs you emits a URL, and a missing value exits with the flag to add.
        </p>
        <CodeBlock label="Preflight, then enable without prompts" lines={["npm run setup:cloudflare -- --check --json", "npm run setup:cloudflare -- --yes --json"]} />
        <p className="max-w-[640px] text-sm leading-[1.6] text-muted-foreground">
          Output is one JSON event per line; the last is always result. Exit 0 means success, 2 means a flag or a choice is unanswered, 3 means another run holds the lock, 4 means this machine or library can't be provisioned right now. The agent stops for the Cloudflare Allow page, the R2 page and the owner link, and never types a secret into a chat.
        </p>
        <p className="max-w-[640px] text-sm leading-[1.6] text-muted-foreground">
          --yes never adopts an existing library: pass --adopt-existing when Use that library is the intended answer. The CLI also leaves capture/.env alone and writes capture/.env.cloud; serve the cloud library with SNIP_CAPTURE_ENV_FILE=capture/.env.cloud npm run capture. The app's button instead points capture/.env at the copy, which is the intended end state.
        </p>
        <p className="max-w-[640px] text-sm leading-[1.6] text-muted-foreground">
          The bare npm run setup:cloudflare means setup. Put any other command after --: status, detach, pull, snapshot restore, snapshot delete, delete-resources, owner link, owner rotate, abort, migrate or deploy.
        </p>
      </div>
      <div className="flex max-w-[760px] items-start gap-3 rounded-2xl bg-note p-5 text-note-ink">
        <Server className="mt-0.5 size-4 shrink-0" />
        <div className="flex flex-col gap-1">
          <p className="text-[15px] font-medium">Full lifecycle</p>
          <p className="text-sm leading-[1.6]">
            <a href={`${REPO_URL}/blob/main/docs/deploy.md`} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
              Cloud mode
            </a>{" "}
            covers every command, upgrading, the snapshot, deleting cloud resources and what to do if the cloud library can't be reached.
          </p>
        </div>
      </div>
    </Section>
  )
}

function TurningOffSection() {
  const outcomes = [
    { t: "Stay in cloud", b: "Cancel. Nothing changes." },
    { t: "Turn off and keep local", b: "This Mac goes back to the copy from before the move. The cloud library stays live at its address, and every device and agent signed in to it keeps working." },
    { t: "Bring the cloud library back", b: "Copies the cloud library down first, verifies it, then switches this Mac to it. The same action is available later as Copy back now." },
  ]
  return (
    <Section
      id="turning-off"
      title="Turning cloud off"
      intro="Turning off detaches this Mac. It does not delete the cloud copy, and nothing is carried back automatically."
    >
      <p className="max-w-[760px] text-[15px] leading-[1.6] text-muted-foreground">
        Settings → Cloud → Turn off cloud asks first, and says what stays: changes made in the cloud library remain there, this Mac returns to its snapshot, and the cloud library is
        still reachable by anything signed in to it.
      </p>
      <dl className="flex max-w-[760px] flex-col">
        {outcomes.map(({ t, b }) => (
          <div key={t} className="flex flex-col gap-1 border-t py-4 sm:flex-row sm:gap-6">
            <dt className="w-[200px] shrink-0 text-[15px] font-medium">{t}</dt>
            <dd className="text-[15px] leading-[1.6] text-muted-foreground">{b}</dd>
          </div>
        ))}
      </dl>
      <div className="flex max-w-[760px] flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <p className="text-[15px] font-medium">Copy back now</p>
          <p className="text-[15px] leading-[1.6] text-muted-foreground">
            Downloads a manifest, exports the cloud database, stages a new local library, downloads every file, checks the counts and a digest, then swaps it in. The library from
            before the move is kept as a backup.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-[15px] font-medium">The snapshot</p>
          <p className="text-[15px] leading-[1.6] text-muted-foreground">
            After a move, Settings lists the pre-cloud library with its date and size, for example “Snapshot from 6 Nov, 10:12 — 812 MB”. Restore puts it back; Delete removes it.
            The row is hidden when the library was empty.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-[15px] font-medium">Delete cloud resources</p>
          <p className="text-[15px] leading-[1.6] text-muted-foreground">
            Separate, destructive and never offered inside the turn-off dialog. Removes the Worker, database, key-value store and bucket after you type the library's address. The local
            library and snapshot are untouched.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-[15px] font-medium">Sign out all devices</p>
          <p className="text-[15px] leading-[1.6] text-muted-foreground">
            Ends every browser session and this app's session for the install. Passkeys stay registered, and agents connected over MCP keep their own tokens until those expire.
            Removing a device is separate, on the Passkeys and devices page: a passkey is a credential, not a session.
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
          The agent runs the commands and stops for anything only you can do: opening the Cloudflare Allow page, turning on R2, and the owner link. It never asks you to paste a secret
          into a chat.
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
        ["get_capture_status", "Capture progress and whether your capture agent is online; a queued cloud capture says Waiting for your Mac"],
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
          For Claude.ai or Claude Desktop, add a custom connector with the same URL. In cloud mode, use your deployed URL in every command and connector above, and keep GitHub sign-in on
          with at least your own login listed: a cloud client authorizes through GitHub, while you sign in with your passkey.
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
    ["Sign-in", "None locally: DEV_LOGIN names you. Cloud mode signs you in with a passkey at /sign-in; GitHub is optional and only needed for a second person or a cloud MCP client."],
    ["Address", "Cloud mode uses https://snip.<your-subdomain>.workers.dev. Custom domains are not supported in this release."],
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
