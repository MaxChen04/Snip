# Cloud mode: your library on your other devices

Snip runs on your Mac and needs no server. Cloud mode is the optional second placement: the same app, with the library copied into your own Cloudflare account, so another Mac, a browser or a cloud agent such as Claude.ai can read it. The account is yours; there is still no Snip server.

Capture stays on this Mac. Cloud mode changes who can reach the library, not where pages are captured. Back to the [README](../README.md).

The app's **Settings → Cloud → Enable cloud** button is the normal path; the command line runs the same engine for scripts and agents. Both are described below.

## Enable cloud

In Snip.app, open **Settings → Cloud → Enable cloud**. The app shows a sheet first: what copies to Cloudflare, what stays on this Mac, and what Cloudflare will ask for. Nothing leaves the Mac until you approve it.

### What the sheet says

- **Copies:** every reference, page, animation, collection, note, extracted token, screenshot, GIF, HTML snapshot and style file in the library.
- **Stays:** the local library itself, exactly where it is. It becomes the snapshot you can go back to, and the app never renames or deletes it.
- **Doesn't move:** browser sessions and MCP grants. Agents sign in again at the new address.
- **Capture:** stays on this Mac. The capture agent is pointed at the new address after the copy finishes.

An **empty library** takes the same path. There is nothing to copy, the data steps are skipped, no snapshot is recorded, and the sheet says so.

### The two Cloudflare approvals

Usually two, and only one if R2 is already on:

1. **Sign in and allow.** Your browser opens on Cloudflare. Sign in and choose **Allow**. If you belong to more than one account, pick the one that will own the library. Snip asks for the access needed to create this one install.
2. **Turn on R2.** If R2 has never been enabled on the account, Cloudflare asks for a card once, even though storage is free up to 10 GB. Snip opens the R2 page and waits; come back when it's on and the setup continues on its own.

There are no IDs to copy, no secrets to paste and no dashboard steps besides those. The rest runs in the app.

### The owner link and passkey

When the Worker is up, Snip opens a **one-time owner link** in your browser. It registers a passkey there (Touch ID on a Mac) and hands the signed-in session back to Snip.app, so the app arrives signed in without a second login.

- The link works once and expires after ten minutes.
- The passkey is what you use to sign in to the cloud library from another browser or device.
- The app stores the secret that mints these links on this Mac. If it is ever lost, `owner rotate` sets a new one and mints a fresh link.

### While it copies

Snip creates the database, key-value store, bucket and Worker, applies the schema, deploys, copies the library and checks the result. The sheet shows one step at a time and keeps later steps dimmed.

- A capture that is running **pauses first** and continues on the cloud side after the move, instead of restarting from scratch.
- A failed step stays on screen with a **Retry** button. Retrying re-checks the steps that already passed, so it resumes rather than starting over.
- **Cancel** stops the run safely. The install stays recorded as `enabling`, so running it again resumes; `abort` is the command that returns an interrupted install to local and cleans up the partial resources. Your local library is never changed by either.
- When it finishes, the window reloads on your cloud URL, Settings moves to the menu bar, and the capture agent serves the cloud library.

### Waiting for your Mac

Capture is not hosted. A capture started from another device, including one started by an agent, is queued in the cloud database and runs when this Mac's capture agent next checks in.

The gallery card and every agent status use the same words, **Waiting for your Mac**, whether the agent is busy or the Mac is asleep. Nothing captures while the Mac is off; the queue waits.

## Command line and agents

The Settings button and the command line run the same provisioning engine. Use the CLI when you are already in a terminal, when you are scripting a setup, or when an agent is doing the work. It never replaces a step a person has to do in Cloudflare.

```bash
npm run setup:cloudflare -- --check --json   # preflight only; changes nothing
npm run setup:cloudflare -- --yes --json     # enable cloud, never prompt
```

With `--json`, stdout carries one JSON object per line and human text goes to stderr. Each line is a `step`, `log`, `human`, `needs_input`, `session` or `result`; the last is always `result`, and exit code 0 means success. A `human` event carries a URL the person must open (Cloudflare's allow page, the R2 page, the owner link); the run waits until they finish. A `needs_input` event exits 2: rerun with the missing flag instead of prompting. Never log the `session` line.

| Flag | Meaning |
| --- | --- |
| `--yes` | Never prompt. Missing values exit 2 instead of waiting for input. |
| `--check` | Preflight only: report what is missing and exit. Safe to run first. |
| `--json` | One JSON event per line on stdout; nothing else. |
| `--resume` | Continue an interrupted run. Automatic when the app is mid-enable. |
| `--account <id>` | Choose the Cloudflare account instead of the first membership. |
| `--domain <host>` | Override the public URL. workers.dev only in this release. |
| `--login <github-login>` | Add a GitHub login to the allowed list. |
| `--capture-env <replace\|separate\|keep>` | Where the capture agent points afterwards. The app defaults to `replace`; the CLI defaults to `keep`. |
| `--no-open` | Print URLs instead of opening a browser. |

Exit codes: `0` success, `1` failed, `2` missing input, `3` another run holds the lock, `4` this library cannot be provisioned (no build, no wrangler, or a local Snip server is already using it).

The CLI leaves `capture/.env` alone by default and writes the cloud settings to `capture/.env.cloud`. Run the agent against the hosted copy with:

```bash
SNIP_CAPTURE_ENV_FILE=capture/.env.cloud npm run capture
```

Pass `--capture-env replace` to point `capture/.env` at the cloud copy, or use the app's button, which does that for you.

### Other commands

The `setup:cloudflare` npm script runs the `setup` command. For everything else, call the engine directly, from the repository root (or from the app bundle's runtime in a release build):

| Command | Does |
| --- | --- |
| `node desktop/provision/cli.cjs status --json` | Print the saved install: mode, URL, account, snapshot. |
| `node desktop/provision/cli.cjs detach --json` | Turn off cloud on this Mac. No Cloudflare calls. |
| `node desktop/provision/cli.cjs pull --json` | Copy the cloud library back to a new local library, verify it and switch. |
| `node desktop/provision/cli.cjs snapshot restore --json` | Put the pre-cloud snapshot back as the live local library. |
| `node desktop/provision/cli.cjs snapshot delete --json` | Delete the snapshot. |
| `node desktop/provision/cli.cjs delete-resources --confirm <host>` | Delete the Worker, D1, KV and R2 for this install. Destructive. |
| `node desktop/provision/cli.cjs owner link` | Mint and open a fresh one-time sign-in link. |
| `node desktop/provision/cli.cjs owner rotate` | Replace the owner-link secret and mint a new link. Recovery path. |
| `node desktop/provision/cli.cjs abort` | Clean up an interrupted enable. |
| `node desktop/provision/cli.cjs migrate --json` / `deploy --json` | Apply remote migrations or deploy the current build. Used by updates. |

`delete-resources` requires `--confirm` to equal the cloud URL's host exactly, for example `snip.max.workers.dev`. The app asks for the same value, typed by hand.

## Turning cloud off

**Settings → Cloud → Turn off cloud** detaches this Mac. It does not delete the cloud copy. The confirmation says exactly what stays:

> Changes made in your cloud library stay there. This Mac goes back to the copy from 6 Nov. Your cloud library is still reachable at snip.max.workers.dev, and devices and agents signed in to it keep working.

For a library that started empty, the second sentence is "This Mac goes back to an empty library", and there is no snapshot row.

The dialog offers three outcomes:

- **Stay in cloud** (cancel).
- **Turn off and keep local** — detach now. This Mac opens the snapshot from before the move. The cloud copy stays live, and anything signed in to it keeps working.
- **Bring the cloud library back to this Mac** — copies the cloud library down first, verifies it, then switches this Mac to it. Also available later as **Copy back now**.

Nothing is copied back automatically. If you worked in the cloud copy and want those changes here, use **Copy back now** or `pull`.

### Copy back

**Copy back now** (or `node desktop/provision/cli.cjs pull --json`) downloads a manifest, exports the cloud database, stages a **new** local library, downloads every file, checks counts and a digest, and only then swaps it in. The local library from before the move is kept as a backup, so a pull leaves one live local library plus one backup.

When it finishes, this Mac is in local mode. The cloud copy still exists and is still reachable; detaching and copying back are separate from deleting.

### The snapshot

After a move, **Settings → Cloud** lists the pre-cloud library with its date and size, for example **Snapshot from 6 Nov, 10:12 — 812 MB**.

- **Restore** puts the snapshot back as this Mac's live library. In cloud mode, use **Copy back now** instead.
- **Delete** removes the snapshot and its backups.
- The row is hidden when the library was empty at the time of the move.

### Delete cloud resources

Deleting the cloud copy is separate, destructive and never offered inside the turn-off dialog. **Settings → Cloud → Delete cloud resources** removes the Worker, D1 database, KV namespace and R2 bucket after you type the library's address.

The local library and its snapshot are not touched. Deleting cannot be undone; the next enable starts a new install and copies the local library up again.

### Sign out all devices

**Settings → Cloud → Sign out all devices** ends every browser session and the app's session for this install. Use it if a laptop or browser with access is lost.

It does **not** revoke MCP access tokens. Agents that were already authorized keep the access they were granted until their token expires, seven days after issue. Passkeys are not deleted, so you can sign in again with yours.

## One Snip per Cloudflare account

Snip keeps one library per Cloudflare account. Before changing anything, the setup checks whether the account already has a Worker named `snip` or a non-empty Snip database. If it finds one that does not belong to this Mac's recorded install, it stops before creating or changing anything:

> This Cloudflare account already has a Snip library at snip.max.workers.dev. Snip keeps one library per account. Sign in to the account that owns it, choose a different Cloudflare account, or delete the existing Snip first.

The next actions are **Open that library** and **Choose another account**. There is no replace option and no second name: the Worker name is the address your passkey and agent connections are bound to, so it cannot be varied per install.

An older standalone Worker that Snip.app did not create counts as another library. Snip will not take it over; delete it from the Cloudflare dashboard first if you want this account for a new cloud library.

## workers.dev only

Cloud mode uses the Worker name `snip` on your account's workers.dev subdomain, for example `https://snip.max.workers.dev`. Custom domains are not supported in this release: they would change the address that passkeys and MCP connections are bound to. Use the URL Snip prints everywhere you connect a client.

## GitHub sign-in

There is no OAuth App to create, no Client ID and no client secret to paste. GitHub sign-in is optional:

- **For you**, the passkey from the owner link is the default way in. GitHub is not needed.
- **For a second person**, turn on GitHub sign-in in Settings → Cloud. GitHub asks you to approve Snip's app in one click using the App Manifest flow, then you add the GitHub logins allowed to sign in. Passkeys stay owner-only.
- **For MCP clients**, GitHub is how a client authorizes at the cloud address. If you plan to connect a cloud agent such as Claude.ai, keep GitHub sign-in on and add at least your own login.

An empty allowlist refuses GitHub sign-in entirely. That is the safe default; it does not affect the owner's passkey.

## Updating a cloud install

`npm run update` updates both halves when this Mac is in cloud mode: it fast-forwards, rebuilds, applies the remote database migrations, deploys the new Worker and then restarts capture. Existing captures and saved files are kept.

A release build does the same on its first launch after a version change, before the window loads. If that deploy fails, Snip shows it as a blocking step instead of running a new app against an old Worker.

To do it by hand, apply migrations before deploying:

```bash
node desktop/provision/cli.cjs migrate --json
node desktop/provision/cli.cjs deploy --json
```

## If the cloud library can't be reached

If the Worker is deleted in the Cloudflare dashboard, the account changes, or the URL stops resolving, Snip says **This Mac's cloud library can't be reached** and offers the snapshot or a new enable. It does not quietly open the empty local library instead.

## Debugging a setup

The supported ways to turn on cloud mode are **Settings → Cloud** and the CLI. Both run the same engine, which records the install in `.snip/cloud.json`; only the engine writes there. A Worker deployed by hand is not adopted by Snip.app, because the app would have no record of owning it.

When a setup stops:

```bash
node desktop/provision/cli.cjs status --json       # mode, URL, account, snapshot, last error
npm run setup:cloudflare -- --check --json         # what is missing, without changing anything
npm run setup:cloudflare -- --yes --json           # resume; completed steps re-verify and skip
npm run doctor                                     # local config and capture-agent checks
```

- `.snip/cloud.json` holds `mode`, the cloud record and the per-step journal, including `error` with the failing step and a hint. It is safe to read; do not edit it.
- A partial install stays at `mode: "enabling"`, so the next run resumes instead of starting over. `abort` is the only command that returns an interrupted enable to local.
- The built Worker, its client assets and the migrations are copied into `<library>/cloud/` on every deploy. That directory is disposable; the next deploy overwrites it from the build.
- Nothing is ever written inside Snip.app's bundle, so a failed deploy cannot corrupt a release build.

If the Worker is healthy but the app shows the wrong library, check `status` before touching anything: `mode` decides whether the window opens the local snapshot or the cloud URL, and editing Cloudflare resources by hand does not change it.

## Free-tier headroom

R2 gives 10 GB (roughly 1,500 to 3,000 captured pages, depending on page length and GIFs), D1 5 GB, Workers 100k requests a day. The account menu shows how much of the R2 free tier a hosted Snip is using; the local app shows the bytes stored on this Mac instead.
