// fetch observer (CONTRACT §3, §6, §7). Wraps global.fetch:
//   - creates the request op synchronously inside the call (cause = ambient op);
//   - request identity = method + URL + semantic headers + body content (bodies that cannot be read cheaply get a
//     unique identity: they are never "identical" to anything);
//   - request gate: triage, and when salient the request waits for the model (send/coalesce/delay/block/
//     serve_cached), fail-open after the hold budget; keepalive requests are never held;
//   - failure gate: network errors, timeouts, 5xx/429/408 wait for the model before the app sees them
//     (deliver/retry/serve_cached);
//   - stall watch: far past the learned latency, the model may hedge or serve a cached response;
//   - the app always gets its own Response; GenClass buffers a clone for coalescing and the GET cache;
//   - context: the op is ambient when the fetch promise and the Response body methods settle.
// Whatever an action does, the app's promise always settles: a failed action falls back to sending.

import type { NetHost, Controller, ActionEffect } from "../decide/exec.js";
import type { ReqMeta, FailureInfo } from "../situation/env.js";
import type { OpRec } from "../trace/ops.js";
import { opLabel } from "../situation/describe.js";
import { parseJsonBody } from "../situation/content.js";
import { describe, fnv1a, IDEMPOTENT_METHODS, parseUrl, redactSearch, requestSignature, secs, stableStringify, truncate } from "../util.js";
import { blockedResponse, bufferResponse, makeResponse, type Buffered } from "./cache.js";

type FetchFn = (input: unknown, init?: Record<string, unknown>) => Promise<Response>;

/** Bodies up to this size are read to compute the request identity. */
export const IDENTITY_BODY_MAX = 64 * 1024;
const STRING_BODY_MAX = 1024 * 1024;
const IDENTITY_READ_MS = 100;
/** A coalesced request waits at most this long for the identical one's response, then sends itself. */
const COALESCE_MAX_WAIT_MS = 8000;
const SUMMARY_PARSE_MAX = 16 * 1024;

/** Per-request tracing headers that do not change what a request means. */
const VOLATILE_HEADERS = new Set([
  "traceparent",
  "tracestate",
  "baggage",
  "sentry-trace",
  "x-request-id",
  "x-correlation-id",
  "request-id",
  "x-amzn-trace-id",
  "x-cloud-trace-context",
  "b3",
  "x-b3-traceid",
  "x-b3-spanid",
  "x-b3-parentspanid",
  "x-b3-sampled",
  "x-b3-flags",
  "x-datadog-trace-id",
  "x-datadog-parent-id",
  "x-datadog-sampling-priority",
  "x-datadog-origin",
  "newrelic",
  "date",
  "x-request-start",
  "x-genclass",
]);

interface BodyInfo {
  /** Identity key of the body ("" = no body). Undefined while `pending`. */
  key?: string;
  pending?: Promise<string>;
  bytes: number;
  replayable: boolean;
  summary: string;
}

function isRequestLike(x: unknown): x is Request {
  return typeof x === "object" && x !== null && typeof (x as Request).url === "string" && typeof (x as Request).method === "string" && typeof (x as Request).clone === "function";
}

function bytesKey(u8: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i];
    h = Math.imul(h, 0x01000193);
  }
  return "b:" + (h >>> 0).toString(16).padStart(8, "0") + ":" + u8.length;
}

/** Read up to IDENTITY_BODY_MAX bytes of a stream: the bytes' key, or null when larger (cancelled). */
async function readKey(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > IDENTITY_BODY_MAX) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return bytesKey(out);
}

function summarizeText(s: string, redact: NetHost["redact"]): string {
  const t = s.trim();
  if (t.length <= SUMMARY_PARSE_MAX && (t.startsWith("{") || t.startsWith("["))) {
    try {
      return describe(JSON.parse(t), "body", redact(), 60);
    } catch {
      /* not JSON */
    }
  }
  return `${s.length} bytes`;
}

export function bodyInfo(body: unknown, host: Pick<NetHost, "redact" | "uniqueId">): BodyInfo {
  if (body === undefined || body === null) return { key: "", bytes: 0, replayable: true, summary: "" };
  if (typeof body === "string") {
    const key = body.length <= 256 ? "s:" + body : body.length <= STRING_BODY_MAX ? `S:${fnv1a(body)}:${body.length}` : host.uniqueId();
    return { key, bytes: body.length, replayable: true, summary: summarizeText(body, host.redact) };
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    const s = body.toString();
    return { key: "q:" + s, bytes: s.length, replayable: true, summary: redactSearch("?" + s, host.redact(), 60) };
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const parts: string[] = [];
    let bytes = 0;
    let files = false;
    body.forEach((v, k) => {
      if (typeof v === "string") {
        parts.push(`${k}=${v}`);
        bytes += v.length;
      } else {
        files = true;
        bytes += (v as Blob).size;
      }
    });
    return { key: files ? host.uniqueId() : "f:" + fnv1a(parts.join("&")), bytes, replayable: true, summary: `form ${parts.length + (files ? 1 : 0)} fields` };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    const info: BodyInfo = { bytes: body.size, replayable: true, summary: `${body.size} bytes` };
    if (body.size > IDENTITY_BODY_MAX) info.key = host.uniqueId();
    else info.pending = body.arrayBuffer().then((b) => bytesKey(new Uint8Array(b)));
    return info;
  }
  if (body instanceof ArrayBuffer) {
    return { key: body.byteLength <= IDENTITY_BODY_MAX ? bytesKey(new Uint8Array(body)) : host.uniqueId(), bytes: body.byteLength, replayable: true, summary: `${body.byteLength} bytes` };
  }
  if (ArrayBuffer.isView(body)) {
    const u8 = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { key: u8.length <= IDENTITY_BODY_MAX ? bytesKey(u8) : host.uniqueId(), bytes: body.byteLength, replayable: true, summary: `${body.byteLength} bytes` };
  }
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return { key: host.uniqueId(), bytes: 0, replayable: false, summary: "stream" };
  const s = stableStringify(body, 4096);
  return { key: "j:" + fnv1a(s), bytes: s.length, replayable: true, summary: truncate(s, 40) };
}

function headerPairs(h: unknown, out: Map<string, string>): void {
  if (!h) return;
  try {
    if (typeof (h as Headers).forEach === "function" && !Array.isArray(h)) {
      (h as Headers).forEach((v, k) => out.set(k.toLowerCase(), String(v)));
    } else if (Array.isArray(h)) {
      for (const pair of h) if (Array.isArray(pair) && pair.length >= 2) out.set(String(pair[0]).toLowerCase(), String(pair[1]));
    } else if (typeof h === "object") {
      for (const [k, v] of Object.entries(h as Record<string, unknown>)) if (v !== undefined) out.set(k.toLowerCase(), String(v));
    }
  } catch {
    /* exotic headers object */
  }
}

/** Identity part for headers: every header except per-request tracing ids, sorted. */
export function headersKey(input: unknown, init: Record<string, unknown> | undefined): string {
  const m = new Map<string, string>();
  if (isRequestLike(input)) headerPairs(input.headers, m);
  if (init && "headers" in init) headerPairs(init.headers, m);
  const parts = [...m].filter(([k]) => !VOLATILE_HEADERS.has(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return parts.length ? fnv1a(parts.map(([k, v]) => `${k}:${v}`).join("\n")) : "";
}

export interface ParsedRequest {
  meta: ReqMeta;
  detail: string;
  /** Resolves with the final identity when the body must be read first. */
  pendingIdentity?: Promise<string>;
}

export function parseRequest(
  host: Pick<NetHost, "redact" | "uniqueId" | "baseHref">,
  method: string,
  rawUrl: string,
  b: BodyInfo,
  hdrKey: string,
): ParsedRequest {
  const m = method.toUpperCase();
  const u = parseUrl(rawUrl, host.baseHref());
  const signature = requestSignature(m, u.where);
  const search = redactSearch(u.search, host.redact());
  const detail = search + (b.summary && m !== "GET" && m !== "HEAD" ? ` ${b.summary}` : "");
  const prefix = `${m} ${u.href} ${hdrKey} `;
  const meta: ReqMeta = {
    method: m,
    url: u.href,
    signature,
    identity: b.key !== undefined ? fnv1a(prefix + b.key) : "",
    idempotent: IDEMPOTENT_METHODS.has(m),
    replayable: b.replayable,
    bodyBytes: b.bytes,
    transport: "fetch",
  };
  const out: ParsedRequest = { meta, detail };
  if (b.key === undefined && b.pending) out.pendingIdentity = b.pending.then((k) => fnv1a(prefix + k));
  return out;
}

const FAILURE_STATUS = (s: number) => s >= 500 || s === 429 || s === 408;

/** JSON of a buffered response (JSON content type, or a text body that parses as JSON). */
function jsonOfBuffered(b: Buffered | null): unknown {
  if (!b || b.kind !== "body" || !b.body.byteLength) return undefined;
  const ct = b.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  if (ct && !/json|text\/plain/i.test(ct)) return undefined;
  try {
    return parseJsonBody(new TextDecoder().decode(b.body));
  } catch {
    return undefined;
  }
}
const BODY_METHODS = ["json", "text", "arrayBuffer", "blob", "formData", "bytes"] as const;

/** Make the op ambient when the app's body reads settle. */
export function instrumentResponse(host: NetHost, res: Response, op: OpRec): Response {
  for (const m of BODY_METHODS) {
    const orig = (res as unknown as Record<string, unknown>)[m];
    if (typeof orig !== "function") continue;
    try {
      Object.defineProperty(res, m, {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) =>
          (orig as (...a: unknown[]) => Promise<unknown>).apply(res, args).then(
            (v) => {
              host.ctx.stick(op);
              return v;
            },
            (e) => {
              host.ctx.stick(op);
              throw e;
            },
          ),
      });
    } catch {
      /* frozen or exotic response: no propagation */
    }
  }
  const clone = (res as unknown as { clone?: () => Response }).clone;
  if (typeof clone === "function") {
    try {
      Object.defineProperty(res, "clone", { configurable: true, writable: true, value: () => instrumentResponse(host, clone.call(res), op) });
    } catch {
      /* ignore */
    }
  }
  return res;
}

/** Resolve with `p`, or with `fallback` after `ms` of the host clock. */
function within<T>(host: NetHost, p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const h = host.clock.setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fallback);
      }
    }, ms);
    p.then(
      (v) => {
        if (done) return;
        done = true;
        host.clock.clearTimeout(h);
        resolve(v);
      },
      () => {
        if (done) return;
        done = true;
        host.clock.clearTimeout(h);
        resolve(fallback);
      },
    );
  });
}

export function installFetch(host: NetHost): (() => void) | null {
  const g = host.global;
  const native = g.fetch as FetchFn | undefined;
  if (typeof native !== "function") return null;
  const R = (g.Response ?? (globalThis as Record<string, unknown>).Response) as typeof Response | undefined;
  const nativeFetch: FetchFn = (input, init) => native.call(g, input, init);
  let disabled = false;

  function wrapped(this: unknown, input: unknown, init?: Record<string, unknown>): Promise<Response> {
    if (disabled) return nativeFetch(input, init);
    let method = "GET";
    let rawUrl = "";
    let body: unknown;
    let bodyKnown = true;
    let keepalive = false;
    try {
      if (isRequestLike(input)) {
        method = input.method;
        rawUrl = input.url;
        keepalive = !!(input as { keepalive?: boolean }).keepalive;
        if (!(init && "body" in init) && method !== "GET" && method !== "HEAD" && input.body) bodyKnown = false;
      } else rawUrl = typeof input === "string" ? input : String(input);
      if (init?.method) method = String(init.method);
      if (init && "body" in init) {
        body = init.body;
        bodyKnown = true;
      }
      if (init && "keepalive" in init) keepalive = !!init.keepalive;
    } catch {
      return nativeFetch(input, init);
    }
    let parsed: ParsedRequest;
    let template: Request | null = null;
    try {
      let b: BodyInfo;
      if (bodyKnown) b = bodyInfo(body, host);
      else {
        // a Request with a body: keep a pristine copy for replays, and read another copy for the identity
        const req = input as Request;
        try {
          template = req.clone();
        } catch {
          template = null;
        }
        const len = Number(req.headers.get("content-length") ?? "NaN");
        b = { bytes: Number.isFinite(len) ? len : 0, replayable: template !== null, summary: Number.isFinite(len) ? `${len} bytes` : "body" };
        if ((Number.isFinite(len) && len > IDENTITY_BODY_MAX) || !template) b.key = host.uniqueId();
        else {
          let copy: Request | null = null;
          try {
            copy = req.clone();
          } catch {
            copy = null;
          }
          const stream = copy?.body as ReadableStream<Uint8Array> | null | undefined;
          if (stream && typeof stream.getReader === "function") {
            const uid = host.uniqueId();
            b.pending = readKey(stream).then((k) => k ?? uid, () => uid);
          } else b.key = host.uniqueId();
        }
      }
      parsed = parseRequest(host, method, rawUrl, b, headersKey(input, init));
    } catch {
      return nativeFetch(input, init);
    }
    const req = parsed.meta;
    const op = host.startOp("fetch", req.signature, { detail: parsed.detail, method: req.method, url: req.url, ...(req.identity ? { identity: req.identity } : {}) });
    return runRequest(op, parsed, input, init, template, !keepalive);
  }

  function replayInput(input: unknown, template: Request | null): unknown {
    return template ? template.clone() : input;
  }

  function runRequest(op: OpRec, parsed: ParsedRequest, input: unknown, init: Record<string, unknown> | undefined, template: Request | null, gateRequest: boolean): Promise<Response> {
    const req = parsed.meta;
    return new Promise<Response>((resolve, reject) => {
      const signal = (init?.signal ?? (isRequestLike(input) ? input.signal : undefined)) as AbortSignal | undefined;
      let answered = false;
      let sent = false;
      let cancelStall: () => void = () => undefined;
      const onAbort = () => {
        if (!sent && !answered) {
          host.endOp(op, "aborted", { code: "aborted" });
          answer(null, signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        }
      };
      const unlisten = () => signal?.removeEventListener?.("abort", onAbort);
      const answer = (res: Response | null, err?: unknown) => {
        if (answered) return;
        answered = true;
        unlisten();
        cancelStall();
        host.ctx.stick(op);
        if (res) resolve(instrumentResponse(host, res, op));
        else reject(err);
      };
      if (signal?.aborted) {
        host.endOp(op, "aborted", { code: "aborted" });
        answer(null, signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true } as AddEventListenerOptions);

      let firstInput = input;
      const sentOps = new WeakSet<OpRec>();
      const send = (sendOp: OpRec, primary: boolean): void => {
        if (sentOps.has(sendOp)) return; // never send the same attempt twice
        sentOps.add(sendOp);
        if (primary) {
          sent = true;
          unlisten(); // from here on the native fetch handles the app's signal
        }
        let p: Promise<Response>;
        try {
          p = nativeFetch(firstInput, init);
          firstInput = replayInput(input, template);
        } catch (e) {
          p = Promise.reject(e);
        }
        let resolveBody: (b: Buffered | null) => void = () => undefined;
        const bodyP = new Promise<Buffered | null>((r) => (resolveBody = r));
        const tracked = R && req.identity ? host.cache.track(req.identity, sendOp, bodyP) : null;
        // the parsed JSON body, from the buffered clone (the app's own body is never read)
        const json = tracked ? () => bodyP.then((b) => jsonOfBuffered(b)) : undefined;
        if (primary && host.gated(op)) cancelStall = host.watchStall(op, req, () => stallController());
        p.then(
          (res) => {
            const failed = FAILURE_STATUS(res.status);
            // buffer a clone for coalescing / the GET cache before anyone reads the body
            if (tracked) {
              tracked.settledAt = host.clock.now();
              bufferResponse(res, host.clock).then((b) => {
                if (b && b.kind === "body" && !failed && res.ok && req.method === "GET") host.cache.put(req.identity, b);
                resolveBody(failed ? null : b);
              });
            }
            host.endOp(sendOp, failed ? "error" : "ok", { code: res.status, ...(failed ? { errorText: `HTTP ${res.status}`, failure: true } : {}) });
            if (!primary) return; // hedges answer through their own path
            if (failed && host.gated(op) && !answered) {
              failureGate(sendOp, res, null, { kind: "http", status: res.status, statusText: res.statusText, durMs: (sendOp.end ?? host.clock.now()) - sendOp.start });
            } else if (!failed && host.gated(sendOp) && !answered) {
              if (json && req.method !== "GET" && req.method !== "HEAD" && res.ok) host.noteResponse?.({ op: sendOp, req, status: res.status, body: json });
              // the delivery gate: delaying a response is only extra latency (any correct app tolerates it)
              host.deliver({ op: sendOp, req, status: res.status, ...(json ? { body: json } : {}) }, () => answer(res));
            } else answer(res);
          },
          (err: unknown) => {
            resolveBody(null);
            if (tracked) tracked.settledAt = host.clock.now();
            const name = (err as { name?: string })?.name;
            const reason = signal?.reason as { name?: string } | undefined;
            const timeout = name === "TimeoutError" || (signal?.aborted && reason?.name === "TimeoutError");
            if (!timeout && (name === "AbortError" || signal?.aborted)) {
              host.endOp(sendOp, "aborted", { code: "aborted" });
              if (primary) answer(null, err);
              return;
            }
            const msg = (err as { message?: string })?.message ?? String(err);
            host.endOp(sendOp, "error", { code: timeout ? "timeout" : "network", errorText: msg, failure: true });
            if (!primary) return;
            if (host.gated(op) && !answered) failureGate(sendOp, null, err, { kind: timeout ? "timeout" : "network", message: msg, durMs: (sendOp.end ?? host.clock.now()) - sendOp.start });
            else answer(null, err);
          },
        );
      };

      // ------------------------------------------------------------------ failure gate (deliver/retry/serve_cached)
      const failureGate = (failedOp: OpRec, res: Response | null, err: unknown, failure: FailureInfo) => {
        let handled = false;
        const deliver = () => {
          if (handled || answered) return;
          handled = true;
          if (res) answer(res);
          else answer(null, err);
        };
        const ctl: Controller = {
          passive: deliver,
          proceeded: () => handled || answered,
          run: (action): ActionEffect | Promise<ActionEffect> => {
            if (handled || answered) throw new Error("the failure was already delivered");
            if (action === "retry") {
              if (!req.replayable) throw new Error("the request body cannot be replayed");
              handled = true;
              const backoff = Math.min(200 * 2 ** (failedOp.attempt - 1), 5000);
              return new Promise<ActionEffect>((resolveEff, rejectEff) => {
                host.clock.setTimeout(() => {
                  if (answered) return resolveEff({ changed: `Did not retry ${opLabel(failedOp)}: the request was already answered.` });
                  if (signal?.aborted) {
                    answer(null, signal.reason);
                    return rejectEff(new Error("aborted"));
                  }
                  const retryOp = host.startOp("fetch", req.signature, {
                    detail: failedOp.detail ?? "",
                    ...(req.identity ? { identity: req.identity } : {}),
                    method: req.method,
                    url: req.url,
                    attempt: failedOp.attempt + 1,
                    cause: failedOp,
                  });
                  // the retry goes through the failure gate again (the model may retry once more or deliver)
                  op = retryOp as OpRec;
                  send(retryOp, true);
                  resolveEff({ changed: `Retried ${opLabel(failedOp)} after ${secs(backoff)} as attempt ${retryOp.attempt} (#${retryOp.id}); the app will receive that attempt's result.` });
                }, backoff);
              });
            }
            if (action === "serve_cached") {
              const b = host.cache.get(req.identity);
              if (!b || !R) throw new Error("no cached response");
              const out = makeResponse(R, b, "cached");
              handled = true;
              answer(out);
              return { changed: `Replaced the failed response of ${opLabel(failedOp)} with the cached ${b.status} response from ${secs(host.clock.now() - b.t)} ago (x-genclass: cached).` };
            }
            throw new Error(`unsupported action ${action}`);
          },
        };
        host.trigger({ trigger: "failure", op: failedOp, req, failure }, ctl, { hold: true, priority: 2 });
      };

      // ------------------------------------------------------------------ stall (wait/hedge/serve_cached)
      const stallController = (): Controller => ({
        passive: () => undefined,
        run: (action): ActionEffect | Promise<ActionEffect> => {
          if (answered) throw new Error("already answered");
          if (action === "serve_cached") {
            const b = host.cache.get(req.identity);
            if (!b || !R) throw new Error("no cached response");
            answer(makeResponse(R, b, "cached"));
            return { changed: `Answered ${opLabel(op)} with the cached ${b.status} response from ${secs(host.clock.now() - b.t)} ago instead of waiting (x-genclass: cached); the original request continues in the background.` };
          }
          if (action === "hedge") {
            if (!req.replayable || !req.idempotent) throw new Error("not hedgeable");
            const hedgeOp = host.startOp("fetch", req.signature, { detail: `${op.detail ?? ""} (hedge)`.trim(), ...(req.identity ? { identity: req.identity } : {}), method: req.method, url: req.url, attempt: op.attempt, cause: op });
            let hp: Promise<Response>;
            try {
              hp = nativeFetch(replayInput(input, template), init);
            } catch (e) {
              hp = Promise.reject(e);
            }
            return hp.then(
              (res) => {
                const failed = FAILURE_STATUS(res.status);
                host.endOp(hedgeOp, failed ? "error" : "ok", { code: res.status, ...(failed ? { errorText: `HTTP ${res.status}`, failure: true } : {}) });
                if (!failed && !answered) {
                  answer(res);
                  return { changed: `Sent a second identical request #${hedgeOp.id} for ${opLabel(op)}; it answered first (${res.status}) and the app received it.` };
                }
                return { changed: `Sent a second identical request #${hedgeOp.id} for ${opLabel(op)}; the original answered first.` };
              },
              (e: unknown) => {
                host.endOp(hedgeOp, "error", { code: "network", errorText: String((e as Error)?.message ?? e), failure: true });
                return { changed: `Sent a second identical request #${hedgeOp.id} for ${opLabel(op)}; it failed, so the app keeps waiting for the original.` };
              },
            );
          }
          throw new Error(`unsupported action ${action}`);
        },
      });

      // ------------------------------------------------------------------ request gate
      const sendNow = () => {
        if (!answered && !sent && !signal?.aborted) send(op, true);
      };
      const reqCtl: Controller = {
        // the request goes out unless it already went out or was answered (also after a failed action)
        passive: sendNow,
        proceeded: () => sent || answered,
        // superseded: the app aborted it before it was sent
        stale: () => !sent && !!signal?.aborted,
        run: (action): ActionEffect | Promise<ActionEffect> => {
          if (answered || sent) throw new Error("the request was already sent");
          if (action === "block") {
            if (!R) throw new Error("no Response constructor");
            const out = blockedResponse(R);
            host.endOp(op, "blocked", { code: 503, synthetic: true });
            answer(out);
            return { changed: `Did not send ${opLabel(op)}; answered 503 (x-genclass: blocked).` };
          }
          if (action === "serve_cached") {
            const b = host.cache.get(req.identity);
            if (!b || !R) throw new Error("no cached response");
            const out = makeResponse(R, b, "cached");
            host.endOp(op, "ok", { code: b.status, synthetic: true });
            answer(out);
            return { changed: `Did not send ${opLabel(op)}; answered with the cached ${b.status} response from ${secs(host.clock.now() - b.t)} ago (x-genclass: cached).` };
          }
          if (action === "delay") {
            const streak = host.failureStreak(req.signature);
            const ms = Math.min(250 * 2 ** streak, 8000);
            return new Promise<ActionEffect>((resolveEff) => {
              host.clock.setTimeout(() => {
                sendNow();
                resolveEff({ changed: `Delayed ${opLabel(op)} by ${secs(ms)} before sending it.` });
              }, ms);
            });
          }
          if (action === "coalesce") {
            const shared = req.identity ? host.cache.shareable(req.identity, op.id, host.clock.now()) : undefined;
            if (!shared || !R) throw new Error("no identical request to share");
            const other = shared.op;
            return within(host, shared.body, COALESCE_MAX_WAIT_MS, null).then((b) => {
              if (answered) return { changed: `Coalesced ${opLabel(op)} with #${other.id}, but the app was already answered.` };
              let out: Response | null = null;
              if (b) {
                try {
                  out = makeResponse(R, b, "coalesced");
                } catch {
                  out = null;
                }
              }
              if (!out || !b) {
                sendNow();
                throw new Error(`the response of #${other.id} could not be shared; sent the request instead`);
              }
              host.endOp(op, "ok", { code: b.status, synthetic: true });
              answer(out);
              return { changed: `Did not send ${opLabel(op)}; reused the ${b.status} response of the identical request #${other.id}${b.kind === "body" ? " (x-genclass: coalesced)" : ""}.` };
            });
          }
          throw new Error(`unsupported action ${action}`);
        },
      };
      const gate = () => {
        if (answered) return;
        if (!gateRequest || !host.gated(op)) {
          sendNow();
          return;
        }
        host.trigger({ trigger: "request", op, req }, reqCtl, { hold: true, priority: 2 });
      };
      if (parsed.pendingIdentity && gateRequest) {
        // the identity needs the body: read it first (bounded), then decide
        within(host, parsed.pendingIdentity, IDENTITY_READ_MS, "").then((id) => {
          host.setIdentity(op, req, id || host.uniqueId());
          gate();
        });
      } else {
        if (parsed.pendingIdentity) {
          host.setIdentity(op, req, host.uniqueId());
          parsed.pendingIdentity.then((id) => host.setIdentity(op, req, id), () => undefined);
        }
        gate();
      }
    });
  }

  const wrappedFetch = wrapped as unknown as FetchFn & { __genclass?: boolean };
  wrappedFetch.__genclass = true;
  g.fetch = wrappedFetch;
  return () => {
    disabled = true; // pass-through if another library wrapped fetch after us
    if (g.fetch === wrappedFetch) g.fetch = native;
  };
}
