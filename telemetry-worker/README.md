# genclass-telemetry (collector, per-app tokens and dashboards)

Cloudflare Worker that receives the default-on diagnostics batches from `@genclass/runtime` (see
[`packages/runtime/TELEMETRY.md`](../packages/runtime/TELEMETRY.md)) and stores them in R2, and that gives every web app
a token and a private dashboard on genclass.dev.

- **Deployed:** worker `genclass-telemetry`, account `144bd5f5270b51dbe7faf46227a154f0`.
  - `https://genclass-telemetry.mehar-144.workers.dev` (workers.dev). The runtime's `DEFAULT_TELEMETRY_ENDPOINT` is this
    URL + `/v1/events`.
  - Zone routes on genclass.dev: `genclass.dev/start*`, `genclass.dev/dashboard*`, `genclass.dev/api/*`. They run in
    front of the site (worker `genclass-site`, custom domain, owned by Mehar; this worker never changes it). Paths
    under `/start*` and `/dashboard*` that this worker does not serve are handed to the site unchanged through the
    `SITE` service binding (a plain `fetch()` from a route to a custom-domain origin returns 522).
- **Storage:**
  - R2 bucket `genclass-telemetry`: one gzip JSON Lines object per accepted batch at
    `events/dt=YYYY-MM-DD/rt=<runtime version>/model=<model version|none>/<uuid>.jsonl.gz` (date = server UTC date).
    Each line is `{ sid, runtime, model, sent, receivedAt, country, event }`, plus `token` when the batch carried a
    well-formed one (known or not). Batches without a token are stored exactly as before.
  - D1 database `genclass-dashboard` (`694d7d16-8a47-4810-8e0d-e9c89533460a`): projects and dashboard counters (below).
- **Retention:** 90 days.
  - R2: lifecycle rule `expire-90d` (prefix `events/`, set 2026-10-09):
    `npx --yes wrangler@4 r2 bucket lifecycle add genclass-telemetry expire-90d events/ --expire-days 90`.
    Check it with `npx --yes wrangler@4 r2 bucket lifecycle list genclass-telemetry`.
  - D1: a daily Cron Trigger (`17 3 * * *`, `scheduled` in `src/index.ts`, `retention()` in `src/dashboard.ts`)
    deletes `daily` and `recent` rows older than 90 days, `hourly` rows older than 48 hours and `sessions` rows older
    than 2 days. Projects themselves (token, name, hash of the secret) are kept until deleted.

## Architecture

```
browser (@genclass/runtime) --POST /v1/events {token?, ...}--> genclass-telemetry
                                                                 |-- R2: raw batch (always, as before)
                                                                 '-- token known? -> D1 counters (ctx.waitUntil, one db.batch)
genclass.dev/start            --> /start page --POST /api/projects--> D1 projects (token, sha256(secret))
genclass.dev/dashboard/<secret> --> dashboard page --GET /api/projects/<secret>?range=--> D1 counters
```

| file | what |
|---|---|
| `src/index.ts` | entry point: default export only (`fetch`, `scheduled`). The Workers runtime treats every named export of the main module as an entrypoint, so nothing else is exported here. |
| `src/collector.ts` | ingest (`POST /v1/events`), envelope validation (incl. optional `token`), routing for `/api/*`, `/start`, `/dashboard*` |
| `src/dashboard.ts` | ids and hashing, project creation and lookup, token cache, aggregation of a batch into counters, stats for the dashboard, retention |
| `src/pages.ts` | HTML/CSS/JS for `/start` and `/dashboard/<secret>` (inline, per-response CSP nonce, no external resources) |
| `migrations/*.sql` | D1 schema |
| `test/index.test.ts`, `test/dashboard.test.ts` | unit tests (R2 mocked; D1 = `node:sqlite` running the real migrations) |

## Endpoints

| route | behaviour |
|---|---|
| `POST /v1/events` (also `/api/v1/events`) | body `{ schema: "genclass-telemetry/1", sid, sent, runtime, model, token?, events: [{ t, ... }] }`; content-type `application/json` or `text/plain` (sendBeacon / no CORS preflight). 202 `{ ok, accepted }`; 400 bad shape/JSON; 413 over 256 KB; 415 other content type; 503 R2 failure. A missing, malformed (`^gc_[A-Za-z0-9]{22}$`) or unknown `token` never changes the response. |
| `OPTIONS /v1/events` | CORS preflight (`access-control-allow-origin: *`) |
| `GET /v1/health` | `{ ok: true, schema }` |
| `POST /api/projects` | body `{ name? }` (JSON object or empty; name sanitised, at most 80 chars, default "Untitled app"). 201 `{ token, dashboardUrl, name, created }`, `dashboardUrl` = `https://genclass.dev/dashboard/<32 base62>`. CORS `*`, no credentials. 429 JSON when rate-limited, 400 bad JSON, 413 over 4 KB. |
| `GET /api/projects/<secret>?range=24h\|7d\|30d` | dashboard stats JSON (default `7d`): `name, token, created, lastEvent, range, from, generated, totals, breakdowns{metric: [{key,count}]}` (top 25 each), `series` (24 hourly or 7/30 daily buckets: sessions, decisions, detections, acted), `recent` (last 50 detections/interventions in the window). 404 `{ ok:false, error:"not found" }` for an unknown or malformed secret. Same-origin only (no CORS). |
| `GET /start` | "Get a token" page |
| `GET /dashboard/<secret>` | the dashboard (404 page for an unknown secret); `GET /dashboard` redirects to `/start` |

Rate limits on project creation: the Workers Rate Limiting binding `CREATE_LIMITER` (10 per 60 s per client, keyed by
a SHA-256 of `cf-connecting-ip`; the IP is never stored; the binding is per location and eventually consistent, so it
is approximate) plus a global ceiling of 60 new projects per minute checked in D1.

Page and stats responses send `cache-control: no-store`, `referrer-policy: no-referrer`, `x-robots-tag: noindex`,
and the pages a strict CSP (`default-src 'none'`, scripts and styles only with the response's nonce,
`connect-src 'self'`, `frame-ancestors 'none'`). All dynamic text is inserted with `textContent`.

Limits: 256 KB body, 500 events per batch, `sid` 8-64 chars `[A-Za-z0-9_-]`, every event an object with a string `t`.
Unknown top-level fields are dropped. Event objects are stored in R2 as sent (the client defines them).

## Tokens and secrets

- **Token** `gc_` + 22 base62 (about 131 bits) from `crypto.getRandomValues` (rejection-sampled, unbiased). Public: it
  ships in the app's code and only attributes data to the app.
- **Dashboard secret** 32 base62 (about 190 bits). Private; shown once at creation. D1 stores only its SHA-256 hex
  (`projects.secret_hash`), and lookups go by that hash. There is no recovery: a lost link means a new token.
- Token lookups during ingest are cached in memory per isolate (5 min for known tokens, 30 s for unknown ones).

## D1 schema (`migrations/`)

| table | columns | notes |
|---|---|---|
| `projects` | `token` PK, `secret_hash` UNIQUE, `name`, `created`, `last_event` | one row per app |
| `daily` | `token, day (YYYY-MM-DD), metric, key, count` PK(token, day, metric, key) | counters per UTC day; `key` is the breakdown value, `''` for totals |
| `hourly` | `token, hour (YYYY-MM-DDTHH), metric, key, count` | same counters per UTC hour, kept 48 h (the 24 h view) |
| `recent` | `id, token, t, route, fn, trigger, diagnosis, action, ran, confidence, mode, executed, acted, kind` | last 500 detections / acted decisions per token; never situation text |
| `sessions` | `sid_hash, token, day, counts` | last cumulative `summary` counters per page load (SHA-256 of token + sid), so repeated summaries count once; kept 2 days |

Metrics (`daily.metric`/`hourly.metric`; `key` in brackets):

| from event | metrics |
|---|---|
| `session` | `sessions`, `host` [hostname], `page_route` [route], `runtime` [version], `model_version` [version], `mode` [effectiveMode], `model_kind` [local/custom/off], `webgpu_available` [yes/no] |
| `model` | `model_state` [state], `model_ready`, `backend` [webgpu/wasm], `model_load_ms_sum` / `model_load_ms_n`, `model_from_cache`, `model_load_failed` |
| `decision` | `decisions`, `trigger`, `route`, `fn`, `diagnosis`, `decision_mode`, `executed`, `acted`, `acted_action` [ran], `fn_acted`, `latency_ms_sum` / `latency_ms_n`, `latency_bucket` |
| `detect` | `detections`, `detect_diagnosis`, `detect_trigger`, `detect_route`, `fn_detect` (route/fn from the decision in the same batch) |
| `action` | `action_outcome` [applied/failed/undone], `intervention` [action, applied only] |
| `veto`, `breaker`, `model-error` | `vetoes`, `breaker_trips`, `model_error_events` [code] |
| `summary` (delta per page load) | `fail_open` [reason:trigger], `model_errors` [code] |

Each batch is aggregated in one `db.batch()` (multi-row upserts `count = count + excluded.count`, at most 300 distinct
counters per batch), plus one `SELECT` when the batch has a `summary`. Aggregation runs in `ctx.waitUntil` after the
202 and its failures are swallowed, so D1 can never break ingest.

## Privacy invariants

The worker never stores or logs the client IP, user agent, cookies or any other request header. The only server
additions are `receivedAt` (ISO time) and `country` (Cloudflare's two-letter `request.cf.country`; null if absent).
The dashboard store holds counters, hostnames, routes, function names, labels and versions, never situation text,
session ids (only a hash, for 2 days) or the dashboard secret (only its hash). Workers observability/logs are disabled
in `wrangler.toml`. Tests assert that headers, the city and the situation text never reach the stores.

## Develop / deploy

```sh
cd telemetry-worker
../node_modules/.bin/vitest run --root .                              # unit tests (Node 22.5+ for node:sqlite)
npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote  # new migrations first
npx --yes wrangler@4 deploy                                           # worker, routes, cron (wrangler login to the account above)
curl https://genclass-telemetry.mehar-144.workers.dev/v1/health
```

Local: `npx --yes wrangler@4 d1 migrations apply genclass-dashboard --local`, then `npx --yes wrangler@4 dev --local`
and open `http://localhost:8787/start` (dashboard links point at genclass.dev; replace the origin with localhost).

There is no `wrangler r2 object list`; list keys with the Cloudflare API
(`GET /client/v4/accounts/<id>/r2/buckets/genclass-telemetry/objects?prefix=events/`) or the dashboard, then
`npx --yes wrangler@4 r2 object get "genclass-telemetry/<key>" --remote --file out.gz`.

### Delete a project

With the token (`gc_...`), or find it by name with
`npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "SELECT token, name, created FROM projects WHERE name = 'My app'"`:

```sh
T=gc_XXXXXXXXXXXXXXXXXXXXXX
npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "
  DELETE FROM daily WHERE token = '$T'; DELETE FROM hourly WHERE token = '$T';
  DELETE FROM recent WHERE token = '$T'; DELETE FROM sessions WHERE token = '$T';
  DELETE FROM projects WHERE token = '$T';"
```

The dashboard link then returns 404 and later batches with that token are stored in R2 only (the in-memory token cache
may keep aggregating for up to 5 minutes). Raw R2 objects are not indexed by token; they expire after 90 days.
