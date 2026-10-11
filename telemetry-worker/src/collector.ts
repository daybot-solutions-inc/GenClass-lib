// GenClass telemetry collector: a Cloudflare Worker that accepts batches from @genclass/runtime
// (packages/runtime/src/telemetry/*) and writes them, gzip-compressed JSON Lines, to R2.
//
// Privacy invariants (packages/runtime/TELEMETRY.md):
// - Never store the client IP, user agent, cookies or any request header. The only server-side additions are
//   `receivedAt` (ISO time) and `country` (Cloudflare's coarse two-letter `request.cf.country`).
// - Only the known top-level batch fields are kept; anything else is dropped.
// - Nothing from the request is logged (wrangler.toml disables observability).
//
// Routes: POST /v1/events (application/json or text/plain, so navigator.sendBeacon needs no CORS preflight),
// OPTIONS /v1/events (CORS preflight), GET /v1/health.
//
// Per-app tokens and dashboards (src/dashboard.ts, src/pages.ts; also routed on genclass.dev/{api/*,start*,dashboard*}):
// POST /api/projects, GET /api/projects/<secret>, GET /start, GET /dashboard/<secret>. A batch with a known top-level
// `token` is also aggregated into D1 for that app's dashboard; without one it is stored in R2 only, exactly as before.

import {
  aggregate,
  createProject,
  knownToken,
  projectBySecret,
  randomBase62,
  RANGES,
  sanitizeName,
  sha256Hex,
  stats,
  TOKEN_RE,
  type D1Like,
  type Range,
} from "./dashboard.js";
import { dashboardPage, notFoundPage, securityHeaders, startPage } from "./pages.js";

export const SCHEMA = "genclass-telemetry/1";
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_EVENTS = 500;

/** The subset of the R2 binding this worker uses (avoids a dependency on @cloudflare/workers-types). */
export interface BucketLike {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: Record<string, string> }): Promise<unknown>;
}

export interface RateLimiterLike {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  BUCKET: BucketLike;
  /** D1 `genclass-dashboard` (projects and aggregates). Without it the worker is the plain R2 collector. */
  DB?: D1Like;
  /** Workers Rate Limiting binding for project creation (10 / 60 s per client). */
  CREATE_LIMITER?: RateLimiterLike;
  /** Workers Rate Limiting binding for batches (60 / 60 s per client IP; the IP is only the counter key, never stored). */
  LIMIT?: RateLimiterLike;
  /** Service binding to the site worker (`genclass-site`), for genclass.dev paths this worker does not serve. */
  SITE?: { fetch(request: Request): Promise<Response> };
  /** Origin used in dashboard links (default https://genclass.dev). */
  DASHBOARD_ORIGIN?: string;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

export function reply(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Path-segment-safe version label: `[A-Za-z0-9._+-]`, at most 40 chars, else `fallback`. */
export function pathLabel(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const s = v.trim();
  return /^[A-Za-z0-9._+-]{1,40}$/.test(s) ? s : fallback;
}

export interface Batch {
  schema: string;
  sid: string;
  sent: number;
  runtime: string;
  model: string | null;
  /** Per-app token (`gc_` + 22 base62), only when present and well-formed. */
  token?: string;
  events: Record<string, unknown>[];
}

/** Validate a parsed body. Returns the normalised batch (unknown top-level fields dropped) or an error string. */
export function validate(body: unknown): Batch | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (b.schema !== SCHEMA) return `schema must be "${SCHEMA}"`;
  if (typeof b.sid !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(b.sid)) return "sid must be 8-64 chars [A-Za-z0-9_-]";
  if (typeof b.sent !== "number" || !Number.isFinite(b.sent)) return "sent must be a finite number";
  if (typeof b.runtime !== "string" || b.runtime.length === 0 || b.runtime.length > 40) return "runtime must be a version string";
  if (b.model !== null && b.model !== undefined && (typeof b.model !== "string" || b.model.length > 80)) {
    return "model must be a string or null";
  }
  if (!Array.isArray(b.events)) return "events must be an array";
  if (b.events.length === 0) return "events must not be empty";
  if (b.events.length > MAX_EVENTS) return `at most ${MAX_EVENTS} events per batch`;
  for (const e of b.events) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) return "each event must be an object";
    const t = (e as Record<string, unknown>).t;
    if (typeof t !== "string" || t.length === 0 || t.length > 32) return "each event needs a string type `t`";
  }
  return {
    schema: SCHEMA,
    sid: b.sid,
    sent: b.sent,
    runtime: b.runtime,
    model: typeof b.model === "string" ? b.model : null,
    // optional; a missing or malformed token never rejects the batch (it is simply not attributed to an app)
    ...(typeof b.token === "string" && TOKEN_RE.test(b.token) ? { token: b.token } : {}),
    events: b.events as Record<string, unknown>[],
  };
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Read the body with a hard byte cap (the Content-Length header may be absent or wrong). */
async function readCapped(request: Request, cap: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

export interface HandleOptions {
  /** Injected for tests. */
  now?: () => Date;
  uuid?: () => string;
  /** ctx.waitUntil in production (aggregation runs after the response); tests await inline. */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Requests on genclass.dev that this worker does not serve go on to the site (fetch in production). */
  passthrough?: (request: Request) => Promise<Response>;
}

export async function handle(request: Request, env: Env, opts: HandleOptions = {}): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/v1/health" && (request.method === "GET" || request.method === "HEAD")) {
    return reply(200, { ok: true, schema: SCHEMA });
  }
  if (path === "/v1/events" || path === "/api/v1/events") return ingest(request, env, opts);
  const site = await routeSite(request, url, path, env, opts);
  if (site) return site;
  // On genclass.dev, anything else under the routed prefixes belongs to the site.
  if (!url.hostname.endsWith(".workers.dev") && url.hostname !== "localhost" && opts.passthrough !== undefined) {
    return opts.passthrough(request);
  }
  return reply(404, { ok: false, error: "not found" });
}

async function ingest(request: Request, env: Env, opts: HandleOptions): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return reply(405, { ok: false, error: "method not allowed" });

  const ct = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json" && ct !== "text/plain") {
    return reply(415, { ok: false, error: "content-type must be application/json or text/plain" });
  }

  // Abuse guard: a sliding per-IP budget of batches (the runtime sends at most one every 10 s per page).
  if (env.LIMIT) {
    let ok = true;
    try {
      ok = (await env.LIMIT.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" })).success;
    } catch {
      /* the limiter is best effort */
    }
    if (!ok) return reply(429, { ok: false, error: "too many batches; slow down" });
  }

  const raw = await readCapped(request, MAX_BODY_BYTES);
  if (raw === null) return reply(413, { ok: false, error: `body over ${MAX_BODY_BYTES} bytes` });

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return reply(400, { ok: false, error: "invalid JSON" });
  }
  const batch = validate(parsed);
  if (typeof batch === "string") return reply(400, { ok: false, error: batch });

  const now = (opts.now ?? (() => new Date()))();
  const receivedAt = now.toISOString();
  // Coarse country only; never the IP, colo, city, ASN or any header.
  const cf = (request as unknown as { cf?: { country?: unknown } }).cf;
  const country = typeof cf?.country === "string" && /^[A-Z0-9]{2}$/.test(cf.country) ? cf.country : null;

  const meta = {
    sid: batch.sid, runtime: batch.runtime, model: batch.model, sent: batch.sent, receivedAt, country,
    ...(batch.token ? { token: batch.token } : {}),
  };
  const lines = batch.events.map((event) => JSON.stringify({ ...meta, event })).join("\n") + "\n";

  const dt = receivedAt.slice(0, 10);
  const rt = pathLabel(batch.runtime, "unknown");
  const model = pathLabel(batch.model, "none");
  const id = (opts.uuid ?? (() => crypto.randomUUID()))();
  const key = `events/dt=${dt}/rt=${rt}/model=${model}/${id}.jsonl.gz`;

  try {
    await env.BUCKET.put(key, await gzip(lines), {
      httpMetadata: { contentType: "application/gzip" },
    });
  } catch {
    return reply(503, { ok: false, error: "storage unavailable" });
  }

  // Dashboard aggregation for a known token. Never affects the response (failures are swallowed).
  const db = env.DB;
  if (batch.token && db) {
    const token = batch.token;
    const task = (async () => {
      if (await knownToken(db, token, now.getTime())) await aggregate(db, token, batch, now);
    })().catch(() => undefined);
    if (opts.waitUntil) opts.waitUntil(task);
    else await task;
  }
  return reply(202, { ok: true, accepted: batch.events.length });
}

// ------------------------------------------------------------------------------------------ tokens and dashboards

/** Global ceiling on project creation (all clients together). */
export const MAX_PROJECTS_PER_MINUTE = 60;

const PROJECT_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function html(status: number, body: string, nonce: string): Response {
  return new Response(body, { status, headers: securityHeaders(nonce) });
}

async function routeSite(request: Request, url: URL, path: string, env: Env, opts: HandleOptions): Promise<Response | null> {
  const m = request.method;
  const now = (opts.now ?? (() => new Date()))();

  if (path === "/api/projects") {
    if (m === "OPTIONS") return new Response(null, { status: 204, headers: PROJECT_CORS });
    if (m !== "POST") return json(405, { ok: false, error: "method not allowed" }, PROJECT_CORS);
    if (!env.DB) return json(503, { ok: false, error: "dashboards unavailable" }, PROJECT_CORS);
    if (env.CREATE_LIMITER) {
      // The limiter key is a hash of the client IP; the IP itself is never stored or logged.
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.CREATE_LIMITER.limit({ key: (await sha256Hex(`create:${ip}`)).slice(0, 32) });
      if (!success) return json(429, { ok: false, error: "too many projects created; try again in a minute" }, { ...PROJECT_CORS, "retry-after": "60" });
    }
    // Backstop for the (per-location, eventually consistent) limiter: a global ceiling on new projects per minute.
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE created > ?")
      .bind(new Date(now.getTime() - 60_000).toISOString())
      .first<{ n: number }>();
    if ((recent?.n ?? 0) >= MAX_PROJECTS_PER_MINUTE) {
      return json(429, { ok: false, error: "too many projects created; try again in a minute" }, { ...PROJECT_CORS, "retry-after": "60" });
    }
    const raw = await readCapped(request, 4096);
    if (raw === null) return json(413, { ok: false, error: "body too large" }, PROJECT_CORS);
    let body: unknown = {};
    const text = new TextDecoder().decode(raw).trim();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return json(400, { ok: false, error: "invalid JSON" }, PROJECT_CORS);
      }
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return json(400, { ok: false, error: "body must be a JSON object" }, PROJECT_CORS);
    const name = sanitizeName((body as Record<string, unknown>).name);
    const p = await createProject(env.DB, name, now);
    const origin = (env.DASHBOARD_ORIGIN ?? "https://genclass.dev").replace(/\/+$/, "");
    return json(201, { token: p.token, dashboardUrl: `${origin}/dashboard/${p.secret}`, name: p.name, created: p.created }, PROJECT_CORS);
  }

  const api = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (api) {
    if (m !== "GET" && m !== "HEAD") return json(405, { ok: false, error: "method not allowed" });
    const p = env.DB ? await projectBySecret(env.DB, api[1]!) : null;
    if (!p || !env.DB) return json(404, { ok: false, error: "not found" });
    const r = url.searchParams.get("range") as Range | null;
    const range: Range = r && RANGES.includes(r) ? r : "7d";
    return json(200, await stats(env.DB, p, range, now));
  }

  if (path === "/start") {
    if (m !== "GET" && m !== "HEAD") return null;
    const nonce = randomBase62(22);
    return html(200, startPage(nonce), nonce);
  }

  if (path === "/dashboard") {
    if (m !== "GET" && m !== "HEAD") return null;
    return new Response(null, { status: 302, headers: { location: "/start", "cache-control": "no-store" } });
  }

  const dash = /^\/dashboard\/([^/]+)$/.exec(path);
  if (dash) {
    if (m !== "GET" && m !== "HEAD") return null;
    const nonce = randomBase62(22);
    const p = env.DB ? await projectBySecret(env.DB, dash[1]!) : null;
    if (!p) return html(404, notFoundPage(nonce), nonce);
    return html(200, dashboardPage(nonce, { name: p.name, token: p.token, created: p.created, lastEvent: p.last_event }), nonce);
  }

  if (path.startsWith("/api/")) return json(404, { ok: false, error: "not found" });
  return null;
}
