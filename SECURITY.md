# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through [GitHub's vulnerability reporting](https://github.com/MaxChen04/Snip/security/advisories/new). Include what you found, how to reproduce it and what an attacker could do with it. You'll get a reply within a week.

## Supported versions

Only the latest commit on `main` and the latest release get fixes. Snip runs from your checkout by default, so update it with `npm run update`. A cloud install also needs its Worker redeployed.

## How Snip is meant to run

Knowing the trust model helps tell a bug from a configuration choice:

- **Local by default.** Snip.app runs the gallery and the API on your Mac, and D1, R2 and KV are files in the library folder. Nothing is uploaded unless you turn on cloud mode.
- **`DEV_LOGIN` is for localhost only.** It replaces GitHub login when the request is to `localhost` or `127.0.0.1`. Never set it on a deployed Worker.
- **Cloud mode is optional and yours.** A hosted Snip lives in your own Cloudflare account, and only the GitHub logins in `ALLOWED_GITHUB_LOGINS` can sign in. Nobody can sign in until it's set.
- **The capture agent runs on your machine.** It refuses private-network URLs unless you set `ALLOW_PRIVATE_URLS=true` in `capture/.env`.
- **MCP clients** approve access through a consent screen; a hosted Snip sends them through GitHub login first. Their tokens last 7 days. File URLs they receive are signed and expire after 24 hours.
- **Captured HTML** is served with a sandboxing CSP and no scripts.
