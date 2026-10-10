# compat: the public framework compatibility matrix, and templates

> **Scope:** `compat/**` (harness, apps, results, `RESULTS.md`), `templates/**` (starter templates) and `compat/templates-check.mjs`.
> **Read this when:** you change the one-line install, discovery, observers or anything that could break a framework; you need to re-run or extend the public compatibility page (genclass.dev/docs/compatibility); you edit a starter template.
> **Source of truth:** the code. Verified against branch `worktree-agent-acdd410e8d9ad6815` (based on `runtime` 2f89fb5), 2026-10-10. If this doc and the code disagree, the code wins.

## TL;DR

- `compat/run.mjs` packs `packages/runtime` (`tsup` + `npm pack`), installs the tarball into seven small apps
  (`compat/apps/*`: React+Vite, Next.js 16, Vue+Pinia, SvelteKit 3, Angular 22 fetch/XHR, Solid, plain HTML script tag;
  15 data layers), builds them for production, serves them behind one origin per worker that also hosts the seeded
  mock backend (`harness/backend.mjs`), and runs scenarios a-h × modes off/observe/guard/heal (+ an `offR` determinism
  control) × seeds in headless Chromium. `harness/report.mjs` writes `compat/RESULTS.md` (public, developer-facing)
  from `compat/results/<date>.json`.
- **Evaluation only.** Like `demos/`, the compat apps are never read by `sim/` or `realapps/`, never used for
  training, and the runtime/model is never tuned on them (AGENTS.md rule 4 applies to them too). Report every ✗.
- **Linux VM only** (slot `compat`, Node 24 at `/data/compat/node` because Angular 22 needs Node ≥ 22.22.3; model
  copy at `/data/compat/model/runtime-model-0.2.0`; results in `/data/compat/results`). See `compat/README.md`.
- `templates/*` (react-vite, nextjs, vue-vite, sveltekit) are copy-paste starters; `compat/templates-check.mjs`
  builds each against the packed runtime and checks prod (model ready, search works, no errors, kill switch) and dev
  (overlay mounts). They are not published.

## Invariants and gotchas

- The apps contain only the one line, where `init` puts it. Do not add GenClass API calls to them; the probe is a
  plugin injected through `window.GENCLASS_CONFIG` by the runner (`run.mjs` -> `probe`), with `telemetry: false`.
- Oracles read only the DOM (`harness/scenarios.mjs` -> `domSnapshotFn`) and the mock server's state, never GenClass.
- Observe must be *identical* to off (DOM + server). Guard/heal must introduce no bug and be identical where off was
  correct. A held delivery in guard/heal can change which stale answer ends on screen on a buggy seed; that is
  reported as "still buggy, differs from off", not as a failure.
- The kill-switch check looks at WebSocket, EventSource and `setTimeout` (and the absence of a model worker), not at
  `fetch`: SvelteKit wraps `window.fetch` itself in production.
- `vm.sh run` syncs with `--delete`: never sync while a run is going (it deletes `.next/`, `build/`, `dist/` of the
  apps being served) and keep results outside the slot.
- Zustand's `devtools` middleware is off in production builds unless `enabled: true`; the matrix carries both
  variants (`zustand`, `zustand-on`) to show it.

## How to change it safely

- New app or layer: add it to `harness/apps.mjs` (with its `discovery` expectation), implement the DOM contract
  listed at the top of `harness/scenarios.mjs`, run `node run.mjs --apps <app> --seeds 1` first.
- New scenario: drive + oracle in `harness/scenarios.mjs`, latency profile in `harness/backend.mjs`, then every app.
- After a runtime change that could affect installs: re-run the full matrix (about 25 minutes) and commit the new
  `results/<date>.json` and `RESULTS.md` together.
