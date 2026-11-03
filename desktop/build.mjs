// Builds Snip.app for this Mac and installs it in /Applications.
// The app runs this repo in place, so rebuild only if you move the repo
// or change files in desktop/. Run from the repo root: npm run app

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { packager } from "@electron/packager"
import { installApp } from "./install.mjs"

if (process.platform !== "darwin") {
  console.error("Snip.app can only be built on macOS.")
  process.exit(1)
}
if (process.arch !== "arm64") {
  console.error("Snip.app supports Apple Silicon only; Intel Macs are unsupported. If you are using Rosetta, run this build with native arm64 Node.js.")
  process.exit(1)
}

let outputDir
let installDir
let noInstall = false
for (let i = 0; i < process.argv.slice(2).length; i++) {
  const args = process.argv.slice(2)
  const arg = args[i]
  if (arg === "--no-install") noInstall = true
  else if (arg === "--out" || arg === "--install-dir") {
    const value = args[++i]
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a directory`)
    if (arg === "--out") outputDir = path.resolve(value)
    else installDir = path.resolve(value)
  } else throw new Error(`Unknown argument: ${arg}`)
}
if (noInstall && installDir) throw new Error("Use either --no-install or --install-dir, not both.")

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const buildDir = path.join(here, "build")
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" })

fs.rmSync(buildDir, { recursive: true, force: true })
fs.mkdirSync(buildDir, { recursive: true })

// 1. Tell the app where the repo lives.
fs.writeFileSync(path.join(here, "repo.json"), JSON.stringify({ root }, null, 2))

// 2. App icon from the Snip logo.
const iconset = path.join(buildDir, "Snip.iconset")
fs.mkdirSync(iconset)
const logo = path.join(root, "web/public/logo.png")
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = size * scale
    if (px > 512) continue // the logo is 512px; skip the 1024px slot rather than upscale
    const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`
    execFileSync("sips", ["-z", String(px), String(px), logo, "--out", path.join(iconset, name)], { stdio: "ignore" })
  }
}
const icon = path.join(buildDir, "Snip.icns")
run("iconutil", ["-c", "icns", iconset, "-o", icon])

// 3. Package.
const [outDir] = await packager({
  dir: here,
  name: "Snip",
  platform: "darwin",
  arch: "arm64",
  out: outputDir ?? path.join(here, "dist"),
  overwrite: true,
  icon,
  appBundleId: "dev.snip.desktop",
  appCategoryType: "public.app-category.developer-tools",
  extendInfo: { LSMinimumSystemVersion: "14.0" },
  // The launcher has no runtime dependencies, so ship only its own files.
  ignore: [/^\/(dist|build|node_modules|tests|scripts)(\/|$)/, /^\/(build\.mjs|install\.mjs|package-lock\.json|\.gitignore|README[^/]*)$/i],
  prune: false,
})
const built = path.join(outDir, "Snip.app")

// 4. Ad-hoc sign so Apple Silicon will launch it (no Apple developer account needed).
run("codesign", ["--force", "--deep", "--sign", "-", built])

// 5. Install.
if (noInstall) {
  console.log(`\nBuilt ${built}`)
} else {
  let appsDir = installDir ?? "/Applications"
  if (!installDir) {
    try { fs.accessSync(appsDir, fs.constants.W_OK) } catch { appsDir = path.join(os.homedir(), "Applications") }
  }
  const target = installApp(built, appsDir)
  console.log(`\nInstalled ${target}\nOpen it from Launchpad or Spotlight, or drag it to your Dock.`)
}
