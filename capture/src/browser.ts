import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import path from "node:path"

/** Chromium flags for capture, shared by the agent and the benchmark. */
export const CHROMIUM_ARGS = ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]

/** Playwright's error when its pinned browser build was never downloaded (e.g. after a Playwright update). */
export const isMissingBrowser = (error: unknown) =>
  error instanceof Error && /Executable doesn't exist at/i.test(error.message)

/** Download the browser build this Playwright version expects. Headless capture only needs the shell. */
export function installBrowser(headless: boolean, log: (line: string) => void = () => {}) {
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js")
  const args = [cli, "install", ...(headless ? ["--only-shell"] : []), "chromium"]
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env })
    let tail = ""
    const data = (chunk: Buffer) => {
      const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, "")
      tail = (tail + text).slice(-2000)
      for (const line of text.split(/\r?\n/)) if (line.trim()) log(line.trim())
    }
    child.stdout.on("data", data)
    child.stderr.on("data", data)
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) return resolve()
      const reason = tail.split("\n").map((line) => line.trim()).find((line) => line.startsWith("Error:"))?.slice(0, 300) ?? `exit ${code}`
      reject(new Error(`Browser install failed: ${reason}`))
    })
  })
}

type LaunchOptions<B> = {
  launch: () => Promise<B>
  install: () => Promise<void>
  /** False when the browser is bundled read-only (release app) or a custom executable is configured. */
  canInstall: boolean
  onInstall?: () => Promise<void> | void
}

/** Launch the browser, installing it once first if Playwright reports it missing. */
export async function launchWithRepair<B>({ launch, install, canInstall, onInstall }: LaunchOptions<B>): Promise<B> {
  try {
    return await launch()
  } catch (error) {
    if (!canInstall || !isMissingBrowser(error)) throw error
    await onInstall?.()
    await install()
    return await launch()
  }
}
