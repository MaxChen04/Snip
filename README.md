![Snip: snip the web, keep the good bits](docs/media/banner.png)

# Snip

A private library of website design references. Paste a URL, choose **Single page** or **Crawl site**, and a capture agent on your machine records every page. Your agent reads them back over MCP.

![Browsing a collection, opening a captured site and a page in Snip](docs/media/browse.gif)

Website: [usesnip.dev](https://usesnip.dev) · Latest release: [v0.1.0](https://github.com/MaxChen04/Snip/releases/tag/v0.1.0) (source only) · License: [source-available](#license)

## Quick start

Snip runs on your machine. The gallery, the API and the capture agent all run from this checkout, and every capture is stored in its library folder. There is no account to create, no server to run and nothing to upload.

You need **Node 22.18+**; the capture agent runs wherever Node and Playwright do (tested on macOS and Linux). Snip.app needs an **Apple Silicon Mac on macOS 14 or later**.

```bash
git clone https://github.com/MaxChen04/Snip && cd Snip
npm install
cp web/.dev.vars.example web/.dev.vars   # set SESSION_SECRET and CAPTURE_TOKEN, each from openssl rand -hex 32
npm run db:migrate:local -w web
cp capture/.env.example capture/.env      # SNIP_URL stays http://localhost:5173; paste the same CAPTURE_TOKEN
npm run app                              # builds Snip.app and installs it in /Applications
```

Open **Snip** from Applications or the menu bar. Paste a URL, pick **Single page** or **Crawl site**, and the capture agent starts working. `npm run doctor` checks both config files if something looks off.

Prefer a terminal and hot reload? Run `npm run dev`, then `npm run capture` in a second terminal, and open http://localhost:5173.

## Use Snip on your other devices (cloud mode)

Optional. Everything above works without this. To read the library from another Mac or a browser, or to let a cloud agent such as Claude.ai reach it, deploy the same Snip to your own Cloudflare account:

```bash
npm run setup:cloudflare
```

The setup signs you in to Cloudflare, creates the database, key-value store and storage bucket, deploys, and prints your URL. When it asks, create a GitHub OAuth app with the two URLs it prints and paste its Client ID and secret. Sign in at the printed URL with an allowed GitHub login.

Today this creates a **separate** library: your local references are not copied into it, and the in-app **Enable cloud** button that will copy them is not released yet. [Cloud mode](docs/deploy.md) covers what it creates, R2 activation, upgrading and how to do it by hand.

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
- Press <kbd>/</kbd> to search. A banner tells you when captures are waiting on an offline capture agent, and the account menu shows how much storage your captures use: bytes on disk in the local app, and R2 usage against the 10 GB free tier in cloud mode.

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
┌──────────────────── your Mac ────────────────────┐
│ Snip.app                                         │
│   Worker: gallery, API and /mcp, run by Wrangler │
│   D1 · R2 · KV: files in the library folder      │
│   capture agent: Playwright + Chromium           │
└──────────────────────────────────────────────────┘
```

Snip is one Worker in two places. Locally, Snip.app runs it from this checkout through Wrangler, with D1, R2 and KV as files in the library folder; the capture agent browses with Chromium on the same machine.

Capture runs locally because the free plans can't crawl sites: Cloudflare's free Browser Rendering allows 10 browser-minutes a day, and Vercel Hobby functions stop after 5 minutes. Queued references wait until the agent is running.

Cloud mode deploys the same Worker to your own Cloudflare account, with D1, R2 and KV in that account, so other devices and cloud agents can reach it. Capture still runs on a Mac: the agent follows `SNIP_URL`, so point it at the hosted copy or leave it local. See [SECURITY.md](SECURITY.md) for the full trust model.

## Connect your agent (MCP)

The MCP endpoint is `http://localhost:5173/mcp` when Snip runs on your Mac, and `https://snip.<your-subdomain>.workers.dev/mcp` in cloud mode. Locally, only agents on the same Mac can reach it while Snip is running; cloud clients such as Claude.ai need the deployed URL. Clients register themselves, ask for your approval, and show a consent screen.

```bash
claude mcp add --transport http snip http://localhost:5173/mcp
```

Codex (the CLI, IDE extension and Codex desktop app share `~/.codex/config.toml`):

```bash
codex mcp add snip --url http://localhost:5173/mcp
codex mcp login snip
```

OpenCode (`~/.config/opencode/opencode.json` or a project `opencode.json`; note the `mcp` key and `type: "remote"`), then `opencode mcp auth snip`:

```json
{ "mcp": { "snip": { "type": "remote", "url": "http://localhost:5173/mcp" } } }
```

For Claude.ai or Claude Desktop, add it as a custom connector with the same URL. In cloud mode, use your deployed URL in every command and connector above.

<img src="docs/media/connect-mcp.png" alt="Connect MCP dialog" width="420">

The **Connect MCP** button in the app's top bar shows these steps with your own URL filled in.

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
| `SNIP_URL` | `http://localhost:5173` | Your local app. Set your Worker URL in cloud mode |
| `CAPTURE_TOKEN` | | Must match `web/.dev.vars` (or the Worker secret when hosted) |
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

## Running from source

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

`DEV_LOGIN` in `web/.dev.vars` replaces GitHub sign-in on localhost, so the app never asks you to log in while you work. It is the name you appear as. Never set it on a deployed Worker. [Snip.app](docs/mac-app.md) runs this same checkout as a menu-bar app.

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
