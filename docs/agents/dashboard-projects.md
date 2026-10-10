# App tokens, projects and dashboards

> **Scope:** the client side of per-app dashboards: `InitOptions.token`, the telemetry envelope's `token`, `protect()`
> and `InitOptions.scope`, `Decision.fn`, and the `init` CLI's project creation (`packages/runtime/bin/lib/token.mjs`,
> `init.mjs`). The server side (project creation, ingest by token, the dashboard pages) lives in `telemetry-worker/`
> and is built by a separate workstream; this doc only states the contract both sides follow.
> **Read this when:** you touch tokens, dashboards, `protect()`, `scope`, or `init`'s network call.
> **Source of truth:** the code. Verified against branch `feat/projects` (from 126026f), 2026-10-10. If this doc and
> the code disagree, the code wins.

## TL;DR

- A **token** identifies one web app: `gc_` + 22 base62 characters (`^gc_[A-Za-z0-9]{22}$`). It is public (it ships
  in client code) and only lets data be sent. The **dashboard link** `https://genclass.dev/dashboard/<secret>`
  (secret = 32 base62) is private; whoever has it sees that app's stats.
- Dashboards only receive data while telemetry is on. Every opt-out and Global Privacy Control still wins; a token
  changes nothing about what is collected, only how the collector can group it.
- `protect(name, fn)` is the function-specific way in; `scope: "functions"` limits decisions to protected functions.
  Decisions about what a protected call caused carry `fn: name`, also on telemetry `decision` events.

## The shared contract (do not deviate without the server side)

| piece | client (this repo, `packages/runtime`) | server (`telemetry-worker/`) |
|---|---|---|
| create a project | `init` -> `POST https://genclass.dev/api/projects`, JSON `{ "name"?: string }` (≤ 80 chars, from package.json `name`) | 201 `{ token, dashboardUrl, name, created }`; CORS open; rate-limited (429). Humans: "Get a token" at https://genclass.dev/start |
| send data | batch envelope (schema `genclass-telemetry/1`) gains optional top-level `token`, only for a valid-format token (`src/telemetry/client.ts` -> `header()`) | endpoint unchanged (`DEFAULT_TELEMETRY_ENDPOINT`); groups batches by `token` |
| function names | `decision` events gain optional `fn` (outermost protected function in the subject op's cause chain, ≤ 80 chars) | shown as "top functions" |
| retention | n/a | dashboard data deleted after 90 days |

Server side: `telemetry-worker/src/collector.ts` (ingest, projects API, routing), `src/dashboard.ts` (D1 aggregation,
stats, retention), `src/pages.ts` (/start and /dashboard HTML), `migrations/` (D1 `genclass-dashboard`). Deployed on
genclass.dev routes `/start*`, `/dashboard*`, `/api/*`; see [telemetry-worker/README.md](../../telemetry-worker/README.md).

## Files

| file | what |
|---|---|
| `packages/runtime/src/token.ts` | `TOKEN_PATTERN`, `isValidToken`, `resolveToken` (malformed: one warning, ignored) |
| `packages/runtime/src/index.ts` | `createRuntime` resolves the token and passes it to `startTelemetry`; debug-only info line when telemetry is off; `GenClass.protect`; `setProtectResolver(() => current)` |
| `packages/runtime/src/telemetry/*` | `TelemetryConfig.token`, envelope `token`, `TelemetryClient.token`, `fn` on decision events |
| `packages/runtime/src/protect.ts` | `protect(name, fn)`, `setProtectResolver` (internal) |
| `packages/runtime/src/runtime.ts` | `RuntimeImpl.scope`, `runProtected`, `protectedFnOf`; the `scope` gate in `trigger()` and `runDelivery()`; `Decision.fn` in `onDecision` |
| `packages/runtime/src/cdn/config.ts`, `src/cdn/global.ts` | `token=` / `scope=` page-config keys (meta, `data-token`, `data-scope`); `window.GenClass.protect` |
| `packages/runtime/bin/lib/token.mjs` | `createProject` (10 s timeout, never rejects), `readLocal` / `saveLocal` (`.genclass.local`, `.gitignore`), `tokenInFiles` |
| `packages/runtime/bin/lib/init.mjs` | `chooseToken`, `tokenRow`, `dashboardNotice`; flags `--token`, `--no-token` |
| `packages/runtime/bin/lib/edit.mjs` | `token` in `configLiteral`, `updateConfigText`, `metaContent`, `tagWithConfig`, `switchMetaConfig`, `isEmptyConfig` |
| `packages/runtime/test/projects.test.ts` | runtime side (16 tests) |
| `packages/runtime/test/install/cli.test.ts`, `test/install/mock-fetch.mjs` | CLI side; every CLI run in the tests preloads a fake `fetch` (default: offline), so no test calls genclass.dev |

## CLI behaviour (`init`)

Order in `chooseToken`: `--no-telemetry` -> none; `--no-token` -> none; `--token` (validated at parse time; usage
error with `--no-token` or `--no-telemetry`) -> that token, no network; a token already in init's marked files ->
reuse, write nothing; `.genclass.local` -> reuse, write it into the setup; telemetry off in the existing setup -> none;
`--dry-run` -> none, no network; else create a project. A hand-written setup (GenClass imported without init's
markers) gets no token. The project is created before the diff is shown; `.genclass.local` is written only after
the changes are applied. If the user declines, the link is printed with "Nothing was written" and the
`init --token` command to use later. `remove` never deletes `.genclass.local` (the only copy of the link).

## Invariants and gotchas

- The token never reaches `RuntimeImpl`, situations or the model; `fn` is not model-visible (it is set on the
  `Decision` after the model answered). The op name of a protected call is model-visible like any `runtime.op` name.
- `scope: "functions"` must not change the situation text format (`situation-v2.x` is frozen): it only returns the
  passive action earlier. `projects.test.ts` checks the same subject gets an identical state under both scopes.
- `protect()` must never throw on its own and must keep sync functions sync; it resolves the runtime per call so it
  can wrap at import time. With the script tag, apps must use `window.GenClass.protect` (an npm copy has its own
  `GenClass.runtime`).
- Attribution is the runtime's normal best-effort causality (`trace/context.ts`): requests started inside the call or
  in continuations of its own observed requests and timers count; work started from unrelated callbacks does not.
  Code right after an awaited protected call, in the same task, is attributed to it too (as with `runtime.op`).

## Open

- Per-function mode (`protect(name, fn, { mode })`) is not implemented: route scopes are snapshotted per request and
  not inherited through the cause chain (`OPEN_TASKS.md`).
- `protect()`ed functions are not listed in an introspection API (no `runtime.functions()`).
