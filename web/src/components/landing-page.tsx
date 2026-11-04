import { useEffect, useState, type ReactNode } from "react"
import { ArrowRight, Check, Link2 } from "@/components/icons"
import { cn } from "@/lib/utils"
import { Logo } from "@/components/brand"
import { PUBLIC_SITE, REPO_URL, signInHref } from "@/lib/site"

// Self-hosted instances sign in; the public site points to the source.
const primaryHref = () => (PUBLIC_SITE ? REPO_URL : signInHref())
const primaryLabel = PUBLIC_SITE ? "Get Snip on GitHub" : "Sign in with GitHub"

const img = (name: string) => `/landing/${name}.jpg`

export function LandingPage() {
  return (
    <div className="min-h-svh bg-background">
      <Nav />
      <Hero />
      <CaptureSection />
      <TokensSection />
      <MotionSection />
      <HowSection />
      <FaqSection />
      <FinalCta />
      <Footer />
    </div>
  )
}

function Nav() {
  return (
    <header className="sticky top-0 z-50 flex justify-center px-4 pt-4 pb-3">
      <nav className="flex h-11 items-center gap-1 rounded-full bg-background p-1.5 shadow-sm ring-1 ring-border">
        <a href="/" className="flex items-center gap-1">
          <span className="grid size-8 place-items-center">
            <Logo className="size-7" />
          </span>
          <span className="pr-2.5 pl-0.5 text-sm font-semibold tracking-[-0.025em]">Snip</span>
        </a>
        <div className="hidden items-center md:flex">
          {[
            ["Capture", "#capture"],
            ["Styles", "#styles"],
            ["Agents", "#agents"],
            ["How it works", "#how-it-works"],
          ].map(([label, href]) => (
            <a key={href} href={href} className="flex h-8 items-center rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-fill-2 hover:text-foreground">
              {label}
            </a>
          ))}
        </div>
        <span className="mx-1 h-5 w-px bg-border" />
        <a href={primaryHref()} className="flex h-8 items-center rounded-full bg-fill-2 px-3.5 text-xs font-medium transition-colors hover:bg-fill-3">
          {PUBLIC_SITE ? "GitHub" : "Sign in"}
        </a>
      </nav>
    </header>
  )
}

const pill = "inline-flex h-12 items-center gap-2 rounded-full px-[22px] text-[15px] font-medium transition-colors"

function Hero() {
  return (
    <section className="flex flex-col items-center px-4 pt-[72px] pb-24">
      <div className="flex max-w-[760px] flex-col items-center gap-5 text-center">
        <p className="text-xs font-medium text-muted-foreground">A private library of website design references</p>
        <h1 className="text-[40px] leading-[1.05] font-medium tracking-[-0.05em] text-balance md:text-[64px]">A shelf for the websites you admire</h1>
        <p className="max-w-[560px] text-lg leading-[1.55] text-muted-foreground">
          Paste a URL. Snip captures every page, its styles and its motion, then keeps it all in a library only you can open.
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
          <a href={primaryHref()} className={cn(pill, "bg-foreground text-background hover:bg-foreground/90")}>
            {primaryLabel}
          </a>
          <a href="#how-it-works" className={cn(pill, "ring-1 ring-border hover:bg-fill-1")}>
            See how it works
          </a>
        </div>
      </div>
      <HeroArtwork />
    </section>
  )
}

/** The peel: a page whose bottom-right corner curls up to show the page beneath. `--peel` sets the curl size. */
function PeelTile({ front, back, className, children }: { front: string; back: string; className?: string; children?: ReactNode }) {
  return (
    <div className={cn("peel relative overflow-clip", className)}>
      <img src={back} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
      <div className="absolute right-0 bottom-0 size-(--peel) bg-linear-135 from-black/45 to-transparent [clip-path:polygon(100%_0,0_100%,100%_100%)]" />
      <img
        src={front}
        alt=""
        loading="lazy"
        className="absolute inset-0 size-full object-cover [clip-path:polygon(0_0,100%_0,100%_calc(100%-var(--peel)),calc(100%-var(--peel))_100%,0_100%)]"
      />
      <div className="absolute right-0 bottom-0 size-(--peel) bg-linear-135 from-white via-neutral-100 to-neutral-300 [clip-path:polygon(0_0,100%_0,0_100%)]" />
      {children}
    </div>
  )
}

const DEMO_URL = "stripe.com"
const DEMO_PAGES = 12
const DEMO_LOOP = 84 // ticks of 120 ms: type the URL, pause, capture 12 pages, hold

/** Drives the hero loop: types a URL, then counts captured pages. Holds a still frame for reduced motion. */
function useCaptureDemo() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setTick(24)
      return
    }
    const id = setInterval(() => setTick((t) => (t + 1) % DEMO_LOOP), 120)
    return () => clearInterval(id)
  }, [])
  const typed = DEMO_URL.slice(0, Math.min(tick, DEMO_URL.length))
  const pages = tick < 16 ? 0 : Math.min(Math.floor((tick - 16) / 4) + 1, DEMO_PAGES)
  const status =
    pages === 0
      ? typed.length < DEMO_URL.length
        ? "Paste a URL"
        : "Starting capture…"
      : pages < DEMO_PAGES
        ? `Capturing ${pages} of ${DEMO_PAGES} pages`
        : `${DEMO_PAGES} pages on your shelf`
  return { typed, typing: typed.length < DEMO_URL.length, pages, status }
}

const card = "absolute overflow-clip rounded-xl bg-card ring-1 ring-black/10"
const note = "absolute hidden h-[72px] w-[108px] place-items-center bg-note text-[15px] font-medium text-note-ink shadow-md animate-in fade-in zoom-in-90 duration-300 md:grid"

function HeroArtwork() {
  const { typed, typing, pages, status } = useCaptureDemo()
  return (
    <div aria-hidden="true" className="@container relative mt-14 aspect-[1120/520] w-full max-w-[1120px] select-none">
      <div className={cn(card, "top-[13.5%] left-0 h-[65%] w-[48.2%] -rotate-8 shadow-xl")}>
        <img src={img("hero-left")} alt="" className="size-full object-cover" />
      </div>
      <div className={cn(card, "top-[11.2%] right-0 h-[65%] w-[48.2%] rotate-7 shadow-xl")}>
        <img src={img("hero-right")} alt="" className="size-full object-cover" />
      </div>
      <PeelTile
        front={img("stripe-home")}
        back={img("hero-revealed")}
        className="absolute top-[19.2%] left-[22.3%] h-[74.6%] w-[55.4%] -rotate-1 rounded-xl bg-card shadow-2xl ring-1 ring-black/10 [--peel:14.3cqw] hover:[--peel:24cqw]"
      />
      {pages >= 1 && <div className={cn(note, "top-[16.2%] left-[19.8%] -rotate-5")}>Home</div>}
      {pages >= 3 && <div className={cn(note, "right-[17.5%] bottom-[3.5%] rotate-4")}>Pricing</div>}
      <div className="absolute -top-12 left-1/2 flex md:top-[3.5%] w-[min(440px,92%)] -translate-x-1/2 flex-col gap-1.5 rounded-2xl bg-card p-1.5 shadow-[0_0_0_1px_var(--border),0_12px_32px_-8px_rgb(0_0_0/0.25)]">
        <div className="flex h-10 items-center gap-2 rounded-xl bg-fill-1 pr-1 pl-3">
          <Link2 className="size-3.5 text-muted-foreground" />
          <span className="flex-1 text-sm font-medium">
            {typed}
            {typing && <span className="ml-px inline-block h-4 w-px translate-y-0.5 animate-pulse bg-foreground" />}
          </span>
          <span className="flex h-8 items-center rounded-lg bg-foreground px-3 text-2xs font-medium text-background">Crawl site</span>
        </div>
        <div className="flex items-center gap-2 px-2 pb-1">
          <span className="size-1.5 rounded-full bg-primary" />
          <span className="text-2xs text-muted-foreground tabular-nums">{status}</span>
          <span className="flex h-1 flex-1 overflow-clip rounded-full bg-fill-3">
            <span className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${(pages / DEMO_PAGES) * 100}%` }} />
          </span>
        </div>
      </div>
    </div>
  )
}

const sectionPad = "px-4 py-16 md:px-12 md:py-24 lg:px-24"
const label = "text-xs font-medium text-muted-foreground"
const h2 = "text-[32px] leading-[1.1] font-medium tracking-[-0.025em] text-balance md:text-5xl"

function CaptureSection() {
  const tiles = [
    { name: "linear", label: "linear.app/pricing" },
    { name: "vercel", label: "vercel.com/pricing" },
    { name: "rauno", label: "rauno.me/craft" },
    { name: "anchor", label: "anchor.com/developers" },
  ]
  return (
    <section id="capture" className={cn(sectionPad, "flex scroll-mt-20 flex-col gap-12 lg:flex-row lg:items-center lg:gap-20")}>
      <div className="reveal flex w-full shrink-0 flex-col gap-5 lg:w-[460px]">
        <p className={label}>Capture</p>
        <h2 className={h2}>Every page, not just the homepage</h2>
        <p className="leading-[1.6] text-muted-foreground">
          Choose a static page or crawl the whole site. A capture agent on your machine records each page it finds, at desktop and mobile width.
        </p>
        <dl className="mt-2 flex flex-col">
          {[
            ["Desktop", "1440 px, full page"],
            ["Mobile", "390 px, full page"],
            ["HTML snapshot", "CSS and fonts inlined, scripts stripped"],
          ].map(([k, v], i) => (
            <div key={k} className={cn("flex items-center justify-between gap-4 py-3.5 text-sm", i < 2 && "border-t")}>
              <dt className="font-medium">{k}</dt>
              <dd className="text-right text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="grid flex-1 grid-cols-1 gap-5 sm:grid-cols-2">
        {tiles.map((t) => (
          <PeelTile
            key={t.name}
            front={img(`${t.name}-front`)}
            back={img(`${t.name}-back`)}
            className="reveal aspect-[1.6] rounded-lg bg-fill-1 ring-1 ring-black/5 hover:[--peel:132px]"
          >
            <span className="absolute bottom-2 left-2 flex h-7 items-center rounded-full bg-background px-2.5 text-2xs font-medium shadow-sm ring-1 ring-black/5">
              {t.label}
            </span>
          </PeelTile>
        ))}
      </div>
    </section>
  )
}

function TokensSection() {
  const swatches = ["#635BFF", "#0A2540", "#425466", "#00D4FF", "#F6F9FC"]
  const types = [
    { name: "Display", spec: "56 / 60 · 500", cls: "text-[32px] leading-[1.1] tracking-[-0.025em] font-medium" },
    { name: "Heading", spec: "32 / 40 · 500", cls: "text-[22px] tracking-[-0.025em] font-medium" },
    { name: "Body copy", spec: "18 / 28 · 400", cls: "text-base" },
  ]
  return (
    <section id="styles" className={cn(sectionPad, "flex scroll-mt-20 flex-col-reverse gap-12 bg-fill-1 lg:flex-row lg:items-center lg:gap-20")}>
      <div className="reveal flex w-full shrink-0 flex-col gap-6 rounded-3xl bg-card p-7 shadow-md ring-1 ring-border lg:w-[640px]">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">Design tokens</p>
            <p className="text-xs text-muted-foreground">stripe.com</p>
          </div>
          <span className="flex h-7 items-center rounded-full bg-fill-2 px-3 text-2xs font-medium">Computed styles</span>
        </div>
        <div className="flex flex-col gap-2.5">
          <p className="text-2xs font-medium text-muted-foreground">Colors</p>
          <div className="flex gap-2.5">
            {swatches.map((hex) => (
              <div key={hex} className="flex min-w-0 flex-1 flex-col gap-1.5">
                {/* Sample data: the captured site's own colors, not app tokens. */}
                <div className="h-16 rounded-lg ring-1 ring-black/10 ring-inset" style={{ backgroundColor: hex }} />
                <span className="truncate text-2xs text-muted-foreground">{hex}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col">
          <p className="pb-2 text-2xs font-medium text-muted-foreground">Type scale</p>
          {types.map((t, i) => (
            <div key={t.name} className={cn("flex items-baseline justify-between py-2.5", i < 2 && "border-t")}>
              <span className={t.cls}>{t.name}</span>
              <span className="text-2xs text-muted-foreground">{t.spec}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-2xs font-medium text-muted-foreground">Radii</span>
          {["rounded-sm", "rounded-lg", "rounded-2xl"].map((r) => (
            <span key={r} className={cn("size-8 bg-fill-1 ring-1 ring-border", r)} />
          ))}
          <span className="pl-4 text-2xs font-medium text-muted-foreground">Shadow</span>
          <span className="h-8 w-12 rounded-lg bg-card shadow-lg" />
        </div>
      </div>
      <div className="reveal flex flex-1 flex-col gap-5">
        <p className={label}>Styles</p>
        <h2 className={h2}>Styles read from the page itself</h2>
        <p className="max-w-[460px] leading-[1.6] text-muted-foreground">
          Snip records computed styles for every element, plus hover rules and CSS variables, then boils them down to the colors, fonts, spacing, radii and shadows a
          site really uses.
        </p>
      </div>
    </section>
  )
}

function MotionSection() {
  return (
    <section id="agents" className={cn(sectionPad, "flex scroll-mt-20 flex-col items-center gap-12")}>
      <div className="reveal flex flex-col items-center gap-4 text-center">
        <p className={label}>Motion and agents</p>
        <h2 className={h2}>Watch it move. Ask your agent.</h2>
        <a href="/guide" className="mt-1 inline-flex h-10 items-center gap-2 rounded-full pr-4 pl-[18px] text-sm font-medium ring-1 ring-border transition-colors hover:bg-fill-1">
          Read the setup and privacy guide
          <ArrowRight className="size-3.5 text-muted-foreground" />
        </a>
      </div>
      <div className="flex w-full flex-col gap-6 lg:flex-row">
        <div className="reveal flex flex-col gap-6 rounded-4xl bg-fill-1 p-6 ring-1 ring-border md:p-8 lg:flex-[7_1_0%]">
          <div className="flex flex-col gap-2">
            <h3 className="text-[22px] font-medium tracking-[-0.025em]">Scroll and hover, as GIFs</h3>
            <p className="max-w-[420px] text-[15px] leading-[1.6] text-muted-foreground">
              Each page gets a smooth scroll recording at 30 fps. Elements with hover effects get their own short loop.
            </p>
          </div>
          <div className="mt-auto grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="relative aspect-[5/4] overflow-clip rounded-lg bg-card shadow-md ring-1 ring-black/10">
              {/* Two captured pages stacked; the strip scrolls from its top edge to its bottom edge and back. */}
              <div className="landing-scroll absolute inset-x-0 top-0 flex flex-col">
                <img src={img("stripe-home")} alt="" loading="lazy" className="w-full" />
                <img src={img("stripe-pricing")} alt="" loading="lazy" className="w-full" />
              </div>
              <MotionChip>Scroll · stripe.com</MotionChip>
            </div>
            <div className="relative aspect-[5/4] overflow-clip rounded-lg bg-card shadow-md ring-1 ring-black/10">
              {/* Zooms into the "Start accepting payments" button, standing in for a hover loop. */}
              <img
                src={img("stripe-pricing")}
                alt=""
                loading="lazy"
                className="landing-hover absolute inset-0 size-full origin-[22%_72%] object-cover object-left-top"
              />
              <MotionChip>Hover · stripe.com</MotionChip>
            </div>
          </div>
        </div>
        <div className="reveal flex flex-col gap-6 rounded-4xl bg-foreground p-6 text-background md:p-8 lg:flex-[5_1_0%]">
          <div className="flex flex-col gap-2">
            <h3 className="text-[22px] font-medium tracking-[-0.025em]">Connect an agent</h3>
            <p className="text-[15px] leading-[1.6] text-background/70">A remote MCP server lets your agent search, read and add references.</p>
          </div>
          <div className="flex flex-col gap-1.5 overflow-x-auto rounded-xl bg-background/10 p-4">
            <span className="text-2xs text-background/60">Terminal</span>
            <code className="font-mono text-xs whitespace-nowrap">claude mcp add --transport http snip</code>
            <code className="font-mono text-xs whitespace-nowrap text-background/70">https://snip.your-name.workers.dev/mcp</code>
          </div>
          <div className="flex flex-col gap-1.5 rounded-xl bg-background p-4 text-foreground">
            <span className="text-2xs text-muted-foreground">Ask</span>
            <p className="text-sm">Which saved pricing pages use a monthly and yearly toggle?</p>
          </div>
          <div className="reveal flex flex-col gap-3 rounded-xl bg-background/10 p-4">
            <span className="text-2xs text-background/60">Snip · 3 matches</span>
            <ul className="flex flex-col gap-2">
              {["linear.app/pricing", "vercel.com/pricing", "stripe.com/pricing"].map((u) => (
                <li key={u} className="flex items-center gap-2 text-sm">
                  <Check className="size-3.5 text-background/70" />
                  {u}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}

function MotionChip({ children }: { children: ReactNode }) {
  return (
    <span className="absolute bottom-2 left-2 flex h-7 items-center gap-1.5 rounded-full bg-background px-2.5 text-2xs font-medium shadow-sm ring-1 ring-black/5">
      <span className="size-1.5 animate-pulse rounded-full bg-primary" />
      {children}
    </span>
  )
}

function HowSection() {
  const steps = [
    ["Paste a URL", "Choose Static page or Crawl site. The job goes into your queue."],
    ["Your machine captures it", "A local capture agent runs Chromium, records every page, then uploads the files to your library."],
    ["Browse, organize, ask", "Search the gallery, group references into collections, or query them from an agent."],
  ]
  return (
    <section id="how-it-works" className={cn(sectionPad, "flex scroll-mt-20 flex-col gap-12 bg-fill-1")}>
      <div className="reveal flex flex-col gap-4">
        <p className={label}>How it works</p>
        <h2 className={h2}>Three steps, one of them yours</h2>
      </div>
      <ol className="grid grid-cols-1 gap-10 md:grid-cols-3 md:gap-12">
        {steps.map(([title, body], i) => (
          <li key={title} className="reveal flex flex-col gap-3 border-t border-foreground pt-5">
            <span className="text-xs font-medium text-muted-foreground">0{i + 1}</span>
            <h3 className="text-[22px] font-medium tracking-[-0.025em]">{title}</h3>
            <p className="max-w-[360px] text-[15px] leading-[1.6] text-muted-foreground">{body}</p>
          </li>
        ))}
      </ol>
      <p className="max-w-[640px] text-sm leading-[1.6] text-muted-foreground">
        Capture runs locally because free hosting plans can’t crawl whole sites. Queued references wait until the agent is running.
      </p>
    </section>
  )
}

const faqs: { q: string; a: ReactNode }[] = [
  {
    q: "Does anyone else see the sites I capture?",
    a: "No. Snip runs on your own Cloudflare account and the capture agent browses from your machine, so no shared server ever sees your list. It’s fully private. You can also run everything locally, where capture speed depends on your hardware.",
  },
  {
    q: "Is this legal?",
    a: "We believe so. Snip is built for personal use: keeping screenshots and references for you and your agent while you design, not for republishing other people’s sites. Laws differ by country and use, so check what applies to you.",
  },
  {
    q: "Can I hand the setup to my AI agent?",
    a: (
      <>
        Yes.{" "}
        <a href="/llms.txt" className="font-medium text-foreground underline-offset-4 hover:underline">
          Point your agent at our llms.txt
        </a>{" "}
        and it can configure everything for you. Once deployed, connect it to your library through the MCP endpoint.
      </>
    ),
  },
  {
    q: "Does it cost anything?",
    a: "It fits in Cloudflare’s free plan. R2 gives you 10 GB of storage, roughly 1,500 to 3,000 captured pages depending on page length and GIFs.",
  },
  {
    q: "Does my laptop need to stay on?",
    a: "Only while capturing. Queued URLs wait until the agent is running, and the gallery stays available from any browser in the meantime.",
  },
  {
    q: "Can it capture pages behind a login?",
    a: "No. Captures show what an anonymous browser sees. Cookie banners with an obvious Accept button are dismissed automatically.",
  },
]

function FaqSection() {
  return (
    <section id="faq" className={cn(sectionPad, "flex scroll-mt-20 flex-col gap-10 lg:flex-row lg:items-start lg:gap-16")}>
      <div className="reveal flex w-full shrink-0 flex-col gap-4 lg:w-[360px]">
        <p className={label}>FAQ</p>
        <h2 className={h2}>Before you set it up</h2>
        <p className="text-[15px] leading-[1.6] text-muted-foreground">The short answers. The guide has the details.</p>
        <a href="/guide" className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium hover:underline hover:underline-offset-4">
          Setup and privacy guide
          <ArrowRight className="size-3.5" />
        </a>
      </div>
      <dl className="flex flex-1 flex-col border-b">
        {faqs.map((f) => (
          <div key={f.q} className="reveal flex flex-col gap-2.5 border-t py-6">
            <dt className="text-lg leading-[1.4] font-medium tracking-[-0.01em]">{f.q}</dt>
            <dd className="max-w-[640px] text-[15px] leading-[1.6] text-muted-foreground">{f.a}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function FinalCta() {
  const side = "absolute hidden h-[188px] w-[300px] overflow-clip rounded-lg shadow-xl ring-1 ring-black/10 lg:block"
  return (
    <section className="relative flex flex-col items-center gap-6 overflow-clip px-4 py-[120px] text-center md:px-24">
      <div className={cn(side, "top-24 left-[120px] -rotate-8")}>
        <img src={img("hero-left")} alt="" loading="lazy" className="size-full object-cover" />
      </div>
      <div className={cn(side, "top-[120px] right-[120px] rotate-7")}>
        <img src={img("hero-right")} alt="" loading="lazy" className="size-full object-cover" />
      </div>
      <h2 className="reveal text-[40px] leading-[1.05] font-medium tracking-[-0.05em] md:text-[56px]">Start your shelf</h2>
      <p className="max-w-[460px] text-[17px] leading-[1.55] text-muted-foreground">
        {PUBLIC_SITE
          ? "Deploy your own copy on Cloudflare’s free plan, paste your first URL, and let the agent do the rest."
          : "Sign in with GitHub, paste your first URL, and let the agent do the rest."}
      </p>
      <a href={primaryHref()} className={cn(pill, "bg-foreground text-background hover:bg-foreground/90")}>
        {primaryLabel}
      </a>
      <p className="text-xs text-muted-foreground">
        {PUBLIC_SITE ? "Free and self-hosted. Your library lives in your own Cloudflare account." : "Private. Only GitHub logins you allow can sign in."}
      </p>
    </section>
  )
}

export function Footer() {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-4 border-t px-4 py-8 md:px-12 lg:px-24">
      <a href="/" className="flex items-center gap-2">
        <Logo className="size-7" />
        <span className="text-sm font-semibold tracking-[-0.025em]">Snip</span>
      </a>
      <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <a href="/guide" className="transition-colors hover:text-foreground">Setup guide</a>
        <a href="/llms.txt" className="font-mono transition-colors hover:text-foreground">llms.txt</a>
        {PUBLIC_SITE && <a href={REPO_URL} className="transition-colors hover:text-foreground">GitHub</a>}
        <span>Runs on Cloudflare Workers, D1 and R2.</span>
      </nav>
    </footer>
  )
}
