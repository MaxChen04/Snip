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
- The link always signs in as the library's one owner. On a fresh install that identity is created; on a re-enabled or adopted library it is reused, so a second owner row never appears.
- The passkey is what you use to sign in to the cloud library from another browser or device. Registering one only adds a device: Snip never replaces or deletes an existing passkey, and adding the same device twice says **You already added a passkey on this device.**
- The app stores the secret that mints these links on this Mac. If it is ever lost, `owner rotate` sets a new one and mints a fresh link.

### Signing in later

At the cloud address, **/sign-in** is the everyday door: **Sign in with a passkey**, with nothing to type. If this device has no passkey yet, the page offers **Use GitHub** when the library allows it, or you can add a passkey from a device that is already signed in.

**/passkeys** (also **Passkeys and devices** in the account menu) lists every passkey that can open the library:

- **Add this device** names the device and asks for Touch ID, your device PIN or a security key. The passkey stays on the device; Snip keeps only the public half.
- **Remove** retires one device, which is the recovery path for a lost laptop or phone. If it was your only passkey, you sign in again with the owner link or GitHub.
- **Sign out all devices** ends every browser session and the app's session. Passkeys stay registered, and agents connected over MCP keep their own tokens until those expire.

A passkey is owner-only. It is not an invitation: a second person signs in with GitHub.

### While it copies

Snip creates the database, key-value store, bucket and Worker, applies the schema, deploys, copies the library and checks the result. The sheet shows one step at a time and keeps later steps dimmed.

- A capture that is running **pauses first** and continues on the cloud side after the move, instead of restarting from scratch.
- A failed step stays on screen with a **Retry** button. Retrying re-checks the steps that already passed, so it resumes rather than starting over.
- **Cancel** stops safely after the current action and leaves the install recorded as `enabling`, so running it again resumes. **Undo setup** is the separate action that returns this Mac to local and deletes only the resources this run created. Your local library is never changed by either.
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

With `--json`, stdout carries one JSON object per line and human text goes to stderr. Each line is a `step`, `log`, `human`, `choice`, `needs_input`, `session` or `result`; the last is always `result`, and exit code 0 means success. A `human` event carries a URL the person must open (Cloudflare's allow page, the R2 page, the owner link); the run waits until they finish. A `choice` event describes a decision with consequences and exits 2 with `data.resumeWith`; `--yes` does not answer it. A `needs_input` event also exits 2 and names the missing flags. Never log the `session` line.

Exit 4 means this machine or this library cannot be provisioned right now. It covers every preflight refusal, each with its own `result.code`: `NOT_A_LIBRARY`, `NO_NODE`, `NO_WRANGLER`, `NO_BUILD`, `BAD_CONFIG`, `NOT_AN_ACCOUNT`, `LOCAL_SERVER_RUNNING`, `UNSUPPORTED_PLATFORM` and `FOREIGN_SNIP`. Every failed result carries `retryable`; `true` means the same command works once something outside Snip changes, and `false` means repeating it cannot help. Agents branch on `retryable`, not the code string.

| Flag | Meaning |
| --- | --- |
| `--yes` | Never prompt. Missing values exit 2 instead of waiting for input. It suppresses questions, not consequences: it never adopts an existing library. |
| `--check` | Preflight only: report what is missing and exit. Safe to run first. |
| `--json` | One JSON event per line on stdout; nothing else. |
| `--resume` | Continue an interrupted run. Automatic when the app is mid-enable. |
| `--account <id>` | Choose the Cloudflare account instead of the first membership. |
| `--domain <host>` | Override the public URL. workers.dev only in this release. |
| `--login <github-login>` | Add a GitHub login to the allowed list. |
| `--capture-env <replace\|separate\|keep>` | Where the capture agent points afterwards. The app defaults to `replace`; the CLI defaults to `keep`. |
| `--adopt-existing` | Take **Use that library** when the account already holds a Snip library with data. Without it the run emits a `choice` and exits 2. Required in any unattended run that should adopt. |
| `--no-open` | Print URLs instead of opening a browser. |

Exit codes: `0` success, `1` failed, `2` missing input or an unanswered choice, `3` another run holds the lock, `4` this machine or library cannot be provisioned right now (see the `result.code` list above).

The CLI leaves `capture/.env` alone by default and writes the cloud settings to `capture/.env.cloud`. Run the agent against the hosted copy with:

```bash
SNIP_CAPTURE_ENV_FILE=capture/.env.cloud npm run capture
```

Pass `--capture-env replace` to point `capture/.env` at the cloud copy, or use the app's button, which does that for you.

### Other commands

`npm run setup:cloudflare` runs `setup` when no command is given. Add a command after `--` for everything else:

| Command | Does |
| --- | --- |
| `npm run setup:cloudflare -- status --json` | Print the saved install: mode, URL, account, snapshot. |
| `npm run setup:cloudflare -- detach --json` | Turn off cloud on this Mac. No Cloudflare calls. |
| `npm run setup:cloudflare -- pull --json` | Copy the cloud library back to a new local library, verify it and switch. |
| `npm run setup:cloudflare -- snapshot restore --json` | Put the pre-cloud snapshot back as the live local library. |
| `npm run setup:cloudflare -- snapshot delete --json` | Delete the snapshot. |
| `npm run setup:cloudflare -- delete-resources --confirm <host>` | Delete the Worker, D1, KV and R2 for this install. Destructive. |
| `npm run setup:cloudflare -- owner link` | Mint and open a fresh one-time sign-in link. |
| `npm run setup:cloudflare -- owner rotate` | Replace the owner-link secret and mint a new link. Recovery path. |
| `npm run setup:cloudflare -- abort` | Clean up an interrupted enable. |
| `npm run setup:cloudflare -- migrate --json` / `deploy --json` | Apply remote migrations or deploy the current build. Used by updates. |

`delete-resources` requires `--confirm` to equal the cloud URL's host exactly, for example `snip.max.workers.dev`. The app asks for the same value, typed by hand.

## Turning cloud off

**Settings → Cloud → Turn off cloud** detaches this Mac. It does not delete the cloud copy. The confirmation says exactly what stays:

> Changes made in your cloud library stay there. This Mac goes back to the copy from 6 Nov. Your cloud library is still reachable at snip.max.workers.dev, and devices and agents signed in to it keep working.

For a library that started empty, the second sentence is "This Mac goes back to an empty library", and there is no snapshot row. For an adopted install it is "This Mac goes back to its own library"; the row is **This Mac's library**, not a snapshot.

The dialog offers three outcomes:

- **Stay in cloud** (cancel).
- **Turn off and keep local** — detach now. This Mac opens its local library (for an adopted install) or the snapshot from before the move. The cloud copy stays live, and anything signed in to it keeps working.
- **Bring the cloud library back to this Mac** — copies the cloud library down first, verifies it, then switches this Mac to it. Also available later as **Copy back now**.

Nothing is copied back automatically. If you worked in the cloud copy and want those changes here, use **Copy back now** or `pull`.

### Copy back

**Copy back now** (or `npm run setup:cloudflare -- pull --json`) downloads a manifest, exports the cloud database, stages a **new** local library, downloads every file, checks counts and a digest, and only then swaps it in. The local library from before the move is kept as a backup, so a pull leaves one live local library plus one backup.

When it finishes, this Mac is in local mode. The cloud copy still exists and is still reachable; detaching and copying back are separate from deleting.

### The snapshot

After a **completed move**, **Settings → Cloud** lists the pre-cloud copy with its date and size, for example **Snapshot from 6 Nov, 10:12 — 812 MB**.

- **Restore** puts the snapshot back as this Mac's live library. In cloud mode, use **Copy back now** instead.
- **Delete** removes the snapshot and its backups.
- The row is hidden when the library was empty at the time of the move.

An **adopted** library is not a snapshot, because there is no separate copy: the local library was never moved. It shows as **This Mac's library** with one action, **Switch back to it**, and no Restore or Delete. See [Adopting a library you already had](#adopting-a-library-you-already-had).

### Delete cloud resources

Deleting the cloud copy is separate, destructive and never offered inside the turn-off dialog. **Settings → Cloud → Delete cloud resources** removes the Worker, D1 database, KV namespace and R2 bucket after you type the library's address.

The local library and its snapshot are not touched. Deleting cannot be undone; the next enable starts a new install and copies the local library up again.

### Sign out all devices

**/passkeys → Sign out all devices** (also in Settings → Cloud) ends every browser session and the app's session for this install. Use it if a laptop or browser with access is lost.

The page says exactly what it does: passkeys stay registered, and agents connected over MCP keep their own tokens until those expire. A passkey is a credential, not a session, so removing one from the list is a separate action, and signing out never removes devices.

## One Snip per Cloudflare account

Snip keeps one library per Cloudflare account. Before changing anything, setup looks at what is already there and takes one of five paths:

| What it finds | What happens |
| --- | --- |
| Nothing | Normal setup. |
| This Mac's own interrupted install | Resumes it, re-checking the steps that already passed. |
| An **empty** Snip from an older install | Adopts it silently, redeploys over it, and continues. Nothing is asked, because there is nothing to lose. |
| A Snip from an older install **with data** | Asks. Nothing has changed yet. |
| Another Worker named `snip` that is not a Snip | Refuses before touching anything. |

### Adopting a library you already had

If you deployed Snip before the Settings button existed, the account has a Worker, database and bucket but no record on this Mac that they are yours. Because it can tell a Snip from anything else by its schema, bindings and deploy config, Snip recognises that install. An empty one is simply adopted.

One **with references** needs a decision:

> This Cloudflare account already has a Snip library.
> **Use that library** — Switches this Mac to it. Your local library is kept and is not copied.
> **Stop** — Changes nothing.

- **Use that library** adopts the existing URL, account, database, KV namespace and bucket. Your local library stays exactly where it is, untouched: it is not moved, renamed or copied, because nothing needs to be duplicated for ceremony. The status line reads **adopted · 1,284 references**, never "verified", because no copy was verified. Existing passkeys and browser sessions keep working, and `CAPTURE_TOKEN` is regenerated for this Mac's capture agent.
- **Stop** leaves the account and this Mac exactly as they were.
- From the CLI, use `npm run setup:cloudflare -- --adopt-existing --json`. The choice event exits 2 with `data.resumeWith` set to that flag. **`--yes` alone never adopts**: it suppresses questions, not consequences, so an unattended run that should adopt must pass `--adopt-existing` explicitly. Leaving it out is not an error, it is the safe default.

After adoption, Settings states both halves, because you need to know where each library is:

> Your cloud library already had 1,284 references, so Snip switched to it. **This Mac's library (312 references) is kept and was not copied.**

The local library is listed as **This Mac's library · 312 references**, with the subtitle **Kept on this Mac. Not copied to the cloud.** It has exactly one action, **Switch back to it**, which detaches this Mac and returns to the local library. It is not a snapshot: there is no copy to restore, so it offers no Restore and no Delete, and Snip never offers to delete your only local library from a status row. Before it runs, the action says what stays: **Changes made in your cloud library stay there. This Mac goes back to its own library.**

The owner link on an adopted library signs in as the **same owner** and adds this device's passkey. It never replaces or deletes a passkey that was already there, so a re-enabled install keeps every device it had. Adding a device that already has a passkey shows **You already added a passkey on this device.**

### When the account has something else

A Worker named `snip` that does not look like Snip is refused, before anything is created:

> This account has a Worker called `snip` that is not a Snip library. Snip keeps one library per account; rename or delete it, or choose another account.

That refusal is exit 4 with `code: "FOREIGN_SNIP"` and `retryable: false`: repeating the command cannot help. Rename or delete the Worker in the Cloudflare dashboard, or choose another account.

There is no replace option and no second Worker name. The name is the address your passkey and agent connections are bound to, so it cannot vary per install.

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

Snip records the Worker version it deployed. If the deployed Worker no longer matches that record, Snip reports the deployment as changed outside Snip and asks you to deploy again; it does not redeploy on its own, because someone may have changed the Worker deliberately.

To do it by hand, apply migrations before deploying:

```bash
npm run setup:cloudflare -- migrate --json
npm run setup:cloudflare -- deploy --json
```

## If the cloud library can't be reached

If the Worker is deleted in the Cloudflare dashboard, the account changes, or the URL stops resolving, Snip says **This Mac's cloud library can't be reached** and offers the snapshot or a new enable. It does not quietly open the empty local library instead.

## Debugging a setup

The supported ways to turn on cloud mode are **Settings → Cloud** and the CLI. Both run the same engine, which records the install in `.snip/cloud.json`; only the engine writes there. A Worker deployed by hand is not adopted by Snip.app, because the app would have no record of owning it.

When a setup stops:

```bash
npm run setup:cloudflare -- status --json          # mode, URL, account, snapshot, last error
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
