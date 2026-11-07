# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through [GitHub's vulnerability reporting](https://github.com/MaxChen04/Snip/security/advisories/new). Include what you found, how to reproduce it and what an attacker could do with it. You'll get a reply within a week.

## Supported versions

Only the latest commit on `main` and the latest release get fixes. Snip runs from your checkout by default, so update it with `npm run update`. In cloud mode that command also applies the remote migrations and redeploys the Worker.

## How Snip is meant to run

Knowing the trust model helps tell a bug from a configuration choice:

- **Local by default.** Snip.app runs the gallery and the API on your Mac, and D1, R2 and KV are files in the library folder. Nothing is uploaded unless you turn on cloud mode.
- **`DEV_LOGIN` is for localhost only.** It skips sign-in when the request is to `localhost` or `127.0.0.1`. Never set it on a deployed Worker.
- **Cloud mode is optional and yours.** A hosted Snip lives in your own Cloudflare account. The owner signs in with a passkey registered from a single-use owner link, or at `/sign-in` with a passkey already on the device. This version has one owner and passkeys are the only way in: setup never configures GitHub, and there is no allowlist to maintain. An install that already had `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `ALLOWED_GITHUB_LOGINS` configured keeps working, and only the logins on its allowlist get in.
- **Sessions and revocation.** Sessions are signed cookies that last 30 days. **Sign out all devices** bumps a per-install session epoch, which invalidates every browser session and the app's session at their next request. Passkeys stay registered, and agents connected over MCP keep their own tokens until those expire. Removing a single passkey is a separate action on `/passkeys`.
- **The capture agent runs on your machine.** It refuses private-network URLs unless you set `ALLOW_PRIVATE_URLS=true` in `capture/.env`.
- **MCP clients** sign in with the owner's passkey and then approve access through a consent screen; locally there is no sign-in, only the consent screen. Their tokens last 7 days. File URLs they receive are signed and expire after 24 hours.
- **Captured HTML** is served with a sandboxing CSP and no scripts.
