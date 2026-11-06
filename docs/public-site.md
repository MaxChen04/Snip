# Public site (usesnip.dev)

Only the maintainer needs this. Self-hosted copies never deploy the public site. Back to the [README](../README.md).

`web/` also builds the public site: the landing page and setup guide as static files, with GitHub CTAs instead of sign-in and no API behind them. It deploys as the assets-only `snip-site` project (`web/site/`), separate from the app Worker, and binds `usesnip.dev` and `www.usesnip.dev`. There is no site Worker script, asset binding or `run_worker_first`, including for unknown URLs. [Cloudflare serves static asset requests free and unlimited](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/); the site's previous script invoked a Worker for every request. Workers Logs are disabled for this project.

The build adds per-page titles, descriptions, canonical URLs, Open Graph tags, `og.png`, `robots.txt`, `sitemap.xml` and a 404 page. `/guide` keeps its own metadata, trailing slashes redirect to the clean URL, and missing pages return the custom page with HTTP 404. There is no app API on this domain.

`web/site/_headers` is copied only into `dist-site/`. Cloudflare's [native header rules](https://developers.cloudflare.com/workers/static-assets/headers/) preserve the site's security headers without running code. Hashed `/assets/*` files cache for one year with `immutable`; unversioned `/landing/*` images and `og.png` cache for one day. Repeat visits reuse those images, but an image replacement can take up to a day to reach returning visitors. HTML and the other unversioned files retain Cloudflare's default revalidation behavior. The self-hosted app's build and caching are separate.

Before deploying this change, configure and verify the `www` redirect in the Cloudflare zone. The static assets `_redirects` format [does not support domain-level redirects](https://developers.cloudflare.com/workers/static-assets/redirects/), so it cannot replace the old script's hostname check:

1. In the `usesnip.dev` zone, open **Rules → Redirect Rules** and create a **Single Redirect** using a wildcard pattern.
2. Set **Request URL** to `http*://www.usesnip.dev/*`, **Target URL** to `https://usesnip.dev/${2}`, **Status code** to **301**, and enable **Preserve query string**. The second wildcard is the path; the first matches the optional `s` in HTTPS. This follows Cloudflare's [HTTP-and-HTTPS redirect example](https://developers.cloudflare.com/rules/reference/page-rules-migration/).
3. Keep both custom domains in the site's Wrangler config. Confirm `www` has a proxied DNS record so the rule runs; the existing `www` custom domain supplies this. If migrating away from that custom domain separately, use Cloudflare's [documented proxied DNS setup](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#redirect-between-www-and-root-domain).
4. Before deploying, check both `http://www.usesnip.dev/guide?source=redirect-check` and `https://www.usesnip.dev/guide?source=redirect-check`: each must return `301` with `Location: https://usesnip.dev/guide?source=redirect-check`. Confirm the apex does not redirect back. Do not deploy the assets-only build until this zone rule is active; otherwise `www` will serve duplicate pages instead of redirecting.

The zone rule is a one-time dashboard prerequisite, not created by this repository or by `deploy:site`.

```bash
cd web
npm run build:site      # writes dist-site/
npm run deploy:site     # needs `npx wrangler login` on an account that owns the usesnip.dev zone
```

For a local smoke check, build first, then run `npx wrangler dev --config site/wrangler.jsonc --local`. Check `/`, `/guide`, `/guide/`, a missing path, one `/assets/` file, a `/landing/` image, and `/og.png`. Expect the security headers on asset responses, a 404 for unknown paths (including `/api/me`), the cache lifetimes above, and no application Worker script. The zone's `www` redirect cannot be tested by the local asset server; verify it on Cloudflare before rollout. After rollout, repeat the redirect and route checks against the live domain and confirm the site is serving asset traffic without script invocations in Cloudflare metrics.

Self-hosted copies don't need any of this; `npm run deploy` is still the only deploy for your own gallery.
