# Public site (usesnip.dev)

Only the maintainer needs this. Self-hosted copies never deploy the public site. Back to the [README](../README.md).


`web/` also builds the public site: the landing page and setup guide as static files, with GitHub CTAs instead of sign-in and no API behind them. It deploys as its own Worker, `snip-site` (`web/site/`), separate from the app Worker, and binds the custom domains `usesnip.dev` and `www.usesnip.dev` (www redirects to the apex). The build adds per-page titles, descriptions, canonical URLs, Open Graph tags, `og.png`, `robots.txt`, `sitemap.xml` and a 404 page.

```bash
cd web
npm run build:site      # writes dist-site/
npm run deploy:site     # needs `npx wrangler login` on an account that owns the usesnip.dev zone
```

Self-hosted copies don't need any of this; `npm run deploy` is still the only deploy for your own gallery.
