# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through [GitHub's vulnerability reporting](https://github.com/MaxChen04/Snip/security/advisories/new). Include what you found, how to reproduce it and what an attacker could do with it. You'll get a reply within a week.

## Supported versions

Only the latest commit on `main` and the latest release get fixes. Snip is self-hosted, so update your copy with `npm run update` (local) or by redeploying (Cloudflare).

## How Snip is meant to be deployed

Knowing the trust model helps tell a bug from a configuration choice:

- **One owner per instance.** Only the GitHub logins in `ALLOWED_GITHUB_LOGINS` can sign in, and nobody can until it's set.
- **`DEV_LOGIN` is for localhost only.** It skips GitHub login when the request is to `localhost` or `127.0.0.1`. Never set it on a deployed Worker.
- **The capture agent runs on your machine.** It refuses private-network URLs unless you set `ALLOW_PRIVATE_URLS=true` in `capture/.env`.
- **MCP clients** sign in through GitHub and an explicit consent screen; their tokens last 7 days. File URLs they receive are signed and expire after 24 hours.
- **Captured HTML** is served with a sandboxing CSP and no scripts.
