# genclass-telemetry (collector)

Cloudflare Worker that receives the default-on diagnostics batches from `@genclass/runtime` (see
[`packages/runtime/TELEMETRY.md`](../packages/runtime/TELEMETRY.md)) and stores them in R2.

- **Deployed:** `https://genclass-telemetry.mehar-144.workers.dev` (worker `genclass-telemetry`, workers.dev route). The runtime's `DEFAULT_TELEMETRY_ENDPOINT` is this URL + `/v1/events`.
- **Storage:** R2 bucket `genclass-telemetry`, one gzip JSON Lines object per accepted batch at
  `events/dt=YYYY-MM-DD/rt=<runtime version>/model=<model version|none>/<uuid>.jsonl.gz` (date = server UTC date).
  Each line is `{ sid, runtime, model, sent, receivedAt, country, event }`.
- **Retention:** 90 days, enforced by the R2 lifecycle rule `expire-90d` (prefix `events/`, set 2026-10-09):
  `npx --yes wrangler@4 r2 bucket lifecycle add genclass-telemetry expire-90d events/ --expire-days 90`.
  Check it with `npx --yes wrangler@4 r2 bucket lifecycle list genclass-telemetry`.

## Routes

| route | behaviour |
|---|---|
| `POST /v1/events` | body `{ schema: "genclass-telemetry/1", sid, sent, runtime, model, events: [{ t, ... }] }`; content-type `application/json` or `text/plain` (sendBeacon / no CORS preflight). 202 `{ ok, accepted }`; 400 bad shape/JSON; 413 over 256 KB; 415 other content type; 503 R2 failure |
| `OPTIONS /v1/events` | CORS preflight (`access-control-allow-origin: *`) |
| `GET /v1/health` | `{ ok: true, schema }` |

Limits: 256 KB body, 500 events per batch, `sid` 8-64 chars `[A-Za-z0-9_-]`, every event an object with a string `t`.
Unknown top-level fields are dropped. Event objects are stored as sent (the client defines them).

## Privacy invariants

The worker never stores or logs the client IP, user agent, cookies or any other request header. The only server
additions are `receivedAt` (ISO time) and `country` (Cloudflare's two-letter `request.cf.country`; null if absent).
Workers observability/logs are disabled in `wrangler.toml`. `test/index.test.ts` asserts that headers and the city never
reach the stored object.

## Develop / deploy

```sh
cd telemetry-worker
../node_modules/.bin/vitest run --root .          # unit tests (Node; R2 mocked)
npx --yes wrangler@4 deploy                         # deploy (needs wrangler login to the account above)
curl https://genclass-telemetry.mehar-144.workers.dev/v1/health
```

There is no `wrangler r2 object list`; list keys with the Cloudflare API
(`GET /client/v4/accounts/<id>/r2/buckets/genclass-telemetry/objects?prefix=events/`) or the dashboard, then
`npx --yes wrangler@4 r2 object get "genclass-telemetry/<key>" --remote --file out.gz`.
