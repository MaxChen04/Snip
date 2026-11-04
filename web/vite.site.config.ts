// Static build of the public site (usesnip.dev): the landing page and setup
// guide only, with no Worker API. `npm run build:site` writes dist-site/,
// which site/worker.ts serves. The app build (vite.config.ts) is unchanged.
import fs from "node:fs"
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

const ORIGIN = "https://usesnip.dev"
const TITLE = "Snip: a shelf for the websites you admire"
const DESCRIPTION =
  "Paste a URL. Snip captures every page, its styles and its motion, then keeps it all in a free, self-hosted library your coding agent can search over MCP."

const pages = [
  { path: "/", title: TITLE, description: DESCRIPTION },
  {
    path: "/guide",
    title: "Setup and privacy · Snip",
    description: "Where Snip keeps your data, who can reach it, and how to deploy your own copy on Cloudflare’s free plan.",
  },
]

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")

function head(p: (typeof pages)[number]) {
  const url = ORIGIN + p.path
  return [
    `<!-- seo -->`,
    `<title>${esc(p.title)}</title>`,
    `<meta name="description" content="${esc(p.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />`,
    `<meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Snip" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:title" content="${esc(p.title)}" />`,
    `<meta property="og:description" content="${esc(p.description)}" />`,
    `<meta property="og:image" content="${ORIGIN}/og.png" />`,
    `<meta property="og:image:width" content="2400" />`,
    `<meta property="og:image:height" content="1260" />`,
    `<meta property="og:image:alt" content="The Snip gallery of captured websites" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(p.title)}" />`,
    `<meta name="twitter:description" content="${esc(p.description)}" />`,
    `<meta name="twitter:image" content="${ORIGIN}/og.png" />`,
    `<!-- /seo -->`,
  ].join("\n    ")
}

const withHead = (html: string, p: (typeof pages)[number]) =>
  html.replace(/<!-- seo -->[\s\S]*<!-- \/seo -->|<title>.*<\/title>/, () => head(p))

function publicSite(): Plugin {
  let outDir = ""
  return {
    name: "snip-public-site",
    configResolved(c) {
      outDir = c.build.outDir
    },
    transformIndexHtml: {
      order: "pre",
      handler: (html) => withHead(html, pages[0]).replace("/src/main.tsx", "/src/site-main.tsx"),
    },
    closeBundle() {
      const index = fs.readFileSync(path.join(outDir, "index.html"), "utf8")
      // One HTML file per route so each has its own title, description and canonical URL.
      for (const p of pages.slice(1)) {
        const dir = path.join(outDir, p.path)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, "index.html"), withHead(index, p))
      }
      fs.writeFileSync(
        path.join(outDir, "404.html"),
        withHead(index, { path: "/", title: "Not found · Snip", description: DESCRIPTION }).replace(
          /<link rel="canonical"[^>]*>\n\s*/,
          `<meta name="robots" content="noindex" />\n    `,
        ),
      )
      // Social preview: the hero at 1200×630, captured at 2x.
      fs.copyFileSync(path.join(__dirname, "site/og.png"), path.join(outDir, "og.png"))
      fs.writeFileSync(path.join(outDir, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`)
      const today = new Date().toISOString().slice(0, 10)
      fs.writeFileSync(
        path.join(outDir, "sitemap.xml"),
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
          pages.map((p) => `  <url><loc>${ORIGIN}${p.path}</loc><lastmod>${today}</lastmod></url>\n`).join("") +
          `</urlset>\n`,
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), publicSite()],
  define: { "import.meta.env.VITE_PUBLIC_SITE": JSON.stringify("1") },
  publicDir: "public",
  build: { outDir: "dist-site", emptyOutDir: true },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
})
