import OAuthProvider from "@cloudflare/workers-oauth-provider"
import { app } from "./app"
import { cleanupRetiredFiles } from "./db"
import { mcpApiHandler } from "./mcp"
import { guardOAuthRequest, type OAuthCostGuardBindings } from "./oauth-cost-guards"

// /mcp is protected by OAuth (tokens issued after GitHub login + consent).
// Everything else (web app API, capture agent API, files, auth) goes to Hono.
let provider: OAuthProvider<Env> | undefined

function getProvider(env: Env) {
  provider ??= new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler,
    defaultHandler: { fetch: (req, env, ctx) => app.fetch(req, env, ctx) },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: ["references"],
    accessTokenTTL: 60 * 60 * 24 * 7,
    resourceMetadata: {
      // .origin lowercases the host (the provider rejects mixed case) and drops a trailing slash.
      resource: `${new URL(env.PUBLIC_URL).origin}/mcp`,
      resource_name: "Snip design references",
    },
  })
  return provider
}

export default {
  async fetch(request, env, ctx) {
    const blocked = await guardOAuthRequest(request, env)
    if (blocked) return blocked
    return getProvider(env).fetch(request, env, ctx)
  },
  // Otherwise retired capture files are only swept when a job is claimed, recaptured or deleted.
  async scheduled(_controller, env) {
    await cleanupRetiredFiles(env.DB, env.FILES)
  },
} satisfies ExportedHandler<Env & OAuthCostGuardBindings>
