# QA harness

End-to-end journeys and resource tracking for the desktop app, on both channels: stable (gold icon) and Snip Dev (blue icon). The scripts drive a packaged build over the Chrome DevTools Protocol, using the Playwright already installed for the capture engine.

This is a manual pre-release check, not part of `npm test`. Several journeys capture real sites (example.com, linear.app, vercel.com), so results depend on the network and on those sites.

## Run it in a throwaway worktree

The stable channel, run from source, keeps its library in the checkout's `web/.wrangler/state` and reads `web/.dev.vars`. Use a fresh worktree so none of that is yours:

```bash
git worktree add --detach ../snip-qa origin/main
```

Everything below runs inside that worktree. The harness uses ports 5373 and 9373 (stable), 5383 and 9383 (Snip Dev) and 5391 (fixture site), and profiles under `qa/`. It never uses the installed apps, their profiles, or ports 5173 and 5273.

## Set up

```bash
npm ci && npm ci --prefix desktop && npm run build -w web
```

Stable needs throwaway secrets and a migrated local database. Generate the secrets; do not copy real ones.

```bash
T=$(openssl rand -hex 32)
printf 'SESSION_SECRET=%s\nCAPTURE_TOKEN=%s\nOWNER_LINK_SECRET=%s\nDEV_LOGIN=qa-tester\nPUBLIC_URL=http://localhost:5373\n' $(openssl rand -hex 32) $T $(openssl rand -hex 32) > web/.dev.vars
printf 'SNIP_URL=http://localhost:5373\nCAPTURE_TOKEN=%s\nALLOW_PRIVATE_URLS=true\n' $T > capture/.env
CI=true npm run db:migrate:local -w web
```

`ALLOW_PRIVATE_URLS=true` lets the capture engine reach the local fixture site. Snip Dev keeps its own library inside `qa/profile-dev` and migrates on launch; add the same line to `qa/profile-dev/library/capture/.env` after its first start if you run `live.mjs` on it.

Build both apps into `qa/` (`--no-install` keeps them out of `/Applications`):

```bash
node desktop/build.mjs --no-install --out qa/build-stable
node desktop/build.mjs --no-install --nightly --out qa/build-dev
```

## Run

`<ch>` is `stable` or `dev`.

| Command | What it does |
|---|---|
| `node qa/app.mjs start <ch>` | Start the app with its throwaway profile and wait until it answers |
| `node qa/app.mjs stop <ch>` | Stop it and report anything left running |
| `node qa/journeys.mjs <ch> [tag] [j1,j2,...]` | Journeys 1 to 7 and 10: first launch, captures, sections, canvas, boards, uploads, re-capture and delete, hostile input |
| `node qa/fixture.mjs` then `node qa/live.mjs <ch>` | Live clips and Light/Dark on a local page that always animates and has a dark theme |
| `node qa/restart.mjs <ch>` | Journey 8 (restart keeps the library, migrations run once) and, with both apps up, journey 9 (the channels share nothing) |
| `node qa/soak.mjs <ch> canvas [n]` | Repeat canvas interactions, reading JS heap, DOM nodes, listeners and `<video>` count after forced GC |
| `REF=<id> PAGE=<id> node qa/soak.mjs <ch> viewer [n]` | Toggle Live in the page viewer n times with the same readings |
| `node qa/resource.mjs <ch>` | The full resource run: idle, capture, idle after, both soaks, final idle (about 25 minutes; run `live.mjs` first) |
| `node qa/summarize.mjs res-<ch>` | Turn the resource CSVs into a table |

Results go to `qa/out/` (JSON per journey with console errors, failed requests and server-log errors; CSVs from the sampler), screenshots to `qa/shots/`, app output to `qa/logs/`. All of it is ignored by git.

## Reading the results

- Check `uptime` first. CPU figures are inflated when the machine is busy; every sample records the load average next to it. Judge memory separately from CPU.
- `ps` resident memory double-counts pages shared between Electron helpers. Compare phases with it; do not read it as an absolute footprint.
- The page viewer and the canvas inspector share their Live and Light/Dark toggles and one clip player. `live.mjs` fails if either toggle is missing for the fixture page, which has both clips and a dark theme, or if a clip keeps playing after Static.
- Static pauses the clips where they are and keeps them mounted, so in the viewer soak's `end-live-off` row `videos` stays at the clip count and only `playing` drops to 0. A clip gets its source when the page is scrolled near it, so on a tall page `videos` can exceed the number of clips fetched.
- A journey that fails on a selector after a UI change is a harness fix, not necessarily a product bug. Look at the screenshot named in the result before filing anything.
