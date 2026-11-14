# Snip: landing and deployment plan

Updated 2026-11-13. These are review candidates, not a merged or deployed release.

## Durable review locations

| Candidate | GitHub | Role |
| --- | --- | --- |
| CLA prerequisites | [PR #65](https://github.com/MaxChen04/Snip/pull/65), [PR #68](https://github.com/MaxChen04/Snip/pull/68) → `main` | Allow the exact linked `claude` login and unlinked `Claude` fallback on maintainer-owned PRs before checking the release stack |
| A | [PR #63](https://github.com/MaxChen04/Snip/pull/63), `codex/snip-release-hardening` → `main` | The `sharp-ramanujan` hardening baseline plus capture, browser CI and explicit cloud-update fixes |
| B | [PR #64](https://github.com/MaxChen04/Snip/pull/64), `codex/snip-integration-candidate` → A | Reconciled #57, #59, #58, #60 and #61; the narrow #62 spring-easing correction |

The work originally existed in an isolated session's filesystem. Both branches are now pushed; a different machine should fetch these branches rather than look for `/tmp` paths. Use this document, [cloud deployment instructions](deploy.md#updating-a-cloud-install), and the [Mac release guide](../desktop/RELEASING.md) from GitHub or the fetched checkout.

## A requires a large-change review

The original baseline is 176 commits, 192 files and roughly 13,500 added lines. It was not on main and had no PR. #63 is deliberately a draft release integration, not a routine small patch. Review it by subsystem and retain evidence for each:

- Capture/data: protocol 4, per-claim leases, stale-write rejection, checkpoints, cancellation, page warnings and thumbnails.
- UI: gallery/board changes, viewer focus and errors, Settings loading and recovery.
- Cloud/identity: retry/resume, read-only preflight, account selection and nonce-bound owner sign-in.
- Upgrades: capture drain; explicit packaged cloud update; failure/cancel keeps capture paused in the current session; verified success resumes it.
- Delivery: browser tests in CI, native runtime/package checks, and the installation/update journey.

The original `sharp-ramanujan` branch does not have **Update cloud library**. That action is a follow-up commit in A (`2fc5623`). The capture and CI fixes are also follow-up commits, not claims about what already existed upstream.

## Exact merge strategy

1. Land the small CLA prerequisites #65 and #68, bring main into A and A into B, then require fresh CLA and application checks on both heads. `pull_request_target` runs trusted base code, so an allowlist change sitting only in a release PR cannot clear its own check. The live run showed that GitHub resolves the imported commits to the lowercase account `claude`; `Claude` alone did not match. No CLA signature is fabricated, and the exact-identity exemption applies only to MaxChen04-owned PRs. Validate A on its own and B as the combined candidate; keep both draft until the outstanding gates below are satisfied.
2. Merge A using an explicit command-line merge method, not the browser's default button. The repository permits merge commits even though its recent history uses squash merges. This is an explicit exception for this stack.
3. Retarget B to main, inspect the resulting diff, update from main if needed, and rerun affected checks on the actual result. It must contain the features, not replay the hardening baseline. Merge B with a merge commit as well.
4. Confirm the final main commit passes checks before selecting a stable release tag. Only then close or mark the old feature PRs superseded; do not merge them independently. #62 has already been converted to draft to prevent accidentally landing its incompatible overlapping changes.

After approval and green checks, resolve and inspect each current head, then use an explicit method and head-match guard:

```sh
gh pr merge 63 --repo MaxChen04/Snip --merge --match-head-commit <reviewed-A-SHA>
# Retarget and validate B against main before running the second command.
gh pr merge 64 --repo MaxChen04/Snip --merge --match-head-commit <reviewed-B-SHA>
```

These are the planned landing commands, not commands already executed. No repository-wide squash setting or branch-protection rule has been changed.

If A is squash-merged instead, **stop before retargeting/landing B**. Reconstruct B's net feature diff on the resulting main (or carefully rebase the integration history), compare the resulting tree with the tested combined candidate, and rerun validation. An ordinary retarget, or a blind rebase of this merge-rich branch, is not sufficient.

An A-only nightly is acceptable if A passes independently. The 10:23 UTC nightly schedule is not a reason to rush B. Stable publication remains a separate action after both land.

## Migration identity and existing libraries

Preserve these exact filenames:

| A | B |
| --- | --- |
| `0016_stale_reclaims.sql` | `0016_page_text.sql` |
| `0017_board_item_z.sql` | `0017_style_parts.sql` |
| `0018_capture_lease.sql`, `0019_page_warnings.sql`, `0020_agent_refused.sql` | |

Wrangler records the **complete filename** in `d1_migrations.name` and compares that value to the migration files. Equal numeric prefixes are not an identity collision. The two B migrations are independent of A's schema additions; their relative application orders need proof, not cosmetic renumbering.

Do not rename applied files to `0021_page_text.sql` / `0022_style_parts.sql`: Wrangler would see new names and try to run their `CREATE TABLE` / `ALTER TABLE` statements again. The history rehearsal includes this negative case. Start future, genuinely new migrations above the highest existing prefix.

Reproduce the local D1 check using the installed Wrangler, rather than an imitation of its ledger logic:

```sh
npm ci
node qa/migration-history.mjs
```

It uses only disposable local D1 databases. It checks a fresh library, A first, #58 first, #60 first, and both feature migrations first; preserves a seeded note/page and section-label backfill; verifies every filename is recorded exactly once; and checks a second apply is a no-op. It also verifies foreign keys. D1 does not expose SQLite's `PRAGMA integrity_check`, so the script does not claim that check ran. Hosted D1 deployment is a separate acceptance gate.

Before upgrading an actual existing library, drain its capture worker, preserve a recoverable backup, and read `SELECT name FROM d1_migrations ORDER BY id` using that library's recorded config/storage identity. Confirm whether #58/#60 already ran. If renamed aliases or unexpected schema/history combinations exist, stop and reconcile that specific history; do not delete ledger entries or rerun SQL blindly. Run the deployment rehearsal against an A-only library and a library that already has the original feature filenames.

## #62 disposition

Both cloud setup corrections are already in A:

- `desktop/cloud-engine.cjs` → `setupFlags` forwards `options.account` into `--account`, including retries. `desktop/tests/cloud-engine.test.cjs` tests the exact answered key.
- `desktop/provision/commands.cjs` executes setup preflight directly under `--check`; `desktop/provision/cli.cjs` only records errors while holding the operation lock. `desktop/tests/provision.test.cjs` verifies failed setup/status checks write no state.

These fixes are preserved, not dropped. The long-spring easing correction is included in B. Keep #61's single bounded motion-profile contract and retain `useCloud.loaded` plus `engineAvailable`, which current Settings uses. #62's shader samples, motion-asset URLs, extra technology/scroll detections and optional cleanup remain deferred follow-ups; they are not represented as delivered by B.

## Validation and rollout gates

Before landing: independent subsystem review, typecheck/build, core/desktop tests, gallery/Settings browser tests and native Mac package checks on the actual candidate. Exercise capture → viewer → note/view/section selection → copied prompt → authenticated MCP, then recapture and resolve the previous selection. Exercise crash/reclaim, pause/resume and root/child HTTP errors.

Before stable publication: capture representative live sites from an environment permitted to reach them, rehearse the existing-library upgrade on a disposable Cloudflare deployment, and verify the packaged app against its matching Worker. Prior live-site checks were blocked by the session's network policy; fixture success does not satisfy that gate.

Deploy in this order: drain/pause capture → backup/history check → pending migrations → matching Worker → verify connectivity and owner sign-in → resume capture. Source installs use `npm run update`; installed packages explicitly use **Settings → Cloud → Update cloud library**. Failed/cancelled updates stay paused for the current session; relaunch uses the existing protocol guard.

After the pilot passes, confirm Apple signing/notarization configuration, set matching package versions, and tag the approved main commit. The workflow builds a draft stable release. Review and test the actual archive and signed update path before broad publication. Preserve backups and schema on rollback; restoring application code alone does not undo migrations. Keep capture paused until application and Worker versions are compatible.

## Evidence and current limitations

The two cloud-engine/provisioning suites were rerun after publication: **127 passed, zero failed**, including both #62 fixes. CI found a separate setup-order error: the native job ran browser-dependent desktop tests before installing Chromium. A now installs Chromium first; the updated native CI result is still required.

The local history rehearsal passed all **five histories using Wrangler 4.157.0 / local D1**, with all 22 migration filenames recorded once, preserved data/backfill, no foreign-key violations, and a no-op repeat apply. Renaming already-applied feature migrations to 0021/0022 failed as expected without changing the recorded history. This is local D1 evidence, not hosted-deployment proof.

The distinction between test steps matters: at A `a725e1a`, **`test:app` passed but `test:desktop` failed**. The native smoke waited for a claim, then quit before navigation, and called Playwright's disposed application handle after exit. The corrected fixture waits for a real page request, holds its response through the shutdown interval, retains the native child handle before close, and still requires a persisted ready capture. The packaged macOS run must prove this fix; Linux lifecycle tests alone do not.

CI also found browser interaction failures and a B-only migration-test fixture that excluded every `0017` file. The migration test now holds back only `0017_board_item_z.sql`, preserving the separate style-parts migration; its focused real-D1 test passes. A `e1be1af` and B `5d09396` subsequently passed their full core, browser and macOS jobs, including the corrected shutdown test and both standalone runtime checks. Fresh checks after the CLA/base updates remain landing gates. Representative live-site capture and signed Mac/hosted-cloud upgrade acceptance also remain pending. Nothing in this document authorizes bypassing those checks or claims deployment has happened.
