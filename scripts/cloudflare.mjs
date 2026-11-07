#!/usr/bin/env node
// Thin wrapper: every argument is forwarded to the provisioning engine, and
// nothing is implemented here.
//
//   npm run setup:cloudflare                    → setup
//   npm run setup:cloudflare -- status          → status
//   npm run setup:cloudflare -- setup --json    → setup, NDJSON
//
// The engine defaults to `setup` when no command is given, which is why this
// file must never add one: npm appends `--` arguments after the whole script
// string, so a hardcoded `setup` would silently swallow the real command.
//
// This file used to re-export the old setup script's config helpers
// (`renderDeployConfig`, `preserveLocalConfig`, `TRACKED_CONFIG`, `DEPLOY_CONFIG`)
// so a test could reach them. Nothing in the product used them: the engine patches
// the emitted config itself, and the one helper it still reads (`readValues`) is
// imported from `desktop/provision/lib.cjs` where the legacy L-C detection lives.
// Keeping them here made the retired path look alive, so they are gone.

import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const cli = require(path.join(ROOT, "desktop/provision/cli.cjs"))

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  // Every argument goes straight to the engine, including an unknown command:
  // it reports that itself, so `--json` still gets one `result` event. This file
  // must not keep a second list of command names — the copy that used to live
  // here also mistook an option's value (`--root <path>`) for the command.
  const { code } = await cli.main(process.argv.slice(2))
  process.exitCode = code
}
