# Snip MCP architecture and agent workflow review

Reviewed 10 November 2026 at commit `20b4be6a2e3dd42f1d75c28d7ea9f95d3143e65a`. Three GPT 6.1 Terra agents independently examined runtime scalability, user workflows, and comparable design tools. The coordinating review challenged their findings, checked the current capture limits, ran the focused tests, and consolidated the conclusions below. This review changes no application behavior.

Snip has an appropriate foundation for a personal reference library that agents can use. Its strongest experience is a person choosing specific references and asking an agent to use them in a design or coding task. Exact IDs, focused screenshots, motion stills, structured results and continuation hints support that experience. Open-ended discovery by visual intent is less developed, and scalability under large files or concurrent agents has not been demonstrated. The useful next investment is preserving user intent and reducing retrieval work within the current architecture.

The intended product boundary is one owner's library per installation. The current capture API caps a crawl at 200 pages; whole-library size and concurrent readers are separate dimensions. These conclusions do not establish a capacity limit or readiness for a shared multi-tenant service. The review also preserves the user's established requirement for a portable core across model families and harnesses, with optional richer capabilities and explicit fallbacks.

**What users are trying to accomplish.** The following jobs are inferred from the README, selection UI and copied-prompt implementation. They are hypotheses about usage, not customer research or measured demand.

| User request | Current path | Assessment |
| --- | --- | --- |
| “Use these references when building my page.” | Copy selected IDs; get_page/get_animation; retrieve relevant styles or tokens | Strongest fit. The user's saved note is missing from this handoff. |
| “Use this hero's layout and this other site's motion.” | Inspect page sections and animation contact sheets separately | Useful evidence exists, but copied selections do not preserve a chosen section, viewport or theme. |
| “Find a pricing page with rounded cards.” | Search page/reference metadata, then inspect candidates | The search does not understand visual characteristics. A failed query does not prove the library has no matching design. |
| “Compare these references and choose a direction.” | Retrieve equivalent screenshots, styles and tokens for each | Feasible through the existing tools. The agent must distinguish capture differences from design differences. |
| “Capture this URL and use it.” | add_reference, then MCP Tasks or wait_for_capture | Async paths exist. Capture still requires the user's Mac; an existing URL can return an older saved reference. |
| “Bring the reference into Figma or Pencil.” | Snip supplies evidence; the destination's tools locate/edit its native document | A sensible workflow to test. Native interoperability and final design fidelity were not demonstrated in this review. |

Snip already offers progressive retrieval, direct item access, section screenshots, motion manifests and stills, text plus structured results, explicit omissions, and Tasks with a polling fallback. Captured content is labeled as reference material. These are valuable foundations to retain. See the [MCP server](/Users/Maxsc/Desktop/Projects/snip/web/worker/mcp.ts:17) and [copied prompt](/Users/Maxsc/Desktop/Projects/snip/web/src/lib/agent-prompt.ts:34).

**The changes with the clearest value, in recommended order:**

1. **Carry the user's reason for saving a reference into the agent handoff.**

   A user may have written “borrow the navigation and spacing; keep our own colors.” The current prompt builder receives that note but omits it, tells the agent to fetch only selected IDs, and says a whole-reference read is unnecessary. The direct page and animation results also omit the parent note. The note is available through reference search/overview, but that is outside the recommended selected-item path.

   A synthetic invocation of the actual prompt builder confirmed: selected page ID present, reference ID present, saved note absent. Include the note as labeled user context in the existing copied prompt. Keep it distinct from captured website text and subordinate to the user's current request. This small change can improve whether an agent builds the right thing without adding a tool call. [Prompt builder](/Users/Maxsc/Desktop/Projects/snip/web/src/lib/agent-prompt.ts:39), [reference summaries](/Users/Maxsc/Desktop/Projects/snip/web/worker/mcp.ts:108), [direct page result](/Users/Maxsc/Desktop/Projects/snip/web/worker/mcp.ts:452).

2. **Make small requests do small amounts of work.**

   Every get_page_styles request reads and decompresses the whole styles object, parses it, and then selects a summary or filters/paginates elements. Each next page repeats this work. The same pattern affects HTML slices. Separately, get_reference loads every page and animation even for a token-only request or a small overview. Response limits protect the agent's context but do not bound the underlying processing. [Styles](/Users/Maxsc/Desktop/Projects/snip/web/worker/mcp.ts:527), [HTML](/Users/Maxsc/Desktop/Projects/snip/web/worker/mcp.ts:491), [reference query](/Users/Maxsc/Desktop/Projects/snip/web/worker/db.ts:221).

   Start with purpose-specific database reads: reference-only for tokens, small projections for overview, and database pagination for pages/animations. Prepare a compact style summary during capture. For detailed styles, evaluate independently readable chunks with a versioned manifest. Chunking makes unfiltered pagination cheaper; arbitrary selector/text substring filters still require scanning unless a compatible index or chunk metadata can exclude irrelevant chunks. Do not claim that chunking alone fixes filtered lookup.

   Publish derived artifacts only after their upload succeeds; bind them to the capture run, preserve truncation/ordering/omission semantics, and retain the original artifacts and old-capture fallback. Measure additional storage and upload operations. These changes belong in capture/storage and retrieval, so every agent benefits without model-specific prompts. Keep the current public contracts, including the documented legacy full read, until there is an explicit compatibility migration.

   Cloudflare's CPU and memory constraints make repeated parsing worth addressing, but the measurements below do not demonstrate a hosted limit violation. [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).

3. **Preserve the selected view and identify the capture precisely.**

   The copied prompt records endpoint, source/reference ID, selected page/animation IDs and optional tokens. It omits selected section, chosen viewport/theme and capture revision/time. get_page exposes dimensions and coverage, but does not provide capture-run/time provenance. Reference createdAt is the reference's creation date, not the latest capture date.

   Recapture preserves the reference ID but deletes its pages/animations and creates new IDs. Old direct IDs return explicit errors; copied inline tokens can still look usable despite being stale. Existing reference cursors reject a changed updatedAt, which can also change for notes or progress. Preserve these distinctions instead of inventing a stable identity guarantee. [Recapture](/Users/Maxsc/Desktop/Projects/snip/web/worker/db.ts:365), [cursor validation](/Users/Maxsc/Desktop/Projects/snip/web/worker/mcp.ts:347).

   Extend the existing handoff and page response with a compact selection description: user note, source, selected item/section, requested view, actual returned view, capture run and a correctly defined capture timestamp. Re-resolve expired file URLs through IDs. On a stale selection, enumerate the new capture and preserve the user's intended page; ask only if correspondence is ambiguous. This can be tested through existing tools before introducing a separate selection service.

   One concrete constraint: section assets are desktop captures, and mobile images do not switch with the desktop scheme option. An agent must not describe a dark mobile section as observed when it has only a dark desktop section plus the captured mobile screenshot. [Representation selection](/Users/Maxsc/Desktop/Projects/snip/web/worker/mcp.ts:461).

4. **Improve discovery according to the user’s design vocabulary, after measuring missed searches.**

   Current search matches metadata such as titles, URLs, paths and reference notes. A request about an editorial hero, pricing-card shape or motion style requires inspecting candidates. First expose this limitation clearly and evaluate searchable section labels, captured text and user-authored intent. Add generated descriptions or semantic indexing only if task evaluations show a recurring gap; keep generated interpretation distinguishable from captured evidence. [Search contract](/Users/Maxsc/Desktop/Projects/snip/web/worker/mcp.ts:677).

5. **Evaluate completed agent tasks across clients, not just successful MCP calls.**

   The portable contract is a good start. It does not prove that each client forwards images, follows continuations, supports Tasks, opens signed URLs or produces a faithful destination design. Test model family and harness separately: GPT/Claude/Gemini-based workflows, local and cloud connection where supported, image-capable and limited/text-only paths, Tasks and wait fallback. Record the exact tested versions and capabilities; keep unknown combinations marked untested.

**What other design tools suggest.** These are documentation-backed comparisons and proposed handoffs. No user design was edited and no native integration was exercised.

| Tool | Relevant documented pattern | Lesson for Snip |
| --- | --- | --- |
| Figma | Selection/node-scoped design context; metadata for choosing smaller nodes; screenshots; deliberate Code Connect mappings | Retrieve the selected evidence progressively. Resolve destination components through Figma's own native IDs and mappings. Captured CSS does not establish component equivalence. [Tools](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/), [Code Connect](https://developers.figma.com/docs/figma-mcp-server/code-connect-integration/). |
| Penpot | MCP connects through the app/plugin and exposes native design objects; active-file and asset-access boundaries matter | Name the intended target file and verify its current context before applying a reference. Remote and local asset access need separate checks. [Official MCP guide](https://help.penpot.app/mcp/). |
| Pencil | Local MCP works with document/selection state and design execution; file and save state matter | Let Snip supply evidence and Pencil own native editing. Inspect a fresh result and verify saving separately. [AI integration](https://docs.pencil.dev/getting-started/ai-integration), [CLI](https://docs.pencil.dev/for-developers/pen-cli). |
| Webflow | MCP separates data/headless operations from live Designer context and visual inspection | Make destination context and inspection explicit. An available cloud library does not imply every local/session-dependent capability is available. [Architecture](https://developers.webflow.com/mcp/reference/how-it-works), [Designer tools](https://developers.webflow.com/mcp/tools/designer-tools). |

For a Snip-to-Figma workflow, the agent would resolve the Snip selection, inspect the relevant section/style evidence, resolve the target Figma node and available components, perform the authorized work through whatever editing capability is actually available, then inspect a fresh destination render. For Pencil, it would similarly establish the active document and its schema, edit native objects, inspect a screenshot, and verify the save. These workflows depend on destination capabilities and permissions; a reference screenshot is not a lossless editable import.

Most of the useful retrieval mechanisms already exist in Snip. Adopt precise selection, provenance and verification from these tools. Avoid adding a native editor merely for feature parity, or adding another large MCP tool surface before testing the current handoff.

**Measured evidence and its limits.** A synthetic probe invoked Snip's actual MCP HTTP handler with instrumented database and compressed-object stubs. Reference sizes were 20 and 200 pages, within the current supported limit. Styles were varied independently between 20 and 2,000 elements.

| Request | Smaller fixture | Larger fixture | Meaning |
| --- | ---: | ---: | --- |
| Reference tokens: rows returned by stub | 21 | 201 | Tokens-only reads also materialize the page rows. |
| Reference tokens: complete response bytes | 773 | 773 | Identical response size conceals increasing input work. |
| Reference overview: complete response bytes | 3,423 | 3,543 | Both return 20 page entries; both still load all pages. |
| Styles summary: decompressed input bytes | 2,158 | 215,858 | A small summary processes the entire object. |
| Styles summary: complete response bytes | 831 | 835 | Output remains almost constant. |
| First and next five-element detail pages | One full object read per call | One full object read per call | Pagination repeats the full read/decompression. |

These are observed handler/stub counts and serialized bytes. They are not billable D1 rows, heap usage, model tokens, hosted CPU, latency or concurrency capacity. The larger style fixture contained 11,262 stored gzip bytes. No real customer dataset was accessed. The reproducible [probe](/private/tmp/snip-mcp-review-2026-11-10/probe.ts) and [raw results](/private/tmp/snip-mcp-review-2026-11-10/probe-results.jsonl) are retained with the review session artifacts.

The focused repository tests passed **35/35**: copied prompts/client snippets, local/cloud MCP surfaces, consent routing, bounds/cursors, legacy compatibility, Tasks and wait fallback, recapture task isolation, and sections/motion. The first subagent attempt could not start a localhost test listener in the sandbox; the coordinating rerun with loopback access passed. This establishes the tested server contracts, not model task success or real OAuth in every client.

```sh
rtk proxy node --import tsx --test web/tests/mcp-compat.test.ts web/tests/mcp-bounds.test.ts web/tests/mcp-tasks.test.ts web/tests/mcp-authorize.test.ts web/tests/cloud-mcp.test.ts web/tests/agent-prompt.test.ts web/tests/sections-motion.test.ts
```

Before making a stronger scalability or interoperability claim, use an isolated fixture library and record these outcomes:

| Evaluation | Evidence to collect |
| --- | --- |
| Use an exact reference and follow its note | Correct item and requested design attributes reach the final artifact; calls, tokens and time recorded. |
| Find a component from visual-language criteria | Search recall, false “no match” results, candidate inspection cost and correct final selection. |
| Recreate a section in a destination tool | Human visual review plus measured layout/type/style differences; explicit observed/inferred claims. |
| Borrow CSS and script-driven motion | Appropriate stills/manifest used; no invented timing for motion that was not recorded semantically. |
| Recapture, offline Mac, duplicate URL, missing image and expired URL | Correct recovery, no false claim of fresh capture, no repeated unintended writes. |
| Small/large files and concurrent readers | Actual hosted CPU, memory/error signals, D1 rows read, R2 operations/bytes, p50/p95 latency and response size. |

The recommended next implementation is a small intent-preservation change plus focused retrieval improvements, followed by real cross-client task evaluations. The present evidence supports this architecture for the intended personal-library direction; it does not justify a broad rewrite or a claim of proven scale.
