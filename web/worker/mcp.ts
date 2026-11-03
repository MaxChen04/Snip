import { createMcpHandler } from "agents/mcp/server"
import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import type { Animation, Page, Reference } from "../shared/types"
import { signFileUrl } from "./auth"
import * as db from "./db"

// Remote MCP server. Read tools let an agent pull references (screenshots,
// design tokens, computed styles, HTML snapshots); write tools let it add
// references and organize collections. Requests reach this handler only after
// the OAuth provider has validated the bearer token.

const MAX_INLINE_BYTES = 900_000
const MAX_TEXT_CHARS = 60_000

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
})

function buildServer(env: Env, origin: string) {
  const url = (key: string | null) => (key ? signFileUrl(env, origin, key) : Promise.resolve(null))

  const summarizeRef = async (r: Reference) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    domain: r.domain,
    status: r.status,
    progress: r.progress,
    error: r.error,
    mode: r.mode,
    pageCount: r.pageCount,
    animationCount: r.animationCount,
    collectionIds: r.collectionIds,
    coverUrl: await url(r.coverKey),
    appUrl: `${origin}/r/${r.id}`,
    createdAt: r.createdAt,
  })

  const describePage = async (p: Page) => ({
    id: p.id,
    url: p.url,
    path: p.path,
    title: p.title,
    desktop: { fullPageUrl: await url(p.desktopKey), thumbUrl: await url(p.desktopThumbKey), width: p.desktopWidth, height: p.desktopHeight },
    mobile: { fullPageUrl: await url(p.mobileKey), thumbUrl: await url(p.mobileThumbKey), width: p.mobileWidth, height: p.mobileHeight },
    htmlSnapshotUrl: await url(p.snapshotKey),
    computedStylesUrl: await url(p.stylesKey),
  })

  const describeAnimation = async (a: Animation) => ({
    id: a.id,
    pageId: a.pageId,
    kind: a.kind,
    label: a.label,
    selector: a.selector,
    viewport: a.viewport,
    gifUrl: await url(a.gifKey),
    width: a.width,
    height: a.height,
  })

  const server = new McpServer({ name: "snip", version: "1.0.0" })

  server.registerTool(
    "search_references",
    {
      title: "Search design references",
      description:
        "Search saved website design references. Filter by text (title/URL), collection id or domain. Returns summaries with cover image URLs; use get_reference for pages, tokens and animations.",
      inputSchema: z.object({
        query: z.string().optional().describe("Text matched against title, URL and description"),
        collection_id: z.string().optional(),
        domain: z.string().optional().describe("e.g. linear.app"),
        sort: z.enum(["newest", "oldest", "name"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().optional().describe("nextCursor from a previous call"),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const res = await db.listReferences(env.DB, {
        q: args.query,
        collectionId: args.collection_id,
        domain: args.domain,
        sort: args.sort,
        limit: args.limit ?? 20,
        cursor: args.cursor,
      })
      return text({ items: await Promise.all(res.items.map(summarizeRef)), nextCursor: res.nextCursor })
    },
  )

  server.registerTool(
    "get_reference",
    {
      title: "Get a design reference",
      description:
        "Get one reference with its design tokens (colors, fonts, type scale, spacing, radii, shadows, transitions, keyframes, CSS variables), every captured page (desktop and mobile screenshot URLs, HTML snapshot URL, computed styles URL) and its scroll/hover animation GIFs. File URLs are signed and expire after 24 hours.",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const r = await db.getReference(env.DB, id)
      if (!r) return { ...text(`No reference with id ${id}`), isError: true }
      return text({
        ...(await summarizeRef(r.reference)),
        description: r.reference.description,
        tokens: r.reference.tokens,
        pages: await Promise.all(r.pages.map(describePage)),
        animations: await Promise.all(r.animations.map(describeAnimation)),
      })
    },
  )

  server.registerTool(
    "get_page",
    {
      title: "Get a captured page",
      description:
        "Get one captured page. Optionally inline a screenshot (viewport-sized thumbnail) as an image, the page's computed-style JSON (per-element styles that differ from browser defaults, with pseudo-elements, transitions and keyframes) and/or its self-contained HTML snapshot. Large text is truncated; use the returned URLs for the full files.",
      inputSchema: z.object({
        page_id: z.string(),
        image: z.enum(["none", "desktop", "mobile"]).optional().describe("Inline a viewport screenshot. Default desktop."),
        include_styles: z.boolean().optional(),
        include_html: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ page_id, image = "desktop", include_styles, include_html }) => {
      const p = await db.getPage(env.DB, page_id)
      if (!p) return { ...text(`No page with id ${page_id}`), isError: true }
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
        { type: "text", text: JSON.stringify({ ...(await describePage(p)), tokens: p.tokens }, null, 2) },
      ]
      const imageKey = image === "mobile" ? p.mobileThumbKey : image === "desktop" ? p.desktopThumbKey : null
      if (imageKey) {
        const obj = await env.FILES.get(imageKey)
        if (obj && obj.size <= MAX_INLINE_BYTES) {
          const bytes = new Uint8Array(await obj.arrayBuffer())
          let bin = ""
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          content.push({ type: "image", data: btoa(bin), mimeType: obj.httpMetadata?.contentType ?? "image/jpeg" })
        }
      }
      for (const [flag, key, label] of [
        [include_styles, p.stylesKey, "computed styles"],
        [include_html, p.snapshotKey, "HTML snapshot"],
      ] as const) {
        if (!flag || !key) continue
        const obj = await env.FILES.get(key)
        if (!obj) continue
        const body = await obj.text()
        const truncated = body.length > MAX_TEXT_CHARS
        content.push({
          type: "text",
          text: `--- ${label}${truncated ? ` (first ${MAX_TEXT_CHARS} of ${body.length} chars)` : ""} ---\n${body.slice(0, MAX_TEXT_CHARS)}`,
        })
      }
      return { content }
    },
  )

  server.registerTool(
    "search_animations",
    {
      title: "Search animation GIFs",
      description: "List captured scroll and hover animation GIFs across all references, newest first.",
      inputSchema: z.object({
        query: z.string().optional(),
        collection_id: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const res = await db.listAnimations(env.DB, { q: args.query, collectionId: args.collection_id, limit: args.limit ?? 20, cursor: args.cursor })
      return text({
        items: await Promise.all(res.items.map(async (a) => ({ ...(await describeAnimation(a)), reference: a.reference }))),
        nextCursor: res.nextCursor,
      })
    },
  )

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description: "List collections with their reference counts.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => text(await db.listCollections(env.DB)),
  )

  server.registerTool(
    "add_reference",
    {
      title: "Add a design reference",
      description:
        "Queue a website for capture. mode 'single' captures just this page; 'crawl' follows same-domain links up to max_pages. Capture runs on the owner's machine, so it completes when the capture agent is running; poll get_reference for status.",
      inputSchema: z.object({
        url: z.string(),
        mode: z.enum(["single", "crawl"]).optional(),
        max_pages: z.number().int().min(1).max(200).optional(),
        collection_ids: z.array(z.string()).optional(),
      }),
    },
    async (args) => {
      try {
        const ref = await db.createReference(env.DB, {
          url: args.url,
          mode: args.mode ?? "single",
          maxPages: args.max_pages,
          collectionIds: args.collection_ids,
        })
        return text(await summarizeRef(ref))
      } catch (e) {
        return { ...text((e as Error).message), isError: true }
      }
    },
  )

  server.registerTool(
    "create_collection",
    {
      title: "Create a collection",
      description: "Create a new collection to organize references.",
      inputSchema: z.object({ name: z.string().min(1), description: z.string().optional() }),
    },
    async ({ name, description }) => text({ id: await db.createCollection(env.DB, name, description) }),
  )

  server.registerTool(
    "set_collection_membership",
    {
      title: "Add or remove a reference from a collection",
      description: "Add a reference to a collection (member=true) or remove it (member=false).",
      inputSchema: z.object({ reference_id: z.string(), collection_id: z.string(), member: z.boolean() }),
      annotations: { idempotentHint: true },
    },
    async ({ reference_id, collection_id, member }) => {
      await db.setReferenceCollection(env.DB, reference_id, collection_id, member)
      return text({ ok: true })
    },
  )

  return server
}

export const mcpApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const origin = new URL(request.url).origin
    const handler = createMcpHandler(() => buildServer(env, origin), { route: "/mcp" })
    return handler(request, env, ctx)
  },
}
