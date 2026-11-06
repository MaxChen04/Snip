import path from "node:path"
import { localConfigPath } from "./local-config.mjs"
import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  // `npm run deploy` builds with your gitignored web/wrangler.deploy.jsonc (see scripts/cloudflare.mjs).
  plugins: [react(), tailwindcss(), cloudflare({ configPath: process.env.SNIP_WRANGLER_CONFIG || localConfigPath(__dirname) })],
  // Deploy builds go to dist-deploy/ so they never replace the local build that Snip.app serves.
  build: { outDir: process.env.SNIP_OUT_DIR || "dist" },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
})
