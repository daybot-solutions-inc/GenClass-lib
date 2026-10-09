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

export const SCHEMA = "genclass-telemetry/1";
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_EVENTS = 500;

/** The subset of the R2 binding this worker uses (avoids a dependency on @cloudflare/workers-types). */
export interface BucketLike {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: Record<string, string> }): Promise<unknown>;
}

export interface Env {
  BUCKET: BucketLike;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function reply(status: number, body: unknown): Response {
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
}

export async function handle(request: Request, env: Env, opts: HandleOptions = {}): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/v1/health" && (request.method === "GET" || request.method === "HEAD")) {
    return reply(200, { ok: true, schema: SCHEMA });
  }
  if (path !== "/v1/events") return reply(404, { ok: false, error: "not found" });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return reply(405, { ok: false, error: "method not allowed" });

  const ct = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json" && ct !== "text/plain") {
    return reply(415, { ok: false, error: "content-type must be application/json or text/plain" });
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

  const meta = { sid: batch.sid, runtime: batch.runtime, model: batch.model, sent: batch.sent, receivedAt, country };
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
  return reply(202, { ok: true, accepted: batch.events.length });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env).catch(() => reply(500, { ok: false, error: "internal error" }));
  },
};
