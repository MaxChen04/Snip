import OAuthProvider from "@cloudflare/workers-oauth-provider"
import { app } from "./app"
import { mcpApiHandler } from "./mcp"

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
      resource: `${env.PUBLIC_URL.replace(/\/$/, "")}/mcp`,
      resource_name: "Snip design references",
    },
  })
  return provider
}

export default {
  fetch(request, env, ctx) {
    return getProvider(env).fetch(request, env, ctx)
  },
} satisfies ExportedHandler<Env>
