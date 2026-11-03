# Snip

A private, Cosmos-style library of website design references. Paste a URL, choose **Static page** or **Crawl site**, and a capture agent on your machine records every page:

- Desktop (1440px) and mobile (390px) full-page screenshots
- **Computed styles** per element (only values that differ from browser defaults, plus `::before`/`::after`), keyframes, `:hover` rules and CSS variables
- A **self-contained HTML snapshot**: linked and cross-origin CSS inlined, CSS-in-JS / CSSOM rules materialized, web fonts embedded, scripts stripped
- **Scroll GIFs** per page and **hover GIFs** for elements with hover effects
- Extracted **design tokens**: colors, fonts, type scale, spacing, radii, shadows, transitions

The hosted app is an infinite gallery (Websites / Pages / Animations) with collections, search and sort. A **remote MCP server** lets your agent search, read and add references.

```
┌──────────── Cloudflare (free plan) ─────────────┐        ┌──── Your machine ────┐
│ Worker: React gallery + API + /mcp (OAuth)      │◀─poll──│ capture agent        │
│ D1: references, pages, animations, collections  │──job──▶│ (Playwright/Chromium)│
│ R2: screenshots, GIFs, HTML snapshots, styles   │◀upload─│                      │
│ KV: OAuth tokens                                │        └──────────────────────┘
└─────────────────────────────────────────────────┘
```

Capture runs locally because the free plans can't crawl sites: Cloudflare's free Browser Rendering allows 10 browser-minutes a day, and Vercel Hobby functions stop after 5 minutes. Queued references wait until the agent is running.

## Stack

- `web/`: Vite + React 19 + Tailwind v4, **shadcn** with the **SortUI** registry (`@sortui` theme and components in `src/components/ui`), Hono on Cloudflare Workers, D1, R2, `@cloudflare/workers-oauth-provider`, MCP via `agents/mcp/server` (stateless `createMcpHandler`).
- `capture/`: Node 22 + Playwright, `gifenc` for GIF encoding.

Add more SortUI components with `cd web && npx shadcn@latest add @sortui/<name>`.

## Local development

```bash
npm install
cp web/.dev.vars.example web/.dev.vars          # DEV_LOGIN skips GitHub login on localhost
npm run db:migrate:local -w web
npm run dev                                       # http://localhost:5173

# second terminal
cp capture/.env.example capture/.env              # SNIP_URL=http://localhost:5173, CAPTURE_TOKEN from .dev.vars
npx playwright install chromium                   # once
npm run capture
```

## Deploy to Cloudflare (free plan)

1. **GitHub OAuth app** (github.com → Settings → Developer settings → OAuth Apps → New):
   - Homepage URL: `https://snip.<your-subdomain>.workers.dev`
   - Callback URL: `https://snip.<your-subdomain>.workers.dev/auth/callback`
2. **Create resources** and paste the printed ids into `web/wrangler.jsonc`:
   ```bash
   cd web
   npx wrangler d1 create snip
   npx wrangler kv namespace create OAUTH_KV
   npx wrangler r2 bucket create snip-files
   ```
   Also set `PUBLIC_URL` and `ALLOWED_GITHUB_LOGINS` in `wrangler.jsonc`.
3. **Secrets**:
   ```bash
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET     # openssl rand -hex 32
   npx wrangler secret put CAPTURE_TOKEN      # openssl rand -hex 32
   ```
4. **Migrate and deploy**:
   ```bash
   npm run db:migrate:remote
   npm run deploy
   ```
5. Point `capture/.env` at the deployed URL with the same `CAPTURE_TOKEN`, then `npm run capture`.

Free-tier headroom: R2 gives 10 GB (roughly 1,500 to 3,000 captured pages, depending on page length and GIFs), D1 5 GB, Workers 100k requests/day.

## Connect your agent (remote MCP)

The MCP endpoint is `https://snip.<your-subdomain>.workers.dev/mcp`. Clients register themselves, send you through GitHub login, and show a consent screen.

```bash
claude mcp add --transport http snip https://snip.<your-subdomain>.workers.dev/mcp
```

For Claude.ai or Claude Desktop, add it as a custom connector with the same URL.

| Tool | What it does |
| --- | --- |
| `search_references` | Search by text, collection or domain; returns summaries with ids |
| `get_reference` | One reference in bounded parts: `overview`, `pages`, `animations`, `tokens` (optionally one `token_group`, paginated). `full` is the legacy everything-at-once read |
| `get_page` | One page: signed screenshot URLs with coverage, a token summary, an inline viewport screenshot and optional HTML in chunks |
| `get_page_styles` | Valid, bounded computed styles: summary, filtered elements, keyframes, hover rules, font faces, CSS variables |
| `get_animation` | One animation: a manifest (timing provenance, sampled frames, the element's observed styles) plus a contact sheet, a single frame or the GIF |
| `search_animations` | Scroll and hover animations across all references |
| `get_capture_status` | Job state, last progress and when the capture worker last checked in, with a suggested poll delay |
| `list_collections` | Collections with counts |
| `add_reference` | Queue a URL (`single` or `crawl`) for capture |
| `create_collection` | New collection |
| `set_collection_membership` | Add or remove a reference from a collection |

Every result carries the same JSON as text and as `structuredContent`. Lists are capped by item count and bytes and say what they left out and how to continue. Many models only see the first frame of a GIF, so new captures also store sampled frames and a contact sheet per animation (animations captured earlier only have the GIF until you recapture).

File URLs returned by the MCP are signed and expire after 24 hours.

`get_page(include_styles: true)` now returns guidance to `get_page_styles` instead of a truncated JSON fragment. Update client prompts to use the new tool for styles. Existing `get_reference` calls without `part` still return the full legacy result, and old animations still offer their GIFs.

Run `npm test` for the MCP response-budget and cursor regression checks.

## Capture agent options (`capture/.env`)

| Variable | Default | |
| --- | --- | --- |
| `SNIP_URL` | | Worker URL |
| `CAPTURE_TOKEN` | | Must match the Worker secret |
| `CHROMIUM_PATH` | Playwright's Chromium | Use your installed Chrome instead |
| `POLL_SECONDS` | `5` | Queue poll interval |
| `HEADLESS` | `true` | `false` to watch the browser |
| `SHEET_FRAMES` | `9` | Frames sampled per animation for its contact sheet (2–16) |
| `SHEET_WIDTH` | `1536` | Max contact sheet width in px |

`npm run once -w capture` drains the queue and exits.

## Known limits

- Full-page screenshots are capped at 16,000px tall (Chromium's texture limit).
- Crawls stay on the same hostname (with or without `www.`) and ignore query strings.
- Sites behind logins or bot walls capture whatever an anonymous browser sees. Cookie banners with an obvious "Accept" button are dismissed.
- Hover GIFs pick up to 6 elements per page from `:hover` rules and transitions; shared nav/footer effects are recorded once per site.
