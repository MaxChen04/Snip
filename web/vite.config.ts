import path from "node:path"
import { localConfigPath } from "./local-config.mjs"
import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  // The plugin builds from web/wrangler.local.jsonc when this Mac has one (its own
  // storage identities), else the tracked web/wrangler.jsonc. Cloud deploys do not
  // build here at all: the provisioning engine copies this build into the library's
  // cloud directory and patches the emitted config to name the deployed resources.
  plugins: [react(), tailwindcss(), cloudflare({ configPath: process.env.SNIP_WRANGLER_CONFIG || localConfigPath(__dirname) })],
  // One output directory. `npm run build -w web` produces what the app serves and
  // what the engine deploys; there is no separate deploy build.
  build: { outDir: process.env.SNIP_OUT_DIR || "dist" },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
})
