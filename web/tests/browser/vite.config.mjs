// Vite config for the browser tests only: the real SPA (same aliases and plugins) without the Cloudflare Worker
// plugin, because every /api and /auth call is mocked by Playwright. Not used by the app itself.
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export default defineConfig({
  root: web,
  configFile: false,
  // Own cache so parallel runs, or other agents' dev servers, never share or rewrite optimizer state.
  cacheDir: path.join(os.tmpdir(), `snip-browser-vite-${process.env.SNIP_BROWSER_PORT ?? "x"}`),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.join(web, "src") } },
  server: { fs: { allow: [path.resolve(web, "..")] } },
  clearScreen: false,
})
