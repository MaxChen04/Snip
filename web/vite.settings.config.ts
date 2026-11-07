// Static Settings window. It has no Worker and no API: every action goes through the
// preload bridge, so it keeps working when the local server is stopped or the app runs
// in cloud mode. `base: "./"` keeps every asset relative, which the snip:// handler
// resolves from disk. The app build (vite.config.ts) is unchanged.
import fs from "node:fs"
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

const root = import.meta.dirname
const outDir = path.resolve(root, "dist-settings")

// Vite names the HTML after its input file. The desktop app loads one entry, index.html,
// so rename it once the bundle is written.
function indexEntry(): Plugin {
  return {
    name: "snip-settings-index",
    closeBundle() {
      const source = path.join(outDir, "settings.html")
      if (fs.existsSync(source)) fs.renameSync(source, path.join(outDir, "index.html"))
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), indexEntry()],
  // Relative asset URLs: the window is served from snip://settings/, not from a site root.
  base: "./",
  // No public assets: the app icon comes from the real window chrome, and a smaller
  // bundle is easier to keep inside the release allowlist.
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(root, "settings.html") },
  },
  resolve: {
    alias: { "@": path.resolve(root, "./src") },
  },
  define: { "import.meta.env.VITE_SETTINGS": JSON.stringify("1") },
  logLevel: "warn",
})
