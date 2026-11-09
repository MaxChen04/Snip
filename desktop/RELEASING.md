# Publishing Snip for macOS

Snip ships only for Apple Silicon on macOS 14 or later. The local `build.mjs` launcher remains useful for development; `release.mjs` creates an independent bundle containing the web app, capture engine, Node 24 and Chromium. Stable builds use the golden icon in `assets/Snip.icns`; Snip Dev uses the blueprint icon in `assets/Snip-dev.icns`.

## Stable and Snip Dev in one repository

`main` is the integration branch. Stable releases select an approved commit with
a `vX.Y.Z` tag; there is no long-lived `dev` branch. Pushing that tag builds a
signed **draft** stable release. The tag must belong to `main` and match the
desktop package version. Publishing the draft remains a deliberate release step.
The manual stable workflow is also available for an existing tag.

Snip Dev is a separate app, not a renamed stable installation:

| | Snip | Snip Dev |
| --- | --- | --- |
| App / icon | `Snip.app` / gold | `Snip Dev.app` / blue blueprint |
| Bundle ID | `dev.snip.desktop` | `dev.snip.desktop.nightly` |
| Update source | Published stable `vX.Y.Z` release | Published `nightly-v0.0.N` prerelease |
| Default port | 5173 | 5175 |
| Library | Existing stable library | `~/Library/Application Support/Snip Dev/library` |

Snip Dev has its own Electron profile, cookies, settings, logs and update cache.
It creates a fresh local test library, with new credentials, on first launch and
does not import or follow a stable library pointer. It retains the test library
across updates. Existing source builds of Snip keep their current library behavior.
Cloud settings start empty too; only explicitly connect a separate test deployment.

The **Snip Dev nightly** workflow runs from `main` daily at **10:23 UTC** (02:23
Pacific in winter, 03:23 in summer), or manually on `main`. Tests, capture smoke
checks and bundle verification must pass before publishing. GitHub schedules
may be delayed and only run after the workflow is on the default branch.
Each run uses version `0.0.<workflow run number>` and an immutable
`nightly-v0.0.N` tag, with `Snip-Dev-0.0.N-darwin-arm64.zip`. Nightlies are
prereleases and never become GitHub's latest stable release. Do not reset this
workflow's run-number sequence or overwrite existing nightly tags/assets. If a
run already created a draft before failing publication, dispatch a fresh run;
the old draft is not offered to clients.

### Without Apple Developer credentials

When none of the six Apple secrets below are configured, nightlies are ad-hoc
signed, with native installation disabled. Snip Dev checks for newer nightlies
on launch (after a short delay) and at most every six hours, and offers a download.
Download and unzip, quit Snip Dev, and replace **Snip Dev.app** in Applications.
The test library stays outside the app. macOS may require allowing the download
in **System Settings → Privacy & Security**. Do not replace **Snip.app**.

Once all six secrets are configured, the same nightly workflow signs and notarizes
builds. A partial configuration fails instead of silently producing an unsigned
build. Install the first Developer ID signed Snip Dev manually; subsequent signed
versions can use the native updater. Downloads and restarts require a user action,
and active captures finish before installation. A real signed A→B update remains
a required acceptance check before claiming native updates have been proven.

### Local development

```sh
npm ci
npm run app:dev:build   # build/install a repo-backed Snip Dev.app with test data
npm run app:dev         # hot reload, same isolated test library
```

Quit the installed Snip Dev before starting hot reload; they deliberately share
the Snip Dev profile and single-instance lock. The source launcher has no native
binary updater; rebuild it or manually install a standalone nightly. Stable and
Dev can run alongside each other. `SNIP_DESKTOP_PROFILE` and `SNIP_DESKTOP_PORT`
remain explicit overrides for disposable acceptance tests, not channel switches.

For a self-contained local nightly, supply an official verified Node 24 ARM64
distribution as described below and run:

```sh
SNIP_NIGHTLY_BUILD=1 node desktop/release.mjs --standalone --nightly
node desktop/scripts/release-smoke.cjs 'desktop/dist/Snip Dev-darwin-arm64/Snip Dev.app'
```

Use `--release --nightly` for a Developer ID signed nightly. Stable
`--standalone` builds remain acceptance fixtures and must not be published.

## Before enabling updates

1. Enroll in the Apple Developer Program and create a **Developer ID Application** certificate. Keep the same team and application identity (`dev.snip.desktop`) across releases.
2. Arrange notarization using an Apple ID and app-specific password, or a local notary keychain profile.
3. Explicitly approve publishing signed releases. The repository is public (v0.1.0 was a source-only release). The updater does not embed a GitHub token and cannot read private releases. The release build fails when unauthenticated public access is unavailable; it never changes repository visibility.
4. Configure GitHub Actions secrets: `MACOS_CERTIFICATE_BASE64` (exported signing certificate and private key, base64 encoded), `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Use GitHub's secrets UI, not source files or chat.

## Build and review a release

Set `desktop/package.json` and the root entry in `desktop/package-lock.json` to the same stable `X.Y.Z`. Merge the reviewed changes, create the matching `vX.Y.Z` tag, and manually run **Build draft macOS release** for that version. It checks the tag/version, native architecture, public access and credentials; builds and tests; signs and notarizes; exercises the standalone bundle; and creates a **draft** GitHub release. Review its asset and notes before publishing. Stable Snip never offers drafts or prereleases as updates; Snip Dev only offers published nightly prereleases.

The asset name must be `Snip-X.Y.Z-darwin-arm64.zip`. The updater accepts only that exact repository/tag/architecture URL and valid SHA-256 digest and size from GitHub's release API. It supplies those to Electron's native Squirrel updater, which also verifies the new app against the current app's signing requirement. No custom replacement helper bypasses macOS checks.

For a local standalone test, obtain an official Node 24 macOS arm64 distribution from nodejs.org and verify its archive against that version's `SHASUMS256.txt`. Include `bin/node` and the original `LICENSE`; Homebrew binaries with external dynamic libraries are rejected.

```sh
npm ci
npm ci --prefix desktop
SNIP_NODE_DISTRIBUTION=/absolute/path/to/node-v24.x.y-darwin-arm64 node desktop/release.mjs --standalone
node desktop/scripts/release-smoke.cjs
```

Stable `--standalone` is ad-hoc signed with updates disabled and must not be published. `--standalone --nightly` is the explicit manual-installation nightly channel described above. For a signed/notarized build use `--release`, `SNIP_SIGN_IDENTITY`, and either `APPLE_NOTARY_KEYCHAIN_PROFILE` or the Apple ID credentials above. Signing credentials are excluded from dependency/build subprocess environments. The first measured standalone bundle was approximately 1.5 GiB installed / 510 MiB zipped; allow several GiB of free build space for staging and caches. Native downloads stream to disk.

## Required first-release acceptance

The unsigned smoke proves bundled Node/Chromium can capture into external D1/R2 and reopen after the bundle moves. Unit tests prove ordering and failure handling. Neither proves a signed update between real releases.

Before public rollout, install signed/notarized version A, create references, and publish higher stable signed version B. Verify discovery, explicit download, interrupted download recovery, **Later** followed by normal restart, and **Restart and update** during a long capture. Confirm A finishes capture before its API closes, B opens the same library/settings/route, signatures remain valid, and no old processes survive. Test first installation and importing a stopped source library. Preserve additive migrations and recovery backups when rolling back; replacing the app does not downgrade its database schema.

An imported project folder remains the library location: retain its config and `web/.wrangler/state`, or move the folder and locate it again. Never run another local server/capture agent against it concurrently. Successful pre-upgrade backups retain the latest three; incomplete recovery backups are not automatically removed.

Imported D1, R2 and KV storage identities are retained in the library's `.snip/storage-identities.json`, including local preview identities. Projects with remote storage bindings are rejected: release imports support local libraries only. Known `ALLOWED_GITHUB_LOGINS`, `PUBLIC_URL` and `DEV_LOGIN` settings are retained too, with `.dev.vars` taking precedence. New releases supply executable code and migrations without changing which existing storage they open. Keep `.snip` with the library's configuration and data when moving it.

Include disk-usage checks after failed signed installations in release acceptance. The native installer owns its pending app and recovery copies; do not delete those files while installation or recovery is in progress.

Automatic update check cycles run at most every six hours and persist the cooldown across restarts; manual checks are available. Stable checks use one metadata request, while nightly discovery can page through up to 100 recent releases in five requests. Downloads require user action. Once downloaded, Squirrel can install on the next normal quit/relaunch even after **Later**. Native signed update acceptance remains unproven until the prerequisites and this check are completed; ad-hoc signed nightlies use manual installation.
