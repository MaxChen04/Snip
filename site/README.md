# Snip site

Static landing page for Snip (`public/`: plain HTML, CSS and a little JS, no build step).

```bash
cd site
npx wrangler dev        # preview on localhost
npx wrangler deploy     # publishes to snip-site.<your-subdomain>.workers.dev
```

The calls to action link to the GitHub repo, so the repo must be public before the site goes live.
