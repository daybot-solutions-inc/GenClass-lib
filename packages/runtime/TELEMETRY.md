# GenClass Runtime telemetry

Since **`0.1.0-beta.3`**, `GenClass.init()` in a browser sends **anonymous diagnostics** about GenClass's own
decisions to the GenClass maintainers (Daybot Solutions Inc.). We use them to measure and improve the GenClass
model (accuracy, false interventions, latency, which situations it sees in real apps). This page lists exactly what
is sent, where it goes, and how to turn it off.

**Turn it off:** `GenClass.init({ telemetry: false })`, `?genclass=no-telemetry` in the URL, or
`localStorage.setItem("genclass.telemetry", "off")`. Browsers that send Global Privacy Control are never collected.
Details under [Opting out](#opting-out).

## When it is on

| how GenClass starts | default |
|---|---|
| `GenClass.init()`, `import "@genclass/runtime/auto"` (and `/auto/*`), the CDN script tag, `npx @genclass/runtime init` setups | **on** in a browser |
| `GenClass.init()` outside a browser (Node, SSR, workers) | off unless `telemetry: true` / `{ ... }` |
| `createRuntime()` (headless, tests, the simulator) | off unless `telemetry: true` / `{ ... }` |

When it is on, the console shows one notice per page:

```
[GenClass] Sends anonymous diagnostics (decisions, redacted situation text) to improve the model. Opt out: GenClass.init({ telemetry: false }) or ?genclass=no-telemetry.
```

`runtime.telemetry` reports `{ enabled, reason?, endpoint?, sessionId?, flush() }`; `reason` says why it is off
(`option`, `headless`, `url`, `localStorage`, `gpc`, `sampled-out`, `no-crypto`, `no-transport`, `kill-switch`,
`disabled`).

## What is sent

Only data the runtime already computes for its own decisions, after redaction:

- **The situation text the model read**, exactly as built for the model, after the redactor
  (`InitOptions.redact`, default: secret-named fields such as passwords, tokens, card numbers, API keys are replaced
  by `[redacted]`; see the README's [Privacy](README.md#privacy-and-telemetry) section for the rules and their known
  gaps). Situation text describes operations (e.g. `GET /api/items/:id`), store fields and short value summaries,
  timing and the facts GenClass computed. It can contain app data that the redactor does not recognise as secret
  (for example a product name or a search term). `include: { situation: false }` leaves it out.
- **Never:** typed values of password, payment (`cc-*`), one-time-code or secret-named inputs (the runtime never
  records them in the first place), cookies, request or response headers, request or response bodies, storage
  contents, the page's query string or fragment, the full URL, error messages or stack traces of your app, the
  sentences GenClass prints about what it changed, IP addresses or user agents (the collector does not store them).

### Batch envelope (schema `genclass-telemetry/1`)

`POST <endpoint>` with `content-type: text/plain;charset=UTF-8` (JSON body), no credentials, no referrer:

```jsonc
{
  "schema": "genclass-telemetry/1",
  "sid": "3f9c…",            // 24 hex chars from crypto.getRandomValues, new on every page load, never stored
  "sent": 12034,             // ms since this page's GenClass started (no wall-clock time is sent)
  "runtime": "0.1.0-beta.3", // @genclass/runtime version
  "model": "2.0.0-rc4t",     // model card version, or null without a model
  "events": [ /* ≤ 100 events, ≤ 60 KB per request */ ]
}
```

Every event has `t` (type), `seq` (0, 1, 2, … per page) and `at` (ms since start). Event types:

| `t` | when | fields |
|---|---|---|
| `session` | once, at init | `runtime`, `host` (the page's hostname, which identifies the app using GenClass), `route` (the page path with id-like segments replaced by `:id`, no query or fragment), `mode`, `effectiveMode`, `aggressiveness`, `sampled`, `model` (`local` / `custom` / `off`), `modelState`, `modelVersion`, `triage`, `shadow`, `holdWrites`, `device` (`webgpu` available, `cores`, `memoryGB` (the browser's coarse deviceMemory), `crossOriginIsolated`, `effectiveType`, `saveData`), `sample`, `situation` (whether situation text is included) |
| `model` | model state changes | `state`, `version`, `model`, `variant`, `device` (webgpu/wasm), `threads`, `worker`, `workerError`, `gpu` (WebGPU probe summary), `ort`, `loadMs`, `warmupMs`, `fromCache`, `bytes`, `phase`, `reason`, `error` (GenClass model-host error text, ≤ 200 chars), `attempts` |
| `status` | mode, aggressiveness or breaker changes | `mode`, `effectiveMode`, `aggressiveness`, `breaker` |
| `decision` | every model decision | `id`, `trigger`, `route`, `model`, `latencyMs`, `held` (the subject waited for the answer; false = decided in the background), `situation` (text, see above), `budget`, `compact`, `questions` (question ids), `answers` (per question: calibrated `probabilities` per label, `choice`, `confidence`; or `p` / `score`), `diagnosis`, `diagnosisConfidence`, `action` (chosen), `confidence`, `tier`, `candidate`, `ran`, `executed`, `acted`, `reason` (why the passive action ran), `mass`, `gateKind`, `threshold` / `gain` / `margin`, `thresholdSource`, `gates` (report/guard/heal thresholds, aggressiveness, level and sources), `effectiveMode`, `shadow` |
| `detect` | a decision reported as a detection | `decision`, `trigger`, `diagnosis`, `p` |
| `action` | an action ran, failed or was undone | `id`, `decision`, `action`, `tier`, `trigger`, `outcome` (`applied` / `failed` / `undone`), `late` (a late revert), `reversible`, `droppedFields` (count) |
| `veto` | `onBeforeAction` vetoed an action | `decision`, `action`, `enforced` |
| `breaker` | the breaker tripped or reset | `tripped`, `reason`, `undos`, `errors`, `decisions` (ids) |
| `model-error` | model errors (first 20 per page; all are counted) | `code`, `message` (≤ 200 chars) |
| `summary` | every ≥ 60 s with activity, when the tab is hidden, on pagehide and on destroy | `reason`, `counts` (decisions, acted, detections, actions applied/failed, late reverts, undos, vetoes, breaker trips, per trigger / diagnosis / action ran, detections per diagnosis, action limits hit, model errors per code, fail-opens per reason and trigger), `runtime` (model p50/p95 latency, decisions, dropped, hidden-tab skips, held time, denied and shadow counts, error count), `telemetry` (queued, dropped, send failures, events sent) |

Numbers are rounded to 4 decimals. The source of truth is `packages/runtime/src/telemetry/client.ts`.

### Transport

- Batches every 10 s (`flushMs`) of activity, and on `pagehide` / when the tab becomes hidden via
  `navigator.sendBeacon` (falling back to `fetch` with `keepalive`).
- The `fetch` and `sendBeacon` captured when `@genclass/runtime` loaded, so GenClass never observes, holds or decides
  about its own requests.
- At most 1,000 queued events; beyond that new events are dropped and counted. A failed request is dropped, never
  retried. Telemetry never throws into your app, never changes what the model sees, and never delays a decision.

## Where it goes

- **Endpoint:** `https://genclass-telemetry.mehar-144.workers.dev/v1/events` (`DEFAULT_TELEMETRY_ENDPOINT`), a
  Cloudflare Worker operated by the GenClass maintainers (source: `telemetry-worker/` in the repository).
- **Storage:** a private Cloudflare R2 bucket (`genclass-telemetry`), gzip JSON Lines, one object per batch,
  partitioned by UTC date, runtime version and model version. The collector adds only the time it received the
  batch and the visitor's coarse **country** (two letters, from Cloudflare). It does not store IP addresses, user
  agents, cookies or any request header, and it drops unknown fields.
- **Use:** model evaluation and training by the GenClass maintainers. Not sold, not used for advertising.
- **Retention:** to be decided by the owner (see `OPEN_TASKS.md`); until then data is kept until deleted.
- **Your own endpoint:** `telemetry: { endpoint: "https://…" }` sends the same batches to a collector you run
  instead (the worker in `telemetry-worker/` deploys to any Cloudflare account).

## Options

```ts
GenClass.init({
  telemetry: {
    endpoint: "https://…",          // default DEFAULT_TELEMETRY_ENDPOINT
    sample: 0.25,                    // fraction of page loads that send (default 1)
    flushMs: 10_000,                 // batch interval
    maxBatch: 100,                   // events per request
    include: { situation: false },   // leave the situation text out
  },
});
```

`telemetry: true` is the defaults; `telemetry: false` turns it off.

## Opting out

Any one of these turns telemetry off for the page:

| how | who |
|---|---|
| `GenClass.init({ telemetry: false })` (or `window.GENCLASS_CONFIG = { telemetry: false }`, `<meta name="genclass" content="telemetry=off">`, `data-telemetry="off"` on the script tag) | the app developer |
| `?genclass=no-telemetry` in the page URL (`?genclass=off` turns GenClass off entirely) | anyone, for one page load |
| `localStorage.setItem("genclass.telemetry", "off")` | a user or tester, persistent per origin |
| **Global Privacy Control**: `navigator.globalPrivacyControl === true` | the user's browser setting |

**Global Privacy Control (GPC).** California law (CCPA as amended by the CPRA, and its regulations) requires
businesses to treat a GPC signal as a valid request to opt out of the sale or sharing of personal information, and
other US state laws (e.g. Colorado, Connecticut) recognise universal opt-out signals. GenClass honours GPC for every
visitor, wherever they are: when the browser sends it, nothing is collected.

## If you ship GenClass in your app

The data is collected from **your** users' browsers. Even though it is designed to be anonymous (random per-page
session id, no IP or user agent stored, redacted text), situation text can contain fragments of your app's data and
the session event names your hostname. Depending on your users and jurisdiction you may need to:

- mention GenClass diagnostics in your privacy policy / cookie or tracking disclosures (GDPR transparency,
  Articles 13 and 14; CCPA notice at collection);
- decide whether it needs consent where you require consent for analytics (GDPR / ePrivacy), and if so start
  GenClass with `telemetry: false` until consent is given (`GenClass.init()` reads the option once; to switch it on
  later, create the runtime after consent);
- turn it off (`telemetry: false`) in apps that handle regulated data (health, finance, children's services): a
  custom `redact` lowers what reaches situation text but does not guarantee that nothing sensitive does.

The GenClass maintainers' privacy policy and data processing terms for this collection are not published yet
(`OPEN_TASKS.md`). Until they are, if you cannot disclose a third-party diagnostics recipient, set
`telemetry: false`.
