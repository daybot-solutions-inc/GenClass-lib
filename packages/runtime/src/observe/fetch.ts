// fetch observer (CONTRACT §3, §6, §7). Wraps global.fetch:
//   - creates the request op synchronously inside the call (cause = ambient op);
//   - request gate: triage, and when salient the request waits for the model (send/coalesce/delay/block/
//     serve_cached), fail-open after the hold budget;
//   - failure gate: network errors, timeouts, 5xx/429/408 wait for the model before the app sees them
//     (deliver/retry/serve_cached);
//   - stall watch: far past the learned latency, the model may hedge or serve a cached response;
//   - the app always gets its own Response; GenClass buffers a clone for coalescing and the GET cache;
//   - context: the op is ambient when the fetch promise and the Response body methods settle.

import type { NetHost, Controller, ActionEffect } from "../decide/exec.js";
import type { ReqMeta, FailureInfo } from "../situation/env.js";
import type { OpRec } from "../trace/ops.js";
import { opLabel } from "../situation/describe.js";
import {
  describe,
  fnv1a,
  IDEMPOTENT_METHODS,
  parseUrl,
  redactSearch,
  requestSignature,
  secs,
  stableStringify,
  truncate,
} from "../util.js";
import { blockedResponse, bufferResponse, makeResponse, type Buffered } from "./cache.js";

type FetchFn = (input: unknown, init?: Record<string, unknown>) => Promise<Response>;

interface BodyInfo {
  key: string;
  bytes: number;
  replayable: boolean;
  summary: string;
}

function isRequestLike(x: unknown): x is Request {
  return typeof x === "object" && x !== null && typeof (x as Request).url === "string" && typeof (x as Request).method === "string" && typeof (x as Request).clone === "function";
}

function bytesKey(u8: Uint8Array): string {
  let s = "";
  const n = Math.min(u8.length, 65536);
  for (let i = 0; i < n; i++) s += String.fromCharCode(u8[i]);
  return fnv1a(s) + ":" + u8.length;
}

export function bodyInfo(body: unknown, redact: NetHost["redact"]): BodyInfo {
  if (body === undefined || body === null) return { key: "", bytes: 0, replayable: true, summary: "" };
  if (typeof body === "string") {
    let summary = `${body.length} bytes`;
    const t = body.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        summary = describe(JSON.parse(t), "body", redact(), 60);
      } catch {
        /* not JSON */
      }
    }
    return { key: body.length > 65536 ? fnv1a(body) + ":" + body.length : body, bytes: body.length, replayable: true, summary };
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    const s = body.toString();
    return { key: s, bytes: s.length, replayable: true, summary: redactSearch("?" + s, redact(), 60) };
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const parts: string[] = [];
    let bytes = 0;
    body.forEach((v, k) => {
      if (typeof v === "string") {
        parts.push(`${k}=${v}`);
        bytes += v.length;
      } else {
        parts.push(`${k}=file:${(v as Blob).size}`);
        bytes += (v as Blob).size;
      }
    });
    return { key: "form:" + parts.join("&"), bytes, replayable: true, summary: `form ${parts.length} fields` };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return { key: `blob:${body.size}:${body.type}`, bytes: body.size, replayable: true, summary: `${body.size} bytes` };
  if (body instanceof ArrayBuffer) return { key: bytesKey(new Uint8Array(body)), bytes: body.byteLength, replayable: true, summary: `${body.byteLength} bytes` };
  if (ArrayBuffer.isView(body)) {
    const u8 = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { key: bytesKey(u8), bytes: body.byteLength, replayable: true, summary: `${body.byteLength} bytes` };
  }
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return { key: "stream", bytes: 0, replayable: false, summary: "stream" };
  const s = stableStringify(body, 4096);
  return { key: s, bytes: s.length, replayable: true, summary: truncate(s, 40) };
}

export interface ParsedRequest {
  meta: ReqMeta;
  detail: string;
}

export function parseRequest(host: NetHost, method: string, rawUrl: string, body: unknown, bodyKnown: boolean): ParsedRequest {
  const m = method.toUpperCase();
  const u = parseUrl(rawUrl, host.baseHref());
  const b = bodyKnown ? bodyInfo(body, host.redact) : { key: "request-body", bytes: 0, replayable: true, summary: "body" };
  const signature = requestSignature(m, u.where);
  const search = redactSearch(u.search, host.redact());
  const detail = search + (b.summary && m !== "GET" && m !== "HEAD" ? ` ${b.summary}` : "");
  return {
    meta: {
      method: m,
      url: u.href,
      signature,
      identity: fnv1a(`${m} ${u.href} ${b.key}`),
      idempotent: IDEMPOTENT_METHODS.has(m),
      replayable: b.replayable,
      bodyBytes: b.bytes,
      transport: "fetch",
    },
    detail,
  };
}

const FAILURE_STATUS = (s: number) => s >= 500 || s === 429 || s === 408;
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

export function installFetch(host: NetHost): (() => void) | null {
  const g = host.global;
  const native = g.fetch as FetchFn | undefined;
  if (typeof native !== "function") return null;
  const R = (g.Response ?? (globalThis as Record<string, unknown>).Response) as typeof Response | undefined;
  const nativeFetch: FetchFn = (input, init) => native.call(g, input, init);

  function wrapped(this: unknown, input: unknown, init?: Record<string, unknown>): Promise<Response> {
    let method = "GET";
    let rawUrl = "";
    let body: unknown;
    let bodyKnown = true;
    try {
      if (isRequestLike(input)) {
        method = input.method;
        rawUrl = input.url;
        if (init && "body" in init) body = init.body;
        else if (method !== "GET" && method !== "HEAD" && input.body) bodyKnown = false;
      } else rawUrl = typeof input === "string" ? input : String(input);
      if (init?.method) method = String(init.method);
      if (init && "body" in init) {
        body = init.body;
        bodyKnown = true;
      }
    } catch {
      return nativeFetch(input, init);
    }
    const parsed = parseRequest(host, method, rawUrl, body, bodyKnown);
    const req = parsed.meta;
    // Keep a pristine copy of Request inputs so retries/hedges can replay them.
    let template: Request | null = null;
    if (isRequestLike(input) && !bodyKnown) {
      try {
        template = input.clone();
      } catch {
        req.replayable = false;
      }
    }
    const op = host.startOp("fetch", req.signature, { detail: parsed.detail, identity: req.identity, method: req.method, url: req.url });
    return runRequest(op, req, input, init, template, true);
  }

  function replayInput(input: unknown, template: Request | null): unknown {
    return template ? template.clone() : input;
  }

  function runRequest(op: OpRec, req: ReqMeta, input: unknown, init: Record<string, unknown> | undefined, template: Request | null, gateRequest: boolean): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const signal = (init?.signal ?? (isRequestLike(input) ? input.signal : undefined)) as AbortSignal | undefined;
      let answered = false;
      let sent = false;
      let cancelStall: () => void = () => undefined;
      const answer = (res: Response | null, err?: unknown) => {
        if (answered) return;
        answered = true;
        cancelStall();
        host.ctx.stick(op);
        if (res) resolve(instrumentResponse(host, res, op));
        else reject(err);
      };
      const onAbort = () => {
        if (!sent && !answered) {
          host.endOp(op, "aborted", { code: "aborted" });
          answer(null, signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        }
      };
      if (signal?.aborted) {
        host.endOp(op, "aborted", { code: "aborted" });
        answer(null, signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true } as AddEventListenerOptions);

      let firstInput = input;
      const send = (sendOp: OpRec, primary: boolean): void => {
        if (primary) sent = true;
        let p: Promise<Response>;
        try {
          p = nativeFetch(firstInput, init);
          firstInput = replayInput(input, template);
        } catch (e) {
          p = Promise.reject(e);
        }
        let body: Promise<Buffered | null> | null = null;
        let resolveBody: (b: Buffered | null) => void = () => undefined;
        let tracked: ReturnType<NetHost["cache"]["track"]> | null = null;
        if (R) {
          body = new Promise((r) => (resolveBody = r));
          tracked = host.cache.track(req.identity, sendOp, body);
        }
        if (primary && host.gated(op)) cancelStall = host.watchStall(op, req, () => stallController());
        p.then(
          (res) => {
            const failed = FAILURE_STATUS(res.status);
            // buffer a clone for coalescing / the GET cache before anyone reads the body
            if (R && body) {
              bufferResponse(res, () => host.clock.now()).then((b) => {
                if (b && !failed && res.ok && req.method === "GET") host.cache.put(req.identity, b);
                resolveBody(failed ? null : b);
              });
              if (tracked) tracked.settledAt = host.clock.now();
            }
            host.endOp(sendOp, failed ? "error" : "ok", { code: res.status, ...(failed ? { errorText: `HTTP ${res.status}`, failure: true } : {}) });
            if (!primary) return; // hedges answer through their own path
            if (failed && host.gated(op) && !answered) {
              failureGate(sendOp, res, null, { kind: "http", status: res.status, statusText: res.statusText, durMs: (sendOp.end ?? host.clock.now()) - sendOp.start });
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
        let done = false;
        const deliver = () => {
          if (done) return;
          done = true;
          if (res) answer(res);
          else answer(null, err);
        };
        const ctl: Controller = {
          passive: deliver,
          run: (action): ActionEffect | Promise<ActionEffect> => {
            if (action === "retry") {
              if (!req.replayable) throw new Error("the request body cannot be replayed");
              done = true;
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
                    identity: req.identity,
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
              done = true;
              answer(makeResponse(R, b, "cached"));
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
            const hedgeOp = host.startOp("fetch", req.signature, { detail: `${op.detail ?? ""} (hedge)`.trim(), identity: req.identity, method: req.method, url: req.url, attempt: op.attempt, cause: op });
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
      if (!gateRequest || !host.gated(op)) {
        send(op, true);
        return;
      }
      let decided = false;
      const reqCtl: Controller = {
        passive: () => {
          if (decided) return;
          decided = true;
          if (!answered) send(op, true);
        },
        run: (action): ActionEffect | Promise<ActionEffect> => {
          if (decided) throw new Error("already decided");
          if (action === "block") {
            if (!R) throw new Error("no Response constructor");
            decided = true;
            host.endOp(op, "blocked", { code: 503, synthetic: true });
            answer(blockedResponse(R));
            return { changed: `Did not send ${opLabel(op)}; answered 503 (x-genclass: blocked).` };
          }
          if (action === "serve_cached") {
            const b = host.cache.get(req.identity);
            if (!b || !R) throw new Error("no cached response");
            decided = true;
            host.endOp(op, "ok", { code: b.status, synthetic: true });
            answer(makeResponse(R, b, "cached"));
            return { changed: `Did not send ${opLabel(op)}; answered with the cached ${b.status} response from ${secs(host.clock.now() - b.t)} ago (x-genclass: cached).` };
          }
          if (action === "delay") {
            decided = true;
            const streak = host.failureStreak(req.signature);
            const ms = Math.min(250 * 2 ** streak, 8000);
            return new Promise<ActionEffect>((resolveEff) => {
              host.clock.setTimeout(() => {
                if (!answered && !signal?.aborted) send(op, true);
                resolveEff({ changed: `Delayed ${opLabel(op)} by ${secs(ms)} before sending it.` });
              }, ms);
            });
          }
          if (action === "coalesce") {
            const shared = host.cache.shareable(req.identity, op.id, host.clock.now());
            if (!shared || !R) throw new Error("no identical request to share");
            decided = true;
            const other = shared.op;
            return shared.body.then((b) => {
              if (answered) return { changed: `Coalesced ${opLabel(op)} with #${other.id}, but the app was already answered.` };
              if (!b) {
                // the shared response could not be buffered (or failed): fail open and send
                send(op, true);
                throw new Error(`the response of #${other.id} could not be shared; sent the request instead`);
              }
              host.endOp(op, "ok", { code: b.status, synthetic: true });
              answer(makeResponse(R, b, "coalesced"));
              return { changed: `Did not send ${opLabel(op)}; reused the ${b.status} response of the identical request #${other.id} (x-genclass: coalesced).` };
            });
          }
          throw new Error(`unsupported action ${action}`);
        },
      };
      host.trigger({ trigger: "request", op, req }, reqCtl, { hold: true, priority: 2 });
    });
  }

  const wrappedFetch = wrapped as unknown as FetchFn & { __genclass?: boolean };
  wrappedFetch.__genclass = true;
  g.fetch = wrappedFetch;
  return () => {
    if (g.fetch === wrappedFetch) g.fetch = native;
  };
}
