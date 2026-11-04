# Publishing Snip for macOS

Snip ships only for Apple Silicon on macOS 14 or later. The local `build.mjs` launcher remains useful for development; `release.mjs` creates an independent bundle containing the web app, capture engine, Node 24 and Chromium. Both use the approved golden app icon in `assets/Snip.icns`.

## Before enabling updates

1. Enroll in the Apple Developer Program and create a **Developer ID Application** certificate. Keep the same team and application identity (`dev.snip.desktop`) across releases.
2. Arrange notarization using an Apple ID and app-specific password, or a local notary keychain profile.
3. Explicitly approve publishing signed releases. The repository is public (v0.1.0 was a source-only release). The updater does not embed a GitHub token and cannot read private releases. The release build fails when unauthenticated public access is unavailable; it never changes repository visibility.
4. Configure GitHub Actions secrets: `MACOS_CERTIFICATE_BASE64` (exported signing certificate and private key, base64 encoded), `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Use GitHub's secrets UI, not source files or chat.

## Build and review a release

Set `desktop/package.json` and the root entry in `desktop/package-lock.json` to the same stable `X.Y.Z`. Merge the reviewed changes, create the matching `vX.Y.Z` tag, and manually run **Build draft macOS release** for that version. It checks the tag/version, native architecture, public access and credentials; builds and tests; signs and notarizes; exercises the standalone bundle; and creates a **draft** GitHub release. Review its asset and notes before publishing. Drafts and prereleases are never offered as updates.

The asset name must be `Snip-X.Y.Z-darwin-arm64.zip`. The updater accepts only that exact repository/tag/architecture URL and valid SHA-256 digest and size from GitHub's release API. It supplies those to Electron's native Squirrel updater, which also verifies the new app against the current app's signing requirement. No custom replacement helper bypasses macOS checks.

For a local standalone test, obtain an official Node 24 macOS arm64 distribution from nodejs.org and verify its archive against that version's `SHASUMS256.txt`. Include `bin/node` and the original `LICENSE`; Homebrew binaries with external dynamic libraries are rejected.

```sh
npm ci
npm ci --prefix desktop
SNIP_NODE_DISTRIBUTION=/absolute/path/to/node-v24.x.y-darwin-arm64 node desktop/release.mjs --standalone
node desktop/scripts/release-smoke.cjs
```

`--standalone` is ad-hoc signed with updates disabled and must not be published. For a signed/notarized build use `--release`, `SNIP_SIGN_IDENTITY`, and either `APPLE_NOTARY_KEYCHAIN_PROFILE` or the Apple ID credentials above. Signing credentials are excluded from dependency/build subprocess environments. The first measured standalone bundle was approximately 1.5 GiB installed / 510 MiB zipped; allow several GiB of free build space for staging and caches. Native downloads stream to disk.

## Required first-release acceptance

The unsigned smoke proves bundled Node/Chromium can capture into external D1/R2 and reopen after the bundle moves. Unit tests prove ordering and failure handling. Neither proves a signed update between real releases.

Before public rollout, install signed/notarized version A, create references, and publish higher stable signed version B. Verify discovery, explicit download, interrupted download recovery, **Later** followed by normal restart, and **Restart and update** during a long capture. Confirm A finishes capture before its API closes, B opens the same library/settings/route, signatures remain valid, and no old processes survive. Test first installation and importing a stopped source library. Preserve additive migrations and recovery backups when rolling back; replacing the app does not downgrade its database schema.

An imported project folder remains the library location: retain its config and `web/.wrangler/state`, or move the folder and locate it again. Never run another local server/capture agent against it concurrently. Successful pre-upgrade backups retain the latest three; incomplete recovery backups are not automatically removed.

Imported D1, R2 and KV storage identities are retained in the library's `.snip/storage-identities.json`, including local preview identities. Projects with remote storage bindings are rejected: release imports support local libraries only. Known `ALLOWED_GITHUB_LOGINS`, `PUBLIC_URL` and `DEV_LOGIN` settings are retained too, with `.dev.vars` taking precedence. New releases supply executable code and migrations without changing which existing storage they open. Keep `.snip` with the library's configuration and data when moving it.

Include disk-usage checks after failed signed installations in release acceptance. The native installer owns its pending app and recovery copies; do not delete those files while installation or recovery is in progress.

Automatic checks issue at most one metadata request every six hours and persist the cooldown across restarts. Downloads require user action. Once downloaded, Squirrel can install on the next normal quit/relaunch even after **Later**. Public updates and signed acceptance remain unavailable until the prerequisites and this check are completed.
