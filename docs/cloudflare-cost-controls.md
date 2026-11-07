# Cloudflare cost controls

Snip protects hosted sign-in and MCP OAuth setup from repeated expensive requests before the OAuth provider reads or writes KV or contacts GitHub. Repeated attempts receive HTTP `429` with `Retry-After: 60`; normal clients can retry after a minute. There is no browser challenge in the MCP flow.

These controls reduce avoidable work. They do **not** set a maximum Cloudflare bill.

## OAuth operation limits

The application Worker uses Cloudflare's native [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). The tracked `web/wrangler.jsonc` configures:

| Binding | Endpoint | Default threshold per client IP, per location |
| --- | --- | --- |
| `OAUTH_REGISTER_LIMITER` | `/register` | 10 attempts / 60 seconds |
| `OAUTH_TOKEN_LIMITER` | `/token` | 60 attempts / 60 seconds |
| `OAUTH_LOGIN_LIMITER` | `/auth/login`, `/auth/callback`, `/auth/passkey/login/options`, `/auth/passkey/login/verify`, `/auth/owner` | 30 attempts / 60 seconds for each endpoint |
| `OAUTH_AUTHORIZE_LIMITER` | `/authorize` (GET and POST share a bucket) | 30 attempts / 60 seconds |

These are starting thresholds for a personal instance, not measured capacity limits. A typical MCP connection registers once, completes sign-in and consent, then exchanges a code for tokens. A token refresh shares the token endpoint's higher allowance. Change each binding's `simple.limit` in your deploy config to accommodate your actual number of clients. `simple.period` must be `10` or `60`; the response always asks clients to wait a conservative 60 seconds.

Before authentication there is no trustworthy account identity. The key uses Cloudflare's `CF-Connecting-IP` header and the exact endpoint; arbitrary query parameters, submitted client IDs and forwarding headers cannot create more buckets. People sharing a network or privacy proxy also share these limits. Raise the relevant threshold if legitimate sign-ins or reconnects receive 429s. Missing IP headers share an `unknown` bucket instead of bypassing the guard.

Cloudflare's counters are **approximate and separate in each location**. Counts synchronize in the background, so even one location can admit more than the configured threshold. A caller using multiple IPs or locations can make more requests. A blocked request still invokes the Worker and counts toward Worker request usage; the guard avoids the subsequent KV, GitHub and application work. A strict worldwide limit would need durable coordination, with its own cost and availability tradeoffs.

Each `namespace_id` is an account-wide identifier, not a resource to provision. The four supplied numbers must not collide with other rate-limited applications on your account. Keep them distinct; choose other positive integer strings if necessary.

The guard does not throttle discovery, OPTIONS preflights, `/mcp`, galleries, signed file downloads, the capture agent, or static assets. Existing authentication still applies. Localhost, `127.0.0.1` and IPv6 loopback requests bypass these hosted guards, so desktop installs and existing local configurations continue to work. Hosted OAuth requests fail with `503` and `Retry-After: 60` if a needed binding is missing or its check fails. Upgrade the config together with the Worker.

## Apply the configuration to an existing install

Cloud deploys (`npm run update` in cloud mode, `npm run setup:cloudflare -- deploy`, or Settings) build the Worker config from the tracked `web/wrangler.jsonc` every time, so the `ratelimits` bindings ship with the next deploy. There is nothing to copy. See [Cloud mode](deploy.md#updating-a-cloud-install).

1. Update and deploy the Worker as usual. Migrations run before the deploy.
2. Keep any `web/wrangler.local.jsonc` with its existing local storage identities. No new bindings are required for loopback use. Do not copy hosted storage IDs into the local config.
3. Test a browser sign-in and an MCP connection, including token refresh, after deploying.

`web/wrangler.deploy.jsonc` from an older install is no longer used for deploys; setup only reads it to recognise that install. Thresholds or other settings you customised there must be made in `web/wrangler.jsonc` instead.

No dashboard settings or deployments are performed by these source changes.

## CPU time per request

Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) give Free accounts 10 ms of CPU per HTTP request. Custom CPU limits require the Paid/Standard usage model; adding `limits.cpu_ms` to a Free deployment is unsupported. The tracked template therefore leaves the following block commented out:

```jsonc
"limits": { "cpu_ms": 250 },
```

**For Workers Paid:** uncomment that block in `web/wrangler.jsonc` before the next deploy to opt into a 250 ms per-request ceiling, instead of the 30,000 ms paid default. Every deploy builds from that file, so the change has to stay there (`npm run update` will report it as a local edit). Keep it commented out for Workers Free. This does not subscribe you to a plan, change billing alerts or set an account spending cap.

CPU measures execution, not time waiting for KV, D1, R2 or GitHub. A slow network response can take seconds without using 250 ms of CPU. Cloudflare allows some occasional execution flexibility; repeated excess CPU produces `exceededCpu`/Error 1102 and interrupts the request. Check Worker Metrics for these errors and CPU percentiles after deployment, especially with large captures or legacy full MCP reads, and adjust the paid ceiling if legitimate requests need more headroom. Local development does not enforce this deployed limit. See [Wrangler limits configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#limits).

The 250 ms suggestion is a conservative starting point, not a hosted performance guarantee. A local representative probe exercises `get_page` with the maximum 900,000-byte inline image, 40,000 characters of returned HTML and 200 color tokens, including response serialization. On Node v25.9.0, the 1,282,428-byte response used 92.8 ms of process CPU on the first request; 30 warmed requests had a 24.1 ms median, 33.8 ms p95 and 40.9 ms maximum. The suggested ceiling leaves more than twice that observed first-request CPU and is 120 times below the paid default. These process measurements include local runtime overhead and cannot establish production workerd CPU percentiles; verify actual Cloudflare metrics before tightening the limit.

## Billing alerts

On a Pay-as-you-go account, open **Manage Account → Billing → Billable Usage → Create budget alert**. Add separate thresholds such as **$5, $10 and $25**, with your email as recipient. Check existing alerts first: Cloudflare may already have created a default $10 alert. These thresholds cover account-wide **usage-based charges**, including other applications on that account; they exclude recurring subscriptions such as the Workers Paid plan fee. See [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) and the [default-alert announcement](https://developers.cloudflare.com/changelog/product/billing/).

Alerts are evaluated daily for prior-day usage, not in real time. They notify when cumulative usage spend crosses a threshold and reset with the billing period. They **do not stop requests, storage growth or charges**. At an unexpected alert, inspect the product breakdown in Billable Usage and Worker metrics to find whether requests, CPU, KV operations, D1 or R2 caused the increase. These instructions do not create alerts for you.

## Logging and remaining storage work

This change adds no per-request log writes or persistent observability configuration. Use existing Worker metrics first. If you enable Workers Logs for a bounded investigation, choose a low `head_sampling_rate` such as `0.01` (1%), check current [Workers Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing), and remove or revisit the setting after diagnosis. Sampled logs are evidence of behavior, not complete usage accounting.

OAuth operation limits and a paid CPU ceiling do not limit R2 storage growth. A bucket listing can be paginated or incomplete; a partial listing or a cached account-menu estimate is not safe evidence for admitting an upload under a global storage quota. Exact storage limits need durable accounting across concurrent uploads, overwrites, failed captures, cleanup and reconciliation. Per-upload size validation would bound one request's body, but would still not cap total storage or R2 operations; it is separate work.
