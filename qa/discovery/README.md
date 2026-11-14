# Discovery evals

Does an agent, given a user's ask, find the right saved reference (and the right section of it) through Snip's MCP? These scripts measure that, first without a model and then across agent harnesses.

Everything runs against a synthetic library (`library.ts`): twelve fictional websites, so no model already knows them, each with the things search reads: the user's note on the website, page titles and paths, section labels and the text captured on each section. Two pages are older captures with no sections or text. Screenshots are 1x1 placeholders.

`tasks.ts` holds 19 tasks. Each has a keyword `query` (what an agent might type), a natural `prompt` (what a user would say) and the page and section that answer it. `kind` says what the answer can be found by: the user's `note`, a `section` label, page `text`, a page `title`, or `visual` (how it looks; word search only solves these where a note happens to say it, and they are kept to show that gap).

The fixture and tasks were written by the same author, so scores here are an upper bound. They guard against regressions and compare harnesses; they don't predict scores on a real library. See "Next" below.

## Stage 1: retrieval, no model

```bash
node --import tsx qa/discovery/retrieval.ts
```

Runs every task's `query` through `search_pages` and through the substring filter it replaced, and prints where the right page ranks. `web/tests/discovery-search.test.ts` asserts the same numbers in `npm test`.

## Stage 2: agents through their harness

```bash
node --import tsx qa/discovery/run.ts --harness claude            # Claude Code
node --import tsx qa/discovery/run.ts --harness codex             # Codex CLI
node --import tsx qa/discovery/run.ts --harness gemini            # Gemini CLI
node --import tsx qa/discovery/run.ts --harness scripted          # no model: top search hit, a floor
#   --model <id>   --tasks id,id   --repeat 3   --distractors 60   --port 5399   --timeout 240
```

`run.ts` serves the library over Snip's real MCP handler at `http://localhost:5399/mcp` (no sign-in), runs each prompt through the harness CLI non-interactively with only that server configured, and logs every tool call on the server side, so scoring is identical for every harness. The CLIs must be installed and signed in; no API keys are read. Your own CLI config is left alone: Claude gets `--mcp-config --strict-mcp-config`, Codex a `-c mcp_servers.snip.url=…` override, Gemini a `.gemini/settings.json` in a temp directory.

Per task it records:

- **found**: the page in the agent's final `ANSWER:` line is a right one.
- **sawSection**: it called `get_page` with the expected section index (tasks that name a section).
- **openedRight**: it opened a right page at some point, even if it answered another.
- tool calls, searches, bytes read from Snip, tool errors, seconds, timeouts, and the full call log.

`--distractors N` adds N filler websites that answer no task. Twelve sites are cheap to browse one by one, so an agent finds most answers even with poor search; at real library sizes it can't, and the cost columns show it.

Results land in `qa/discovery/results/` (gitignored). Use `--repeat 3` or more before comparing harnesses: single runs vary.

To compare against an older Snip, copy this folder into a worktree of that commit and run it there on another `--port`. The scripts only need `web/worker/mcp.ts` and `web/worker/db.ts`.

## Stage 3: does the agent produce the intended design (not built yet)

Finding the reference is necessary, not sufficient. The plan for the second half of the question:

1. **Real references.** Capture 10 to 15 sites Max actually saves (with notes), and export them as a fixture library with their real screenshots, sections and styles. The synthetic library has no pixels to imitate.
2. **Build tasks.** "Build our pricing section using the reference I saved for it", with the expected reference and section fixed per task. The agent writes one HTML file.
3. **Score.** Render the output and the reference section with Playwright at the same width, then:
   - token adherence: the output's computed colors, font families, radii and spacing against the reference's captured tokens (deterministic);
   - layout similarity: a perceptual score between the two screenshots, as a coarse signal;
   - a pairwise judge with a fixed rubric (structure, spacing, type, color, fidelity to the user's note), using a model from a different vendor than the one under test.
4. **Matrix.** Claude Code, Codex and Gemini CLI, at least 3 runs per task, reporting found rate, design score and cost (tool calls, bytes, seconds) together.

## Next for search itself

- Visual descriptors. "Rounded pricing cards" matches only words today. Derived, checkable words from captured styles (rounded when border-radius ≥ 12px, dark when the background is dark, serif when the heading font is) would answer the visual tasks without a vision model.
- Agent-written section descriptions at capture time are the larger step, if the derived words fall short.
- If libraries grow past a few thousand pages, replace the per-term scan in `web/worker/search.ts` with an inverted-index table (FTS5 is ruled out: `wrangler d1 export` refuses virtual tables).
