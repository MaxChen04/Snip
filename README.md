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
npm run app:dev:build                    # separate Snip Dev.app with its own test library
```

Snip Dev uses the blue blueprint icon and separate test data. Nightlies follow `main`; stable releases use `vX.Y.Z` tags. See [desktop release channels](desktop/RELEASING.md#stable-and-snip-dev-in-one-repository) for downloads, updates and Apple signing setup.

Open **Snip** from Applications or the menu bar. Paste a URL, pick **Single page** or **Crawl site**, and the capture agent starts working. `npm run doctor` checks the checkout, the two config files and the capture browser if something looks off; add `--check` to have it ask the cloud library whether it answers.

Prefer a terminal and hot reload? Run `npm run dev`, then `npm run capture` in a second terminal, and open http://localhost:5173.

## Use Snip on your other devices (cloud mode)

Optional. Everything above works without this. To read the library from another Mac or a browser, or to let a cloud agent such as Claude.ai reach it, copy the library into your own Cloudflare account.

In Snip.app, open **Settings → Cloud → Enable cloud**. The app says what will copy before anything leaves the Mac. Then Cloudflare asks for two things, one time:

1. **Sign in and Allow.** Your browser opens on Cloudflare. Pick the account that should own the library.
2. **Turn on R2** if it has never been used there. Cloudflare asks for a card once; storage is still free up to 10 GB. Snip waits while you do it.

Snip creates the Worker, database, key-value store and bucket, deploys, copies the library and checks the result. A one-time owner link then opens in your browser and signs Snip.app in. There are no IDs to copy and no secrets to paste.

After that, every other browser or device signs in at **/sign-in** with its passkey; **Passkeys and devices** in the account menu adds or removes them.

A browser with no passkey yet opens **Settings → Cloud → Sign in another browser** on the Mac that owns the library, which mints a one-time link to copy or open there. The link works once and expires in 10 minutes; the browser that opens it is signed in and can add its own passkey.

**One owner in this version.** The person who enabled cloud is the only person who can sign in, on their own devices. Sharing a library with a second person is planned for later, so there is no invitation, no allowlist and no second account to set up. Nothing in the setup asks for GitHub.

Capture stays on this Mac. A capture started from another device waits in the queue and shows **Waiting for the capture agent** until this Mac's capture agent checks in. The gallery card and every agent status use those exact words, whether the agent is busy or the Mac is asleep.

Already deployed Snip before this button existed? The setup recognises your own library. An empty one is adopted silently; one with references asks first and offers **Use that library** or **Stop**. Choosing to use it switches this Mac to the cloud library and leaves your local one on disk, listed as **This Mac's library** with a single **Switch back to it** action. The owner link signs in as the same owner; existing devices keep their passkeys. [Cloud mode](docs/deploy.md) covers the copy, the two approvals, adoption, the command-line path, turning cloud off and the free-tier limits.

### Command line and agents

The button and the command line run the same provisioning engine. Use the CLI for a scripted setup, or hand the job to an agent:

```bash
npm run setup:cloudflare -- --check --json   # preflight only; changes nothing
npm run setup:cloudflare -- --yes --json     # enable cloud, never prompt
```

Each line of output is a JSON event. A `human` event carries a URL that only a person can open (Cloudflare's allow page, the R2 page, the owner link); the run pauses there. A `choice` event is a decision with consequences and exits 2 until you pick, so `--yes` never adopts an existing library: pass `--adopt-existing` when that is what you mean. A `needs_input` event exits 2 and names the flags to add. Every failure reported after a run starts carries `retryable`, so a script can tell a failure worth repeating from a final one: a transient Cloudflare problem is retried four times first and then reported as `CLOUDFLARE_TEMPORARY`. Nothing prompts, and no secret is ever typed into a chat.

The bare `npm run setup:cloudflare` means `setup`. Add any other command after `--`:

```bash
npm run setup:cloudflare -- status --json          # mode, URL, snapshot, last error; offline
npm run setup:cloudflare -- status --check --json  # also ask the cloud library whether it answers
npm run setup:cloudflare -- detach --json
npm run setup:cloudflare -- pull --json
npm run setup:cloudflare -- snapshot delete --confirm <basename>
npm run setup:cloudflare -- snapshot delete-export --confirm <basename>
npm run setup:cloudflare -- owner link --no-handoff
npm run setup:cloudflare -- delete-resources --confirm snip.<your-subdomain>.workers.dev
```

`status` never calls the network; `--check` is the one form that does, and then it says which surface answered. `--confirm` is the basename of the item being deleted (for `delete-resources`, the cloud URL's host), and a missing or different value changes nothing. `owner link --no-handoff` prints a one-time link for another device instead of opening it here, which is what Settings' **Sign in another browser** runs.

### Turning cloud off

**Settings → Cloud → Turn off cloud** points this Mac back at its own local library, which stayed on disk the whole time. The cloud library is **not** deleted: it stays live at its address, and devices and agents signed in to it keep working. The dialog says that, and offers **Bring the cloud library back to this Mac** (or **Copy back now** later) to copy the cloud library down first.

**Delete cloud resources** is separate and destructive. **Sign out everywhere, including connected agents** ends every browser session, the app's session and every agent connected over MCP; all of them sign in or reconnect again. Passkeys stay registered.

### One Snip per account, workers.dev only

Snip keeps one library per Cloudflare account. An empty older Snip is adopted silently. One with references asks first: **Use that library** switches to it and leaves this Mac's library in place, listed as **This Mac's library** with **Switch back to it**, and **Stop** changes nothing. A Worker named `snip` that is not a Snip is refused, with instructions to rename or delete it or choose another account. There is no replace option and no second Worker name.

The address is always `https://snip.<your-subdomain>.workers.dev`. Custom domains are not supported in this release: the address is what the passkey and MCP connections are bound to.

**One owner, passkeys only.** You sign in with a passkey on each device you use, and so does an agent you connect to the cloud address. Sharing with a second person is planned for later, so v1 has no allowlist to maintain and no OAuth app to register.

Installs that were set up before this version and already have GitHub sign-in configured keep working: their secrets are left in place and their extra GitHub logins can still sign in. A new install never configures GitHub.

## What it captures

- Desktop (1440px, or 1280/1920) and mobile (390px) full-page screenshots, in light or dark mode
- **Computed styles** per element (only values that differ from browser defaults, plus `::before`/`::after`), keyframes, `:hover` rules and CSS variables
- A **self-contained HTML snapshot**: linked and cross-origin CSS inlined, CSS-in-JS / CSSOM rules materialized, web fonts embedded, scripts stripped
- **Scroll recordings** per page and **hover recordings** for elements with hover effects, as WebM video
- Extracted **design tokens**: colors, fonts, type scale, spacing, radii, shadows, transitions

Pages behind a login can be captured with a saved sign-in (`STORAGE_STATE`, see [capture options](#capture-agent-options-captureenv)).

## Using it

The app is an infinite gallery (Websites / Pages / Animations) with search and sort.

- **Add** from the Create menu, by pasting a URL anywhere in the app, or with the **bookmarklet** (account menu). Paste several URLs to add them all at once. Snip tells you when a URL is already saved.
- **Notes**: say why you saved something. Notes are searchable and your agent sees them.
- **Collections**: save whole websites or **individual pages**.
- **Page viewer**: a resizable sidebar with **Tokens**, **HTML** and **CSS** tabs, desktop and mobile.
- **Select** pages, animations and tokens, then **Copy prompt** to hand exactly those to an agent.
- **Export** a website as a .zip (screenshots, HTML, styles, recordings, tokens) from its **More** menu.
- **Connect MCP** in the top bar shows copy-ready setup for Claude, Codex, OpenCode, Cursor and other clients.
- Press <kbd>/</kbd> to search. A banner tells you when captures are waiting on an offline capture agent, and the account menu shows how much storage your captures use: bytes on disk in the local app, and R2 usage against the 10 GB free tier in cloud mode.
- In cloud mode a capture started elsewhere shows **Waiting for the capture agent** until this Mac's capture agent picks it up.

**Page viewer.** Drag the sidebar to resize it, switch between Tokens, HTML and CSS, and flip between desktop and mobile captures.

![Page viewer with resizable Tokens, HTML and CSS sidebar](docs/media/viewer.gif)

**Design tokens.** Every website gets its colors, type, spacing, radii and shadows extracted.

![Design tokens for a captured website](docs/media/tokens.png)

**Select and Copy prompt.** Pick pages, animations and tokens, then copy a prompt that points your agent at exactly those references over MCP.

![Selecting pages and copying an agent prompt](docs/media/select.gif)

**Animations.** Scroll and hover recordings from every capture, in one feed.

![Animations gallery](docs/media/animations.gif)

## How it works

```
┌───────────────── your Mac ─────────────────┐
│ Snip.app: gallery, API and /mcp            │
│ D1 · R2 · KV: files in the library folder  │
│ capture agent: Playwright + Chromium       │
└────────────────────────────────────────────┘
        │  optional: Settings → Cloud → Enable cloud
        ▼
┌───────── your Cloudflare account ──────────┐
│ the same Worker, app and library           │
│ D1 · R2 · KV in your account               │
│ capture still runs on your Mac             │
└────────────────────────────────────────────┘
```

Snip is one Worker in two places. Locally, Snip.app runs it from this checkout through Wrangler, with D1, R2 and KV as files in the library folder; the capture agent browses with Chromium on the same machine.

Capture runs locally because the free plans can't crawl sites: Cloudflare's free Browser Rendering allows 10 browser-minutes a day, and Vercel Hobby functions stop after 5 minutes. Queued references wait until the agent is running.

Cloud mode deploys the same Worker to your own Cloudflare account and copies the library into it, so other devices and cloud agents can reach it. Capture still runs on a Mac: the app points its capture agent at the cloud library after the move, and captures queued while the Mac is off show **Waiting for your Mac**. See [SECURITY.md](SECURITY.md) for the full trust model.

## Connect your agent (MCP)

The MCP endpoint is `http://localhost:5173/mcp` when Snip runs on your Mac, and `https://snip.<your-subdomain>.workers.dev/mcp` in cloud mode. Locally, only agents on the same Mac can reach it while Snip is running. A cloud client such as Claude.ai needs the deployed URL, then signs in with your passkey and asks for your approval; locally there is no sign-in, just a consent screen.

```bash
claude mcp add --scope user --transport http snip http://localhost:5173/mcp
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

For Claude.ai or Claude Desktop, add it as a custom connector with the same URL. In cloud mode, use your deployed URL in every command and connector above; the client signs in with your passkey when it connects.

<img src="docs/media/connect-mcp.png" alt="Connect MCP dialog" width="420">

The **Connect MCP** button in the app's top bar shows these steps with your own URL filled in.

| Tool | What it does |
| --- | --- |
| `search_references` | Search by text (title, URL or notes), collection or domain; returns summaries with ids |
| `get_reference` | One reference in bounded parts: `overview`, `pages`, `animations`, `tokens` (optionally one `token_group`, paginated). `full` is the legacy everything-at-once read |
| `get_page` | One page: signed screenshot URLs with coverage, a token summary, an inline viewport screenshot and optional HTML in chunks |
| `get_page_styles` | Valid, bounded computed styles: summary, filtered elements, keyframes, hover rules, font faces, CSS variables |
| `get_animation` | One animation: a manifest (timing provenance, sampled frames, the element's observed styles) plus a contact sheet or a single frame, and a link to the recording |
| `search_pages` | Pages across all references; with a collection, its saved pages and the pages of its websites |
| `search_animations` | Scroll and hover animations across all references |
| `get_capture_status` | Job state, last progress and when the capture worker last checked in, with a suggested poll delay |
| `wait_for_capture` | Waits up to 40s (max 50) for a capture, then returns the finished capture (page thumbnails, gallery link, page ids) or says whether to call again. For clients without MCP Tasks |
| `list_collections` | Collections with website and page counts |
| `add_reference` | Queue a URL (`single` or `crawl`) for capture, with optional notes and color scheme. A URL that's already saved returns the saved reference unless `allow_duplicate`. With MCP Tasks it runs as a background task (see below) |
| `set_reference_notes` | Replace a website's note (why it was saved) |
| `create_collection` | New collection |
| `set_collection_membership` | Add or remove a whole website from a collection |
| `set_page_collection_membership` | Add or remove individual pages from a collection |

### Ask your agent to capture a site

Say "use Snip to capture linear.app" (or "crawl and gallerize it"). The agent calls `add_reference`, Snip captures in the background on your Mac, and when it finishes the agent gets a few page thumbnails and a link to the gallery.

- **Clients with [MCP Tasks](https://modelcontextprotocol.io/extensions/tasks/overview)** (Claude Code 2.1.319 or later): the call becomes a task. Claude Code moves it to the background right away and tells Claude when the capture is done, so you can keep working. Cancelling the task stops the crawl after its current page and keeps what it captured, like the Stop button. A task belongs to one capture run: if you press Recapture while it's open, the old task ends as cancelled and the agent can follow the new run with `wait_for_capture`.
- **Other clients** (Codex today): the agent calls `wait_for_capture` until it reports `done`. Each call returns within 50 seconds, under Codex's default 60-second tool timeout.

Snip or `npm run capture` must be running. If no capture agent has checked in recently, `add_reference` answers right away and the agent asks you to start it.

Every result carries the same JSON as text and as `structuredContent`. Bounded lists are capped by item count and bytes and say what they left out and how to continue; the legacy full reference read can be larger. Recordings are WebM video (older captures have GIFs), which most models can't watch, so captures also store sampled frames and a contact sheet per animation. `get_animation` gives the recording's signed URL under `recording`; its `gif` representation still inlines older GIFs.

File URLs returned by the MCP are signed and expire after 24 hours.

`get_page(include_styles: true)` now returns guidance to `get_page_styles` instead of a truncated JSON fragment. Update client prompts to use the new tool for styles. Existing `get_reference` calls without `part` still return the full legacy result, and old animations still offer their GIFs.

## Capture agent options (`capture/.env`)

| Variable | Default | |
| --- | --- | --- |
| `SNIP_URL` | `http://localhost:5173` | Your local app. In cloud mode the app points it at your Worker automatically |
| `CAPTURE_TOKEN` | | Must match `web/.dev.vars` (or the cloud Worker's secret) |
| `CHROMIUM_PATH` | Playwright's Chromium | Use your installed Chrome instead |
| `POLL_SECONDS` | `5` | Queue poll interval |
| `HEADLESS` | `true` | `false` to watch the browser |
| `DISMISS_POPUPS` | `true` | `false` keeps cookie banners and popups in captures |
| `SCROLL_FPS` | `30` | Scroll recording frames per second (5–50) |
| `SCROLL_STEP` | `40` | Pixels scrolled per scroll recording frame (min 8) |
| `SCROLL_MAX_FRAMES` | `360` | Frame cap per scroll recording; long pages take bigger steps |
| `SNIP_RECORDING_FORMAT` | `webm` | Prefer WebM when the Worker and browser support it; otherwise GIF. `gif` always records GIFs (several times bigger) |
| `SNIP_VIDEO_QUANTIZER` | `34` | Video quality, 0 (best, biggest) to 63 (smallest) |
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
npm run doctor                                    # offline checks, plus --check to probe the cloud library
```

`DEV_LOGIN` in `web/.dev.vars` skips sign-in on localhost, so the app never asks you to log in while you work. It is the name you appear as. Never set it on a deployed Worker. [Snip.app](docs/mac-app.md) runs this same checkout as a menu-bar app.

## Updating

When new changes land on `main`, one command brings a local copy (and Snip.app) up to date. In cloud mode it also migrates and redeploys the cloud Worker, so the two never drift apart.

```bash
npm run update
```

It quits Snip.app gracefully (active captures finish first), fast-forwards `main`, runs `npm ci` when dependencies changed, installs the capture browser, backs up and migrates the local database, rebuilds the web app, rebuilds Snip.app when `desktop/` changed, and reopens the app. In cloud mode it then applies the remote database migrations and deploys the new Worker before capture restarts. Snip records the version it deployed; if the deployed Worker no longer matches, it reports that the deployment changed outside Snip and asks you to deploy again instead of redeploying on its own. It never touches untracked files such as `.env` files, `.snip/` or your library. npm lockfile churn is reset automatically; any other local edit, or a terminal `npm run dev` or `npm run capture` still using the database, stops the update before anything changes (`npm run update -- --stash` sets edits aside instead). If a step fails, fix the error and run `npm run update` again to finish. `--full` reruns every step even when you're already up to date.

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
- `capture/`: Node 22+ + Playwright. Recordings are VP9 WebM encoded with WebCodecs in the capture browser; `sharp` (libvips) encodes the GIF fallback.
- `desktop/`: Electron menu-bar app for Apple Silicon Macs ([Snip.app](docs/mac-app.md)).
- `web/site/`: the static [public site](docs/public-site.md) on usesnip.dev.

## Known limits

- Full-page screenshots are capped at 16,000px tall (Chromium's texture limit).
- Crawls stay on the same hostname (with or without `www.`) and ignore query strings.
- Sites behind bot walls capture whatever the browser is shown. Cookie banners with an obvious "Accept" button are dismissed.
- Hover recordings pick up to 6 elements per page from `:hover` rules and transitions; shared nav/footer effects are recorded once per site.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md); first-time contributors sign a short [CLA](CLA.md) by commenting on their PR. Report security issues privately ([SECURITY.md](SECURITY.md)).

## License

Snip is source-available under the [Apache License 2.0 with the Commons Clause](LICENSE). You can use, self-host, modify and fork it for free, including at work. You can't sell it: no paid product, hosted service or paid support whose value comes mainly from Snip. Third-party material keeps its own license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
