// Stable step ids from proposals/cloud-contracts.md §1.5, in the order the engine runs them.
const ORDER: Record<string, string[]> = {
  setup: [
    // guard classifies the account before anything is created (contracts v3.10 §1.5).
    "preflight", "cloudflare-auth", "account", "url", "r2", "guard", "resources", "config",
    // The local server stops before the library is read: export starts its own Worker
    // on the quiescent persist dir (contracts §1.8).
    "schema", "deploy", "secrets", "quiesce", "release", "export", "import", "verify", "owner", "finish",
  ],
  pull: [
    "pull-preflight", "pull-manifest", "pull-d1", "pull-stage", "pull-files",
    "pull-verify", "pull-swap", "pull-finish",
  ],
  detach: ["detach-preflight", "detach-finish"],
  "delete-resources": ["delete-preflight", "delete-execute", "delete-verify"],
  "snapshot restore": ["snapshot-preflight", "snapshot-restore", "snapshot-finish"],
  "snapshot delete": ["snapshot-preflight", "snapshot-delete", "snapshot-finish"],
}

const TITLES: Record<string, string> = {
  preflight: "Check this Mac",
  "cloudflare-auth": "Sign in to Cloudflare",
  account: "Choose your Cloudflare account",
  url: "Find your workers.dev address",
  r2: "Check R2 storage",
  resources: "Create the database and bucket",
  guard: "Check this account has no other Snip",
  config: "Write the cloud configuration",
  schema: "Set up the database",
  deploy: "Deploy your Snip",
  secrets: "Store the cloud secrets",
  quiesce: "Pause captures",
  export: "Read this Mac's library",
  release: "Stop the local server",
  import: "Copy your library",
  verify: "Check every reference arrived",
  owner: "Sign this Mac in",
  finish: "Switch to your cloud library",
  "pull-preflight": "Check this Mac",
  "pull-manifest": "Read the cloud library",
  "pull-d1": "Download the database",
  "pull-stage": "Prepare a local copy",
  "pull-files": "Download screenshots",
  "pull-verify": "Check every reference arrived",
  "pull-swap": "Switch back to this Mac",
  "pull-finish": "Retry paused captures",
  "detach-preflight": "Check this Mac",
  "detach-finish": "Switch back to this Mac",
  "delete-preflight": "Check the cloud copy",
  "delete-execute": "Delete the Worker, database and files",
  "delete-verify": "Confirm it's gone",
  "snapshot-preflight": "Check the snapshot",
  "snapshot-restore": "Restore the snapshot",
  "snapshot-delete": "Delete the snapshot",
  "snapshot-finish": "Finish",
}

export function commandFor(running: string | null, mode: string | null): string {
  if (running && ORDER[running]) return running
  if (mode === "disabling") return "pull"
  return "setup"
}

export function stepsFor(command: string): string[] {
  return ORDER[command] ?? ORDER.setup
}

export function stepTitle(id: string, message?: string | null): string {
  return TITLES[id] ?? message ?? id
}

export const stepCopy: Record<string, string> = {
  cancel: "Stop setup",
  "progress-title": "Setting up your cloud library",
  "progress-copy": "Keep this window open. Cloudflare asks for two approvals: your account, and R2 if it's off.",
  "pull-title": "Bringing your cloud library back",
  "pull-copy": "Snip downloads a fresh copy, checks it, then switches this Mac to it. Keep this window open.",
  "detach-title": "Turning off cloud",
  "detach-copy": "This Mac goes back to its local library. Your cloud copy stays live.",
}
