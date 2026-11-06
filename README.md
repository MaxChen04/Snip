![Snip: snip the web, keep the good bits](docs/media/banner.png)

# Snip

A private library of website design references. Paste a URL, choose **Single page** or **Crawl site**, and a capture agent on your machine records every page. Your agent reads them back over MCP.

![Browsing a collection, opening a captured site and a page in Snip](docs/media/browse.gif)

Website: [usesnip.dev](https://usesnip.dev) · Latest release: [v0.1.0](https://github.com/MaxChen04/Snip/releases/tag/v0.1.0) (source only; Snip is self-hosted) · License: [source-available](#license)

## Quick start

You need **Node 22.18+**, a free **Cloudflare** account and a **GitHub** account. The capture agent runs wherever Node and Playwright do (tested on macOS and Linux).

```bash
git clone https://github.com/MaxChen04/Snip && cd Snip
npm install
npm run setup:cloudflare   # creates the database and storage, deploys, sets secrets
npm run capture            # keep it running: it does the captures
```

Open the URL the setup prints and sign in with GitHub. If something's off, `npm run doctor` says what and how to fix it. [Deploying to Cloudflare](docs/deploy.md) explains each step, how to do it by hand and how to upgrade.

Prefer to try it on your laptop first? See [Local development](#local-development). On an Apple Silicon Mac you can also build [Snip.app](docs/mac-app.md), a menu-bar app that runs everything locally.

## What it captures

- Desktop (1440px, or 1280/1920) and mobile (390px) full-page screenshots, in light or dark mode
- **Computed styles** per element (only values that differ from browser defaults, plus `::before`/`::after`), keyframes, `:hover` rules and CSS variables
- A **self-contained HTML snapshot**: linked and cross-origin CSS inlined, CSS-in-JS / CSSOM rules materialized, web fonts embedded, scripts stripped
- **Scroll GIFs** per page and **hover GIFs** for elements with hover effects
- Extracted **design tokens**: colors, fonts, type scale, spacing, radii, shadows, transitions

Pages behind a login can be captured with a saved sign-in (`STORAGE_STATE`, see [capture options](#capture-agent-options-captureenv)).

## Using it

The app is an infinite gallery (Websites / Pages / Animations) with search and sort.

- **Add** from the Create menu, by pasting a URL anywhere in the app, or with the **bookmarklet** (account menu). Paste several URLs to add them all at once. Snip tells you when a URL is already saved.
- **Notes**: say why you saved something. Notes are searchable and your agent sees them.
- **Collections**: save whole websites or **individual pages**.
- **Page viewer**: a resizable sidebar with **Tokens**, **HTML** and **CSS** tabs, desktop and mobile.
- **Select** pages, animations and tokens, then **Copy prompt** to hand exactly those to an agent.
- **Export** a website as a .zip (screenshots, HTML, styles, GIFs, tokens) from its **More** menu.
- **Connect MCP** in the top bar shows copy-ready setup for Claude, Codex, OpenCode, Cursor and other clients.
- Press <kbd>/</kbd> to search. A banner tells you when captures are waiting on an offline capture agent, and the account menu shows how much of R2's free 10 GB you've used.

**Page viewer.** Drag the sidebar to resize it, switch between Tokens, HTML and CSS, and flip between desktop and mobile captures.

![Page viewer with resizable Tokens, HTML and CSS sidebar](docs/media/viewer.gif)

**Design tokens.** Every website gets its colors, type, spacing, radii and shadows extracted.

![Design tokens for a captured website](docs/media/tokens.png)

**Select and Copy prompt.** Pick pages, animations and tokens, then copy a prompt that points your agent at exactly those references over MCP.

![Selecting pages and copying an agent prompt](docs/media/select.gif)

**Animations.** Scroll and hover GIFs from every capture, in one feed.

![Animations gallery](docs/media/animations.gif)

## How it works

```
┌──────────── Cloudflare (free plan) ─────────────┐        ┌──── Your machine ────┐
│ Worker: React gallery + API + /mcp (OAuth)      │◀─poll──│ capture agent        │
│ D1: references, pages, animations, collections  │──job──▶│ (Playwright/Chromium)│
│ R2: screenshots, GIFs, HTML snapshots, styles   │◀upload─│                      │
│ KV: OAuth tokens                                │        └──────────────────────┘
└─────────────────────────────────────────────────┘
```

Capture runs locally because the free plans can't crawl sites: Cloudflare's free Browser Rendering allows 10 browser-minutes a day, and Vercel Hobby functions stop after 5 minutes. Queued references wait until the agent is running.

Only the GitHub logins in `ALLOWED_GITHUB_LOGINS` can sign in. See [SECURITY.md](SECURITY.md) for the full trust model.

## Connect your agent (remote MCP)

The MCP endpoint is `https://snip.<your-subdomain>.workers.dev/mcp`. Clients register themselves, send you through GitHub login, and show a consent screen.

```bash
claude mcp add --transport http snip https://snip.<your-subdomain>.workers.dev/mcp
```

Codex (the CLI, IDE extension and Codex desktop app share `~/.codex/config.toml`):

```bash
codex mcp add snip --url https://snip.<your-subdomain>.workers.dev/mcp
codex mcp login snip
```

OpenCode (`~/.config/opencode/opencode.json` or a project `opencode.json`; note the `mcp` key and `type: "remote"`), then `opencode mcp auth snip`:

```json
{ "mcp": { "snip": { "type": "remote", "url": "https://snip.<your-subdomain>.workers.dev/mcp" } } }
```

For Claude.ai or Claude Desktop, add it as a custom connector with the same URL.

<img src="docs/media/connect-mcp.png" alt="Connect MCP dialog" width="420">

The **Connect MCP** button in the app's top bar shows these steps with your own URL filled in. In the local app or Snip.app the URL is `http://localhost:5173/mcp`, which only agents on the same Mac can reach while Snip is running; cloud agents such as Claude.ai need your deployed URL.

| Tool | What it does |
| --- | --- |
| `search_references` | Search by text (title, URL or notes), collection or domain; returns summaries with ids |
| `get_reference` | One reference in bounded parts: `overview`, `pages`, `animations`, `tokens` (optionally one `token_group`, paginated). `full` is the legacy everything-at-once read |
| `get_page` | One page: signed screenshot URLs with coverage, a token summary, an inline viewport screenshot and optional HTML in chunks |
| `get_page_styles` | Valid, bounded computed styles: summary, filtered elements, keyframes, hover rules, font faces, CSS variables |
| `get_animation` | One animation: a manifest (timing provenance, sampled frames, the element's observed styles) plus a contact sheet, a single frame or the GIF |
| `search_pages` | Pages across all references; with a collection, its saved pages and the pages of its websites |
| `search_animations` | Scroll and hover animations across all references |
| `get_capture_status` | Job state, last progress and when the capture worker last checked in, with a suggested poll delay |
| `list_collections` | Collections with website and page counts |
| `add_reference` | Queue a URL (`single` or `crawl`) for capture, with optional notes and color scheme. A URL that's already saved returns the saved reference unless `allow_duplicate` |
| `set_reference_notes` | Replace a website's note (why it was saved) |
| `create_collection` | New collection |
| `set_collection_membership` | Add or remove a whole website from a collection |
| `set_page_collection_membership` | Add or remove individual pages from a collection |

Every result carries the same JSON as text and as `structuredContent`. Bounded lists are capped by item count and bytes and say what they left out and how to continue; the legacy full reference read can be larger. Many models only see the first frame of a GIF, so new captures also store sampled frames and a contact sheet per animation (animations captured earlier only have the GIF until you recapture).

File URLs returned by the MCP are signed and expire after 24 hours.

`get_page(include_styles: true)` now returns guidance to `get_page_styles` instead of a truncated JSON fragment. Update client prompts to use the new tool for styles. Existing `get_reference` calls without `part` still return the full legacy result, and old animations still offer their GIFs.

## Capture agent options (`capture/.env`)

| Variable | Default | |
| --- | --- | --- |
| `SNIP_URL` | | Worker URL |
| `CAPTURE_TOKEN` | | Must match the Worker secret |
| `CHROMIUM_PATH` | Playwright's Chromium | Use your installed Chrome instead |
| `POLL_SECONDS` | `5` | Queue poll interval |
| `HEADLESS` | `true` | `false` to watch the browser |
| `DISMISS_POPUPS` | `true` | `false` keeps cookie banners and popups in captures |
| `SCROLL_FPS` | `30` | Scroll GIF frames per second (5–50) |
| `SCROLL_STEP` | `40` | Pixels scrolled per scroll GIF frame (min 8) |
| `SCROLL_MAX_FRAMES` | `360` | Frame cap per scroll GIF; long pages take bigger steps |
| `SHEET_FRAMES` | `9` | Frames sampled per animation for its contact sheet (2–16) |
| `SHEET_WIDTH` | `1536` | Max contact sheet width in px |
| `BROWSER_IDLE_SECONDS` | `120` | Seconds Chromium stays open after the last capture |
| `ALLOW_PRIVATE_URLS` | `false` | `true` lets the agent capture localhost and private-network sites (your own dev servers). Off so an agent connected over MCP can't make your machine capture internal pages |
| `STORAGE_STATE` | | Path to a Playwright sign-in file, used by captures with "Use my saved sign-in". Create one with `npx playwright open --save-storage=auth.json https://example.com` |

`npm run once -w capture` drains the queue and exits.

## Local development

```bash
npm install
cp web/.dev.vars.example web/.dev.vars          # set SESSION_SECRET and CAPTURE_TOKEN (openssl rand -hex 32)
npm run db:migrate:local -w web
npm run dev                                       # http://localhost:5173

# second terminal
cp capture/.env.example capture/.env              # SNIP_URL=http://localhost:5173, CAPTURE_TOKEN from .dev.vars
npm run capture
npm run doctor                                    # checks the setup
```

`DEV_LOGIN` in `web/.dev.vars` skips GitHub sign-in on localhost only. Never set it on a deployed Worker.

## Updating

When new changes land on `main`, one command brings a local copy (and Snip.app) up to date. For a deployed Worker, see [Upgrading](docs/deploy.md#upgrading).

```bash
npm run update
```

It quits Snip.app gracefully (active captures finish first), fast-forwards `main`, runs `npm ci` when dependencies changed, installs the capture browser, backs up and migrates the local database, rebuilds the web app, rebuilds Snip.app when `desktop/` changed, and reopens the app. It never touches untracked files such as `.env` files, `web/wrangler.deploy.jsonc`, `web/wrangler.local.jsonc` or your library. npm lockfile churn is reset automatically; any other local edit, or a terminal `npm run dev` or `npm run capture` still using the database, stops the update before anything changes (`npm run update -- --stash` sets edits aside instead). If a step fails, fix the error and run `npm run update` again to finish. `--full` reruns every step even when you're already up to date.

To run it from any folder, add an alias to `~/.zshrc`:

```bash
alias snip-update='npm --prefix /path/to/Snip run update'
```

Snip.app also checks GitHub hourly (and after sleep). When `main` has new commits it shows a notification and an **Update Snip (N new)** menu item; **Update now** opens Terminal and runs the same command. Checks follow your checkout's `origin` remote, so forks update from their own `main`.

## Checks

The same checks CI runs:

```bash
npm run typecheck
npm run build -w web
npx playwright install chromium # needed by the network regression tests
npm test               # web, capture (including MCP response budgets) and desktop unit tests
```

`npm run test:desktop` runs the Mac app smoke test.

## Stack

- `web/`: Vite + React 19 + Tailwind v4, **shadcn/ui** with the **SortUI** registry (`src/components/ui`, restyled with tactile surfaces), **Hugeicons**, Hono on Cloudflare Workers, D1, R2, `@cloudflare/workers-oauth-provider`, MCP via `@modelcontextprotocol/server`.
- `capture/`: Node 22+ + Playwright, `gifenc` for GIF encoding.
- `desktop/`: Electron menu-bar app for Apple Silicon Macs ([Snip.app](docs/mac-app.md)).
- `web/site/`: the static [public site](docs/public-site.md) on usesnip.dev.

## Known limits

- Full-page screenshots are capped at 16,000px tall (Chromium's texture limit).
- Crawls stay on the same hostname (with or without `www.`) and ignore query strings.
- Sites behind bot walls capture whatever the browser is shown. Cookie banners with an obvious "Accept" button are dismissed.
- Hover GIFs pick up to 6 elements per page from `:hover` rules and transitions; shared nav/footer effects are recorded once per site.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md); first-time contributors sign a short [CLA](CLA.md) by commenting on their PR. Report security issues privately ([SECURITY.md](SECURITY.md)).

## License

Snip is source-available under the [Apache License 2.0 with the Commons Clause](LICENSE). You can use, self-host, modify and fork it for free, including at work. You can't sell it: no paid product, hosted service or paid support whose value comes mainly from Snip. Third-party material keeps its own license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
