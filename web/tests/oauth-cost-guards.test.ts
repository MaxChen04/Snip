import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { sign } from "../worker/auth"
import { applyMigrations } from "./helpers/d1"

// Use Wrangler's installed bundler to run the real entrypoint and OAuth provider in
// workerd. Node cannot import the provider's cloudflare:workers runtime module.
const { build } = createRequire(import.meta.resolve("wrangler"))("esbuild")

test("hosted OAuth guards reject before KV and preserve normal OAuth and local requests", async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("../worker", import.meta.url)),
      contents: `
        import worker from "./index.ts";
        export default { async fetch(request, env, ctx) {
          let kvCalls = 0;
          const keys = [];
          const mode = request.headers.get("x-test-guard-mode") || "allow";
          const limiter = { async limit({key}) {
            keys.push(key);
            if (mode === "error") throw new Error("limiter unavailable");
            return {success: mode !== "deny"};
          }};
          const guardedEnv = {...env};
          for (const name of ["OAUTH_REGISTER_LIMITER", "OAUTH_TOKEN_LIMITER", "OAUTH_LOGIN_LIMITER", "OAUTH_AUTHORIZE_LIMITER"]) {
            if (mode === "missing") delete guardedEnv[name];
            else if (mode !== "native") guardedEnv[name] = limiter;
          }
          guardedEnv.OAUTH_KV = Object.fromEntries(["get", "getWithMetadata", "put", "delete", "list"].map(name => [name, (...args) => {
            kvCalls++;
            return env.OAUTH_KV[name](...args);
          }]));
          const original = await worker.fetch(request, guardedEnv, ctx);
          const response = new Response(original.body, original);
          response.headers.set("x-test-kv-calls", String(kvCalls));
          response.headers.set("x-test-guard-keys", JSON.stringify(keys));
          return response;
        }};
      `,
    },
    bundle: true, write: false, format: "esm", platform: "browser",
    conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"],
  })
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"],
    kvNamespaces: ["OAUTH_KV"],
    // Sessions are checked against the owners table (sign out all devices).
    d1Databases: ["DB"],
    bindings: {
      PUBLIC_URL: "https://Snip.TEST/", ALLOWED_GITHUB_LOGINS: "alice", SESSION_SECRET: "test-secret",
      GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-client-secret",
    },
    ratelimits: {
      OAUTH_REGISTER_LIMITER: { namespace_id: "17431001", simple: { limit: 1, period: 60 } },
    },
  }))
  await applyMigrations(await mf.getD1Database("DB") as unknown as D1Database)
  try {
    const request = (path: string, method = "GET", mode = "allow", init: RequestInit = {}) => mf.dispatchFetch(`https://snip.test${path}`, {
      method, redirect: "manual", ...init, headers: { "cf-connecting-ip": "192.0.2.1", "x-test-guard-mode": mode, ...init.headers },
    })
    const registration = {
      client_name: "Snip test", redirect_uris: ["http://localhost:54321/callback"], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    }
    const register = (mode = "allow") => request("/register", "POST", mode, {
      headers: { "content-type": "application/json" }, body: JSON.stringify(registration),
    })

    await t.test("all expensive OAuth/auth paths stop before provider KV or login work", async () => {
      for (const [path, method] of [["/register", "POST"], ["/token", "POST"], ["/auth/login", "GET"], ["/auth/callback", "GET"], ["/authorize", "GET"], ["/authorize", "POST"], ["/auth/passkey/login/options", "GET"], ["/auth/passkey/login/verify", "POST"], ["/auth/owner", "POST"]]) {
        const response = await request(path, method, "deny", { headers: { origin: "https://mcp-client.test" } })
        assert.equal(response.status, 429, path)
        assert.equal(response.headers.get("x-test-kv-calls"), "0", path)
        assert.equal(response.headers.get("retry-after"), "60")
        assert.equal(response.headers.get("cache-control"), "no-store")
        assert.deepEqual(JSON.parse(response.headers.get("x-test-guard-keys")!), [`${path}:192.0.2.1`])
        assert.equal((await response.json()).error, "temporarily_unavailable")
        if (path === "/register" || path === "/token") {
          assert.equal(response.headers.get("access-control-allow-origin"), "https://mcp-client.test")
          assert.equal(response.headers.get("access-control-expose-headers"), "Retry-After")
        }
      }
    })

    await t.test("queries and caller-supplied forwarding or client ids cannot reset a bucket", async () => {
      const response = await request("/register?client_id=changed&nonce=random", "POST", "deny", {
        headers: { "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.10" },
      })
      assert.equal(response.status, 429)
      assert.deepEqual(JSON.parse(response.headers.get("x-test-guard-keys")!), ["/register:192.0.2.1"])
    })

    await t.test("missing or failed hosted limiters stop OAuth instead of silently removing protection", async () => {
      for (const mode of ["missing", "error"]) {
        const response = await register(mode)
        assert.equal(response.status, 503)
        assert.equal(response.headers.get("x-test-kv-calls"), "0")
        assert.equal(response.headers.get("retry-after"), "60")
      }
    })

    await t.test("registration and token validation keep their OAuth contract below the limit", async () => {
      const response = await register()
      assert.equal(response.status, 201)
      assert.ok(Number(response.headers.get("x-test-kv-calls")) > 0)
      const client = await response.json()
      assert.equal(client.client_name, registration.client_name)
      assert.deepEqual(client.redirect_uris, registration.redirect_uris)
      assert.equal(client.token_endpoint_auth_method, "none")
      const token = await request("/token", "POST", "allow", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code: "invalid", code_verifier: "verifier", redirect_uri: registration.redirect_uris[0] }),
      })
      assert.equal(token.status, 400)
      assert.equal((await token.json()).error, "invalid_grant")
      assert.ok(Number(token.headers.get("x-test-kv-calls")) > 0)

      // Complete a real PKCE consent/code/token/refresh flow using a signed test
      // session, so successful OAuth is checked without contacting GitHub.
      const verifier = "v".repeat(43)
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
      const challenge = Buffer.from(digest).toString("base64url")
      const session = `rs_session=${await sign("test-secret", `alice|${Date.now() + 60_000}`)}`
      const authQuery = new URLSearchParams({
        client_id: client.client_id, redirect_uri: registration.redirect_uris[0], response_type: "code",
        scope: "references", state: "test-state", code_challenge: challenge, code_challenge_method: "S256",
      })
      const consent = await request(`/authorize?${authQuery}`, "GET", "allow", { headers: { cookie: session } })
      assert.equal(consent.status, 200)
      const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)?.[1]
      assert.ok(handle)
      const cookies = [session, ...consent.headers.getSetCookie().map((cookie) => cookie.split(";")[0])].join("; ")
      const approved = await request("/authorize", "POST", "allow", {
        headers: { cookie: cookies, origin: "https://snip.test", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ handle, decision: "approve" }),
      })
      assert.equal(approved.status, 302)
      const redirect = new URL(approved.headers.get("location")!)
      assert.equal(redirect.searchParams.get("state"), "test-state")
      const code = redirect.searchParams.get("code")
      assert.ok(code)
      const issued = await request("/token", "POST", "allow", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: registration.redirect_uris[0] }),
      })
      assert.equal(issued.status, 200)
      const tokens = await issued.json()
      assert.ok(tokens.access_token)
      assert.ok(tokens.refresh_token)
      const refreshed = await request("/token", "POST", "allow", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token }),
      })
      assert.equal(refreshed.status, 200)
      assert.ok((await refreshed.json()).access_token)
      const login = await request("/auth/login")
      assert.equal(login.status, 302)
      assert.match(login.headers.get("location")!, /^https:\/\/github.com\/login\/oauth\/authorize\?/)
    })

    await t.test("native Cloudflare binding permits a registration then blocks the next before KV", async () => {
      assert.equal((await register("native")).status, 201)
      const response = await register("native")
      assert.equal(response.status, 429)
      assert.equal(response.headers.get("x-test-kv-calls"), "0")
    })

    await t.test("discovery, CORS preflights, MCP and ordinary app routes do not spend an OAuth limit", async () => {
      for (const [path, method, status] of [["/.well-known/oauth-authorization-server", "GET", 200], ["/.well-known/oauth-protected-resource/mcp", "GET", 200], ["/register", "OPTIONS", 204], ["/token", "OPTIONS", 204], ["/mcp", "POST", 401], ["/api/me", "GET", 401], ["/auth/logout", "GET", 302]]) {
        const response = await request(path, method, "deny")
        assert.equal(response.status, status, path)
        assert.equal(response.headers.get("x-test-guard-keys"), "[]", path)
      }
      // PUBLIC_URL is "https://Snip.TEST/": the resource id must still be the canonical origin.
      const metadata = await (await request("/.well-known/oauth-protected-resource/mcp")).json()
      assert.equal(metadata.resource, "https://snip.test/mcp")
    })

    await t.test("desktop and development keep working with existing configs without bindings", async () => {
      for (const host of ["localhost:5173", "127.0.0.1:8787", "[::1]:8787"]) {
        const response = await mf.dispatchFetch(`http://${host}/auth/login`, { redirect: "manual", headers: { "x-test-guard-mode": "missing" } })
        assert.equal(response.status, 302)
        assert.equal(response.headers.get("x-test-guard-keys"), "[]")
      }
    })
  } finally {
    await mf.dispose()
  }
})
