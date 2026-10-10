# Telemetry: runtime client and Cloudflare collector

> **Scope:** `packages/runtime/src/telemetry/*`, the telemetry wiring in `packages/runtime/src/{index,runtime,types,version}.ts`
> and `src/cdn/config.ts`, `packages/runtime/test/telemetry.test.ts`, `packages/runtime/TELEMETRY.md` (the public
> disclosure) and `telemetry-worker/` (the collector).
> **Read this when:** you touch anything the telemetry sends, its defaults or opt-outs, the collector, the R2 data, or
> any doc that makes a privacy claim.
> **Source of truth:** the code. Verified against branch `mvp-v2-b6` at the `0.1.0-beta.3` release-prep commits
> (2026-10-09). If this doc and the code disagree, the code wins.

## TL;DR

- Since `0.1.0-beta.3`, **`GenClass.init()` in a browser sends anonymous diagnostics by default** (owner decision,
  2026-10-09). `createRuntime()` and `GenClass.init()` outside a browser send nothing unless `telemetry` is set.
  The sim never sets it; the realapps harness passes `telemetry: false` (`realapps/src/world/index.ts`).
- **Agreed conditions (binding):** disclosed (one console notice per page, `TELEMETRY.md`, both READMEs, CHANGELOG
  flags it as privacy-relevant); only redacted data the runtime already has (the situation text exactly as given
  to the model, after the redactor; never raw input values of password/payment/secret fields); easy opt-out; GPC
  honoured; the collector stores no IP or user agent. Do not widen what is sent without the owner's OK and a
  `TELEMETRY.md` + CHANGELOG update.
- Telemetry is **read-only** on the runtime and never feeds a decision: it does not touch `src/situation/*` or any
  model-visible text (rule 2), and a test asserts the model input is byte-identical with and without it.
- Collector: Cloudflare Worker `genclass-telemetry` at `https://genclass-telemetry.mehar-144.workers.dev`
  (account `144bd5f5270b51dbe7faf46227a154f0`, logged in as mehar@daybot.ca), R2 bucket `genclass-telemetry`.

## Files

| file | what |
|---|---|
| `packages/runtime/src/telemetry/config.ts` | `DEFAULT_TELEMETRY_ENDPOINT`, `TELEMETRY_SCHEMA` (`genclass-telemetry/1`), `TELEMETRY_NOTICE`, `resolveTelemetry` (defaults, opt-outs, sampling, session id) |
| `packages/runtime/src/telemetry/transport.ts` | `nativeTransport`: `fetch` and `navigator.sendBeacon` captured at module load; text/plain, keepalive, `credentials: "omit"`, `referrerPolicy: "no-referrer"` |
| `packages/runtime/src/telemetry/client.ts` | `TelemetryClient`: listeners -> events, queue (`MAX_QUEUE` 1000), batching (`maxBatch`, `MAX_REQUEST_BYTES` 60,000), flush timer on the runtime `Clock`, pagehide / hidden-tab beacon, summaries (`SUMMARY_MS` 60 s), `telemetryOff` |
| `packages/runtime/src/telemetry/index.ts` | `startTelemetry` (called by `createRuntime`), the once-per-page console notice |
| `packages/runtime/src/version.ts` | `RUNTIME_VERSION` (must equal package.json; a test checks it; bump with every release) |
| `packages/runtime/src/runtime.ts` | `RuntimeTap` / `RuntimeImpl.tap` (model errors, fail-opens: `not-ready`, `no-answer`, `error`), `decisionInfo(id)` (situation text, held, budget, compact, gates, `autoState`: discovered state recorded, so `client.ts` omits the situation text; branch `feat/one-line`), `addTeardown(fn)` (final flush on destroy), `ExplainRec.held/budget/compact` |
| `packages/runtime/src/index.ts` | `createRuntime` -> `startTelemetry(rt, options.telemetry, false, info)`; `GenClass.init` browser branch sets `telemetry: options.telemetry ?? true`; the `?genclass=off` kill switch -> `telemetryOff("kill-switch")` |
| `packages/runtime/src/types.ts` | `InitOptions.telemetry`, `TelemetryOptions`, `TelemetryTransport`, `TelemetryStatus`, `Runtime.telemetry?` |
| `packages/runtime/src/cdn/config.ts` | `telemetry=off` page-config key (meta tag, `data-telemetry`) |
| `packages/runtime/test/telemetry.test.ts` | 13 tests: defaults, every opt-out incl. GPC, batching / bounded queue, pagehide + hidden beacon, event shapes, situation text == `stateText(req.state)` of the model input, secrets absent, transport errors, model input unchanged, native fetch not observed |
| `packages/runtime/TELEMETRY.md` | public disclosure and schema (ships in the npm package) |
| `telemetry-worker/{wrangler.toml,src/index.ts,test/index.test.ts,README.md}` | collector (6 tests: `../node_modules/.bin/vitest run --root .` in `telemetry-worker/`) |

## Behaviour

- **Resolution order** (`resolveTelemetry`): `telemetry: false` -> not explicitly set and not `GenClass.init` in a
  browser (`headless`) -> `?genclass=no-telemetry|off` (any `genclass` URL value) -> `localStorage["genclass.telemetry"] === "off"`
  -> `navigator.globalPrivacyControl === true` (`gpc`) -> no `crypto.getRandomValues` (`no-crypto`; never
  `Math.random`) -> `sample` draw (`sampled-out`) -> no transport. `enabled: false` in `createRuntime` -> `disabled`.
- **Session id:** 12 random bytes as 24 hex chars, per page load, never stored. Times are ms since the client started
  (`rt.clock`); the collector adds `receivedAt`.
- **Events** (`t`): `session`, `model`, `status`, `decision`, `detect`, `action` (`applied` / `failed` / `undone`,
  `late`), `veto`, `breaker`, `model-error` (first 20), `summary` (≥ 60 s with activity on the flush timer, hidden,
  pagehide, destroy). Field lists: `TELEMETRY.md`. Not sent: `ActionRecord.error` / `.changed`, `Decision.subject`
  and `facts` as separate fields (they are in the situation text), `ask()` / `decide()` questions, app error messages.
- **Transport:** flush every `flushMs` (10 s) while events are queued; `navigator.sendBeacon` on pagehide / hidden
  (fallback keepalive fetch). Requests ≤ 60 KB (the keepalive / beacon limit) and ≤ `maxBatch` events; a single event
  that cannot fit is dropped and counted. Failures are counted (`summary.telemetry.sendFailures`) and dropped.
- **Never observed:** the transport uses the fetch captured when `src/telemetry/transport.ts` loaded, before
  `createRuntime` wraps `globalThis.fetch` (same idea as `index.ts` -> `NATIVE_FETCH` for the model).

## Collector

- `POST /v1/events` (`application/json` or `text/plain`), `OPTIONS` preflight, `GET /v1/health`; CORS `*`; 256 KB,
  500 events; validates the envelope (`schema`, `sid` 8-64 `[A-Za-z0-9_-]`, `sent`, `runtime`, `model`, `events[].t`)
  and keeps only those top-level fields; adds `receivedAt` and `request.cf.country`; never reads IP, UA, cookies
  or headers; observability disabled.
- R2 key: `events/dt=YYYY-MM-DD/rt=<runtime>/model=<model|none>/<uuid>.jsonl.gz`; one line per event:
  `{ sid, runtime, model, sent, receivedAt, country, event }`.
- Deploy: `cd telemetry-worker && npx --yes wrangler@4 deploy`. List objects: Cloudflare API
  `GET /client/v4/accounts/<id>/r2/buckets/genclass-telemetry/objects?prefix=events/` (wrangler has no list);
  read with `npx --yes wrangler@4 r2 object get "genclass-telemetry/<key>" --remote --file out.gz`.
- **Retention: 90 days**, by the R2 lifecycle rule `expire-90d` on prefix `events/` (set 2026-10-09; owner may change it).

## How to change it safely

- Adding a field or event: only data the runtime already has, redacted; update `client.ts`, `TELEMETRY.md` (the
  table), the CHANGELOG (privacy-relevant), `test/telemetry.test.ts`; get the owner's OK. Bump `TELEMETRY_SCHEMA`
  for incompatible changes (and accept both in the worker for a while).
- Never read from telemetry inside a decision, never make telemetry change situation building, never schedule with
  global timers (use `rt.clock`), never let it throw.
- Changing the endpoint: `DEFAULT_TELEMETRY_ENDPOINT`, `TELEMETRY.md`, `telemetry-worker/README.md`, the test that
  pins it.
- Tests that call `GenClass.init` with a fake `window`/`document` turn telemetry on: inject a transport or stub
  `fetch` before importing (see `telemetry.test.ts`), so unit tests never reach the real collector.

## Drift and open issues

- Owner decisions open: a published privacy policy page and data processing terms (`OPEN_TASKS.md`). Retention: 90 days.
- The demos (`demos/src/shared/genclass.ts`) and `test/smoke/smoke.sh` call `GenClass.init` in a real browser and
  would send telemetry when run; they were left unchanged (honest-evaluation separation for demos). Add
  `?genclass=no-telemetry` or `telemetry: false` there if those runs should not reach the collector.
- `sendBeacon` sends the page's `Referer` per the document's policy (cannot be turned off); the collector ignores it.
- The `init` CLI does not mention telemetry in its output yet.
