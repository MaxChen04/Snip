import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const BUNDLE_ID = "dev.snip.desktop"

function pathExists(location) {
  try { fs.lstatSync(location); return true } catch (error) { if (error.code === "ENOENT") return false; throw error }
}

function assertOwnBundle(bundle) {
  // Do not follow a link supplied in place of the app or its identity file.
  for (const [part, directory] of [[bundle, true], [path.join(bundle, "Contents"), true], [path.join(bundle, "Contents", "Info.plist"), false]]) {
    const stat = fs.lstatSync(part)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Unsafe app bundle path: ${part}`)
    }
  }
  let id
  try {
    id = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(bundle, "Contents", "Info.plist")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  } catch {
    throw new Error(`Cannot read bundle identity: ${bundle}`)
  }
  if (id !== BUNDLE_ID) throw new Error(`Refusing to replace an app that is not ${BUNDLE_ID}: ${bundle}`)
}

/** Install using a verified staged copy and keep the old app recoverable until replacement succeeds. */
export function installApp(built, appsDir, overrides = {}) {
  const copy = overrides.copy ?? ((source, destination) => execFileSync("/usr/bin/ditto", [source, destination], { stdio: "inherit" }))
  const verify = overrides.verify ?? (bundle => execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { stdio: "inherit" }))
  const identity = overrides.identity ?? assertOwnBundle
  const rename = overrides.rename ?? fs.renameSync
  fs.mkdirSync(appsDir, { recursive: true })
  const target = path.join(appsDir, "Snip.app")
  const exists = pathExists(target)
  if (exists) identity(target)

  const work = fs.mkdtempSync(path.join(appsDir, ".snip-install-"))
  const staged = path.join(work, "staged.app")
  const backup = path.join(work, "previous.app")
  let keepBackup = false
  try {
    copy(built, staged)
    identity(staged)
    verify(staged)
    if (exists) {
      // Recheck immediately before moving the target, including its identity and path type.
      identity(target)
      rename(target, backup)
    }
    try {
      if (pathExists(target)) throw new Error(`Installation target appeared during replacement: ${target}`)
      rename(staged, target)
    } catch (error) {
      if (exists) {
        try {
          if (pathExists(target)) throw new Error(`Another item is now at ${target}`)
          rename(backup, target)
        } catch (restoreError) {
          keepBackup = true
          throw new Error(`Installation failed and the previous app could not be restored. It remains at ${backup}: ${restoreError.message}`, { cause: error })
        }
      }
      throw error
    }
  } finally {
    if (!keepBackup) fs.rmSync(work, { recursive: true, force: true })
  }
  return target
}
