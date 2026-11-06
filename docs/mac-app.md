# Snip.app (Apple Silicon Mac)

A clickable menu-bar app that runs your local Snip (gallery, local Worker API and capture agent) without a terminal. Back to the [README](../README.md).

## Build it

On **Apple Silicon with macOS 14 or later**, once local development works, build a clickable **Snip.app**. Use native arm64 Node.js 22.18+ or 24.11+; Intel and Rosetta are unsupported.

```bash
npm run app        # builds Snip.app and installs it in /Applications
```

The normal app serves the built gallery and the existing local Worker API with file watching and the inspector disabled. It uses the same `web/.dev.vars` and `web/.wrangler/state` as local development. Configure `capture/.env` with `SNIP_URL=http://localhost:5173` and the same `CAPTURE_TOKEN` as `web/.dev.vars`.

The menu bar shows whether capture is ready, busy, or disconnected. **Quit Snip** and **Stop web app** let capture finish before stopping its local API. **Force quit** explicitly interrupts unfinished work. Closing the window keeps capture available; the hidden gallery is released after two minutes and restores its selection, search and scroll state when reopened. Chromium loads only for an actual capture and closes after two idle minutes. Healthy empty-queue polling backs off to 30 seconds; adding or re-capturing from the app wakes it immediately. References queued elsewhere may wait up to that interval. Failed connections use retry backoff capped at one minute.

Service logs are capped at three 2 MiB files per service (12 MiB total), including backups; duplicate Wrangler debug-file logging is disabled. Electron's disposable HTTP disk cache has a 64 MiB budget. Captured library assets are retained until you delete them; idle cleanup does not delete your library. The hidden or minimized gallery is released after the grace period, unless a dialog has unfinished input. Minimized snapshot viewers unload their document and reload it when restored. Adjust `BROWSER_IDLE_SECONDS` in `capture/.env` for capture browser retention. Set `SNIP_WINDOW_IDLE_SECONDS` when launching Electron to change the window grace period (`0` disables window release).

The app runs this repo in place; `npm run update` keeps its web build and the app itself current. Rebuild the app manually only after moving the repo. It is ad-hoc signed for your own Mac and is not notarized for distribution. `npm run app:dev` uses Vite with hot reload for development (install desktop dependencies first with `npm ci --prefix desktop`). The installer verifies an existing app's identity, stages and verifies the new copy, and restores the old app if replacement fails. For a build without installation: `npm run build --prefix desktop -- --no-install`; `--out DIR` and `--install-dir DIR` support isolated builds and tests.

## Release app and updates

Signed release builds contain their own web app, capture engine, Node.js and Chromium. They check for **published stable releases** at most once every six hours, including after sleep, and expose **Check for updates** in the Snip and menu-bar menus. Downloads begin only when you choose **Download update**. **Restart and update** lets an active capture finish before stopping its API and installing. A downloaded update can also apply on the next normal quit/relaunch. Failed downloads leave the running version intact; the native macOS updater verifies the archive digest, size and signing identity.

Your library and credentials stay outside the app. On first launch, choose an existing Snip project folder or create a new library in Snip's Application Support directory. Stop and drain any separate development server and capture agent before using an existing library; never run them concurrently against the same library. The chosen project folder remains the data location even though release code runs from the app: keep its configuration, `.snip` storage identity record and `web/.wrangler/state`. Imported database, file and OAuth-storage identities stay attached to that library across releases. If its folder moves, **Retry setup** offers to locate it again. Upgrades apply local D1 migrations before serving the app. The latest three successful pre-upgrade database backups are kept under the library's `backups/`; failed-upgrade backups remain for manual recovery. An upgrade failure stops startup and shows the backup location. A bounded private cache restores your reference route and selection after a graceful restart.

**No signed app has been released yet.** The repository is public and v0.1.0 is a source-only release, but there is no Apple Developer signing identity, so build Snip.app yourself with `npm run app`. Local/ad-hoc builds update from `main` with `npm run update` instead (see [Updating](../README.md#updating)). The first signed release must be installed manually; later signed releases can update it. Publishing does not happen on a merge. See [the release guide](../desktop/RELEASING.md) for signing setup, draft release review and the two-version update acceptance check.
