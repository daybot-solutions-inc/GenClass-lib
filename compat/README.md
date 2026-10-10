# compat: the framework compatibility matrix

Real, idiomatic apps in every major framework and data layer, each with `@genclass/runtime` installed by the one
line only, driven through the same scenarios with and without GenClass. The output is
[RESULTS.md](RESULTS.md), published as genclass.dev/docs/compatibility (it is written for developers deciding
whether to install GenClass). This directory is separate from the training data: nothing in `sim/`, `realapps/` or
`training/` reads it, and the runtime and model are never tuned on it.

## Layout

| path | what |
|---|---|
| `run.mjs` | the runner (`npm run compat`): pack the runtime, install/build/serve each app, boot checks, trials, report |
| `harness/backend.mjs` | the shared seeded, fault-injecting mock backend (REST, `/graphql`, `/ws`, `/sse/*`) |
| `harness/front.mjs` | the per-worker origin: backend + the app (static build or proxied SSR server) + optional CSP header |
| `harness/scenarios.mjs` | the eight scenarios: how each is driven (trusted input) and its oracle (DOM + server state only) |
| `harness/apps.mjs` | the apps, how to build and serve them, their data layers and expected state discovery |
| `harness/report.mjs` | results JSON → `RESULTS.md` (`npm run report -- results/<date>.json`) |
| `apps/*` | React 19 + Vite (useState, TanStack Query, Zustand ×2, Redux Toolkit + RTK Query, Apollo), Next.js 16 App Router (useState, SWR), Vue 3 + Pinia, SvelteKit 3 (Svelte stores), Angular 22 (HttpClient on fetch and on XHR), Solid (createResource), plain HTML with the CDN script tag (fetch; WebSocket + EventSource) |
| `templates-check.mjs` | builds and boots the starter templates in `../templates/` against the packed runtime |
| `results/` | one JSON per published run |
| `scripts/vm-setup.sh` | one-time setup on the Linux VM; `scripts/summarize-dev.cjs` prints one line per trial |

## Every app implements the same DOM contract

`<div id="compat" data-ready="1">` once mounted, `?s=a..h` picks the scenario, `?layer=` the data layer, and the
`data-testid`s listed at the top of `harness/scenarios.mjs`. The apps contain no GenClass code beyond the one line
(`import "@genclass/runtime/auto"` first in the browser entry, `instrumentation-client.ts` for Next.js,
`hooks.client.ts` for SvelteKit, the script tag for plain HTML), exactly where `npx @genclass/runtime init` puts it.
Scenarios a and b are written the common, naive way (they can show the bug); c to h are correct apps.

## Run

Linux only (it builds seven framework apps and runs many headless Chromium instances; never on the 8 GB Mac).
On the team VM:

```bash
scripts/vm.sh run compat 'export PATH=/data/compat/node/bin:$PATH; bash compat/scripts/vm-setup.sh'   # once
scripts/vm.sh run compat 'export PATH=/data/compat/node/bin:$PATH; cd compat && COMPAT_COMMIT=<sha> node run.mjs --seeds 10 --out /data/compat/results/$(date +%F).json'
scripts/vm.sh exec compat 'export PATH=/data/compat/node/bin:$PATH; cd compat && node templates-check.mjs'
# then publish: copy the JSON into compat/results/, render the page, fetch both
scripts/vm.sh exec compat 'export PATH=/data/compat/node/bin:$PATH; cd compat && cp /data/compat/results/<date>.json results/ && node harness/report.mjs results/<date>.json RESULTS.md'
scripts/vm.sh get compat compat/results/<date>.json compat/results/ && scripts/vm.sh get compat compat/RESULTS.md compat/
```

With `--out`, the runner writes `<out>.md` next to the JSON and leaves `RESULTS.md` alone (`--report RESULTS.md`
overrides).

Anywhere else, see "Reproduce" in [RESULTS.md](RESULTS.md). Useful flags: `--apps`, `--layers`, `--scenarios`,
`--modes`, `--seeds`, `--workers`, `--boot-only`, `--no-pack`, `--no-control`. Node ≥ 22.22.3 is needed for
Angular 22 (the VM's slot uses `/data/compat/node`, Node 24). A full run (10 seeds, 16 browsers) takes about 25
minutes on 64 cores. `vm.sh run` syncs with `--delete`, so keep result files outside the slot (`/data/compat/results`)
and do not sync while a run is going (it deletes the apps' build output).
