# Agent instructions

## macOS releases and local updates

For now, distributed macOS builds are **not notarized by Apple**. Snip Dev builds
are ad-hoc signed with native installation disabled: a versioned `beta-vX.Y.Z`
has update checks disabled, while a `nightly-v0.0.N` checks for updates and
offers a download that you install manually. Update releases locally through the
CLI. Revisit this guidance when Apple signing, notarization, and native updates
are configured and verified.

Before updating, identify the installed app, channel, and actual library. Quit
the app gracefully, let captures finish, and back up its profile/library and
current app bundle. Verify the new archive's version, identity, and checksum;
replace only the matching app bundle. Preserve credentials and storage
identities, keep Snip and Snip Dev separate, and do not overwrite dirty source
work or install through symlinks.

**Pending database migrations must run as part of every update.**

- For a source-backed local `Snip.app`, use `npm run update` from its clean,
  configured `main` checkout (`npm run update -- --full` reruns the steps even
  when already current). It backs up and applies pending migrations before
  rebuilding/relaunching. To run only local migrations, stop the app and
  its terminal services first, then use `npm run db:migrate:local -w web` from
  that same checkout.
- For a standalone release using a local library, update the bundle via CLI, then
  relaunch it. `desktop/local-server.cjs` backs up and applies pending migrations
  to the saved library before starting its API. Verify startup, library counts,
  and configuration preservation before calling the update complete. Running
  the source migration command in another checkout does not migrate this library.

See [desktop/RELEASING.md](desktop/RELEASING.md) for release and channel details.
