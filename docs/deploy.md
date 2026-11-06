# Deploying to Cloudflare

`npm run setup:cloudflare` does everything below in one go. This page explains what it does, how to do it by hand, and how to upgrade. Back to the [README](../README.md).

## What the setup does

1. Signs you in to Cloudflare (`wrangler login`) if needed.
2. Asks for your GitHub login (the only account allowed to sign in) and your workers.dev subdomain or a custom domain.
3. Finds or creates the D1 database `snip`, the KV namespace `OAUTH_KV` and the R2 bucket `snip-files`. R2 has to be enabled once in the Cloudflare dashboard (R2 → Get started) before it can create the bucket.
4. First preserves the local configuration in gitignored `web/wrangler.local.jsonc` (never overwriting an existing one), then writes `web/wrangler.deploy.jsonc`: the tracked `web/wrangler.jsonc` with your ids, URL and login filled in. It's gitignored, so `npm run update` and `git pull` never conflict with it.
5. Applies the database migrations and deploys. Deploy builds go to `web/dist-deploy/`, so they never replace the local build that Snip.app serves.
6. Asks for a GitHub OAuth app's Client ID and secret (it prints the Homepage and Callback URLs to use), generates `SESSION_SECRET` and `CAPTURE_TOKEN`, and stores all four as Worker secrets.
7. Points `capture/.env` at the Worker with the new `CAPTURE_TOKEN`. If `capture/.env` already points somewhere else (for example your local Snip.app), it asks first, and otherwise saves `capture/.env.cloudflare` for you to use with `SNIP_CAPTURE_ENV_FILE`.

Run it again any time: it keeps what's already set and only fills in what's missing.

## By hand

1. **GitHub OAuth app** (github.com → Settings → Developer settings → OAuth Apps → New):
   - Homepage URL: `https://snip.<your-subdomain>.workers.dev`
   - Callback URL: `https://snip.<your-subdomain>.workers.dev/auth/callback`
2. **Resources:**
   ```bash
   cd web
   npx wrangler d1 create snip
   npx wrangler kv namespace create OAUTH_KV
   npx wrangler r2 bucket create snip-files
   ```
3. **Config:** copy `web/wrangler.jsonc` to `web/wrangler.deploy.jsonc` and fill in `database_id`, the KV `id`, `PUBLIC_URL` and `ALLOWED_GITHUB_LOGINS`. Nobody can sign in while `ALLOWED_GITHUB_LOGINS` is empty or still `your-github-login`.
4. **Secrets** (`openssl rand -hex 32` for the last two):
   ```bash
   npx wrangler secret put GITHUB_CLIENT_ID --config wrangler.deploy.jsonc
   npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.deploy.jsonc
   npx wrangler secret put SESSION_SECRET --config wrangler.deploy.jsonc
   npx wrangler secret put CAPTURE_TOKEN --config wrangler.deploy.jsonc
   ```
5. **Migrate and deploy** from the repository root: `npm run db:migrate:remote`, then `npm run deploy`.
6. **Capture agent:** set `SNIP_URL` and the same `CAPTURE_TOKEN` in `capture/.env`, then `npm run capture`.

## Upgrading

1. Stop every capture agent gracefully and let in-flight captures finish.
2. `git pull`, then `npm install` if dependencies changed.
3. `npm run db:migrate:remote` **before** deploying, so the new Worker never runs against an old schema.
4. `npm run deploy`.
5. Update and restart every capture agent. This release requires capture protocol 3; protocol 2 agents cannot claim jobs or upload results. The Worker rejects agents that are too old (HTTP 426) before they can claim a job.

Existing captures and saved files are kept across upgrades.

**OAuth cost controls:** copy the new `ratelimits` block from `web/wrangler.jsonc` into your existing `web/wrangler.deploy.jsonc` before deploying this Worker. Missing hosted bindings return 503 on the protected sign-in/OAuth endpoints. Setup can regenerate the deploy config while keeping your resource IDs, URL and logins, but resets other custom configuration. Workers Paid users can opt into the commented 250 ms CPU limit; leave it commented on Free. Follow [Cloudflare cost controls](cloudflare-cost-controls.md) for the exact migration, threshold tuning and $5/$10/$25 billing-alert setup. These are per-operation protections and notifications, not a spending cap.

**Installed before `wrangler.deploy.jsonc` existed?** If you deployed by editing `web/wrangler.jsonc`, run `npm run setup:cloudflare` once. It preserves your original config in `web/wrangler.local.jsonc` for local development, migrations and Snip.app, and copies your hosted ids, URL and login into `web/wrangler.deploy.jsonc`. Only after setup confirms the local config was preserved, run `git checkout web/wrangler.jsonc` so `npm run update` stops reporting local edits. `npm run doctor` reminds you if you forget. Keep `wrangler.local.jsonc` with the local library; do not replace its storage IDs with hosted IDs. It is a full local configuration, so carry upstream configuration changes into it when needed while preserving its storage identities.

**ALLOWED_GITHUB_LOGINS** now ships empty (`your-github-login`) and sign-in is refused until it is set. Make sure your deploy config has your login before you deploy this version, or you'll see "This Snip instance has no allowed GitHub logins yet."

## Free-tier headroom

R2 gives 10 GB (roughly 1,500 to 3,000 captured pages, depending on page length and GIFs), D1 5 GB, Workers 100k requests a day. The account menu shows how much of the R2 free tier you're using.
