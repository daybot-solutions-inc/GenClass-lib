// XMLHttpRequest observer (basics): ops with causes and identities, request gate (send/delay/block/serve_cached;
// a blocked or cached answer is replayed onto the XHR as a completed response, honouring responseType), the
// delivery gate for successful responses, failures and stalls observed for detection (the app sees XHR failures
// directly, so only the passive action applies), context set when the request completes. Synchronous XHRs are never
// held. An abort() while GenClass holds the request means it is never sent. Listeners are added once per XHR
// object; values faked onto an XHR are removed when it is opened again.
//
// Delivery gate: the app's completion listeners (readystatechange, progress, load, loadend; added with
// addEventListener or set as on* handlers, before or after open()) run through a thin wrapper. When a response
// completes, the first completion event asks the delivery gate (synchronously); while it holds, the app's completion
// listeners are queued in order and run, with the request op ambient, once the response is delivered. Holding is only
// latency. An abort() during the hold drops the queued events and tells the app it was aborted. on* getters return
// the wrapper (the app's own function is called through it).

import type { ActionEffect, Controller, NetHost } from "../decide/exec.js";
import type { ReqMeta } from "../situation/env.js";
import type { OpRec } from "../trace/ops.js";
import { opLabel } from "../situation/describe.js";
import { fnv1a, secs } from "../util.js";
import { bodyInfo, parseRequest } from "./fetch.js";
import { parseJsonBody } from "../situation/content.js";
import type { Buffered } from "./cache.js";

const VOLATILE = /^(traceparent|tracestate|baggage|sentry-trace|x-request-id|x-correlation-id|request-id|x-amzn-trace-id|x-cloud-trace-context|b3|x-b3-.*|x-datadog-.*|newrelic|date|x-request-start|x-genclass)$/i;

interface XhrState {
  method: string;
  url: string;
  async: boolean;
  headers: Map<string, string>;
  op?: OpRec;
  failed?: "error" | "timeout" | "abort";
  /** Waiting for a decision (native send not called yet). */
  held: boolean;
  abortedWhileHeld: boolean;
  /** Own properties defined by fake(), removed on the next open(). */
  faked: string[];
  onEnd?: () => void;
  req?: ReqMeta;
  /** Delivery gate for the current request: not reached yet, holding the app's completion events, or open. */
  dlv: "none" | "held" | "open";
  /** The app's completion listener calls queued while the delivery is held. */
  queue: (() => void)[];
}

/** Events an app sees when a response completes: held together while the delivery gate decides. */
const COMPLETION = new Set(["readystatechange", "progress", "load", "loadend"]);
const HANDLERS = ["onreadystatechange", "onprogress", "onload", "onloadend"];
const FAILURE_STATUS = (s: number) => s >= 500 || s === 429 || s === 408;

function invoke(listener: unknown, target: unknown, ev: Event): unknown {
  if (typeof listener === "function") return (listener as (this: unknown, e: Event) => unknown).call(target, ev);
  const h = (listener as { handleEvent?: (e: Event) => unknown } | null)?.handleEvent;
  return typeof h === "function" ? h.call(listener, ev) : undefined;
}

/** The JSON of a completed XHR's response (text or json response types), never throwing. */
function xhrJson(xhr: XMLHttpRequest): unknown {
  try {
    const t = xhr.responseType;
    if (t === "json") return xhr.response as unknown;
    if (t === "" || t === "text") return parseJsonBody(xhr.responseText);
  } catch {
    /* not readable */
  }
  return undefined;
}

const captureOf = (o: unknown): boolean => (typeof o === "boolean" ? o : !!(o as { capture?: boolean } | null)?.capture);

const states = new WeakMap<object, XhrState>();

function fake(xhr: XMLHttpRequest, st: XhrState, status: number, statusText: string, text: string, headers: [string, string][]): void {
  const define = (k: string, v: unknown) => {
    try {
      Object.defineProperty(xhr, k, { configurable: true, get: () => v });
      st.faked.push(k);
    } catch {
      /* ignore */
    }
  };
  const type = xhr.responseType || "";
  let response: unknown = text;
  if (type === "json") {
    try {
      response = text ? JSON.parse(text) : null;
    } catch {
      response = null;
    }
  } else if (type === "arraybuffer") response = new TextEncoder().encode(text).buffer;
  else if (type === "blob") response = typeof Blob !== "undefined" ? new Blob([text]) : text;
  else if (type === "document") response = null;
  define("readyState", 4);
  define("status", status);
  define("statusText", statusText);
  define("response", response);
  if (type === "" || type === "text") define("responseText", text);
  const map = new Map(headers.map(([k, v]) => [k.toLowerCase(), v]));
  try {
    Object.defineProperty(xhr, "getResponseHeader", { configurable: true, value: (k: string) => map.get(String(k).toLowerCase()) ?? null });
    Object.defineProperty(xhr, "getAllResponseHeaders", { configurable: true, value: () => [...map].map(([k, v]) => `${k}: ${v}`).join("\r\n") });
    st.faked.push("getResponseHeader", "getAllResponseHeaders");
  } catch {
    /* ignore */
  }
  const fire = (t: string) => {
    try {
      xhr.dispatchEvent(new Event(t));
    } catch {
      /* ignore */
    }
  };
  fire("readystatechange");
  fire("load");
  fire("loadend");
}

function unfake(xhr: XMLHttpRequest, st: XhrState): void {
  for (const k of st.faked) {
    try {
      delete (xhr as unknown as Record<string, unknown>)[k];
    } catch {
      /* ignore */
    }
  }
  st.faked = [];
}

function decode(b: Buffered): string {
  if (b.kind !== "body") return "";
  try {
    return new TextDecoder().decode(b.body);
  } catch {
    return "";
  }
}

export function installXHR(host: NetHost): (() => void) | null {
  const X = host.global.XMLHttpRequest as { prototype: XMLHttpRequest } | undefined;
  if (!X || !X.prototype) return null;
  const P = X.prototype;
  const open = P.open;
  const send = P.send;
  const abort = P.abort;
  const setHeader = P.setRequestHeader;
  const nativeAdd = P.addEventListener as (this: EventTarget, t: string, l: unknown, o?: unknown) => void;
  const nativeRemove = P.removeEventListener as (this: EventTarget, t: string, l: unknown, o?: unknown) => void;
  const ownAdd = Object.getOwnPropertyDescriptor(P, "addEventListener");
  const ownRemove = Object.getOwnPropertyDescriptor(P, "removeEventListener");
  /** Per XHR object: app listener → wrapper, by "type|capture". */
  const wrappers = new WeakMap<object, Map<unknown, Map<string, (e: Event) => unknown>>>();
  let wrappedAny = false;
  let disabled = false;

  const report = (e: unknown) => {
    const r = host.global.reportError as ((e: unknown) => void) | undefined;
    if (typeof r === "function") r.call(host.global, e);
    else ((host.global.console as Console | undefined) ?? globalThis.console)?.error?.(e);
  };

  /** The response completed: ask the delivery gate once (synchronously); successful responses only. */
  const arrive = (xhr: XMLHttpRequest, st: XhrState): void => {
    if (st.dlv !== "none") return;
    st.dlv = "open";
    const op = st.op;
    if (!op || !st.req || op.end !== undefined || st.failed) return;
    const status = xhr.status;
    if (!status || FAILURE_STATUS(status)) return; // failures: detection only, at loadend
    host.endOp(op, "ok", { code: status });
    host.ctx.stick(op);
    if (!host.gated(op)) return;
    // the response is in memory: `body.now` reads it synchronously (when the delivery cannot be held, the gate
    // releases it at once and analyzes it before the app's listeners run, for detection only)
    const json = () => xhrJson(xhr);
    const body = Object.assign(() => Promise.resolve(json()), { now: json });
    if (st.req.method !== "GET" && st.req.method !== "HEAD" && status < 300) host.noteResponse?.({ op, req: st.req, status, body });
    st.dlv = "held";
    let sync = true;
    host.deliver({ op, req: st.req, status, body }, () => {
      if (st.dlv !== "held") return; // aborted meanwhile
      st.dlv = "open";
      if (sync) return;
      host.ctx.stick(op);
      const q = st.queue;
      st.queue = [];
      for (const f of q) {
        try {
          f();
        } catch (e) {
          report(e);
        }
      }
    });
    sync = false;
  };

  /** An app completion listener is about to run: hold it while the response's delivery is undecided. */
  const gateCall = (xhr: XMLHttpRequest, ev: Event, call: () => unknown): unknown => {
    const st = states.get(xhr);
    if (!disabled && st && st.async && COMPLETION.has(ev.type) && xhr.readyState === 4) {
      arrive(xhr, st);
      if (st.dlv === "held") {
        st.queue.push(call);
        return undefined;
      }
    }
    return call();
  };

  const wrap = (xhr: XMLHttpRequest, listener: unknown): ((e: Event) => unknown) =>
    function (this: unknown, ev: Event) {
      return gateCall(xhr, ev, () => invoke(listener, xhr, ev));
    };

  const wAdd = function (this: XMLHttpRequest, type: string, listener: unknown, opts?: unknown) {
    if (disabled || !listener || !COMPLETION.has(type)) return nativeAdd.call(this, type, listener, opts);
    let byL = wrappers.get(this);
    if (!byL) wrappers.set(this, (byL = new Map()));
    let byKey = byL.get(listener);
    if (!byKey) byL.set(listener, (byKey = new Map()));
    const key = `${type}|${captureOf(opts)}`;
    let w = byKey.get(key);
    if (!w) byKey.set(key, (w = wrap(this, listener)));
    wrappedAny = true;
    return nativeAdd.call(this, type, w, opts);
  };

  const wRemove = function (this: XMLHttpRequest, type: string, listener: unknown, opts?: unknown) {
    const w = wrappers.get(this)?.get(listener)?.get(`${type}|${captureOf(opts)}`);
    return nativeRemove.call(this, type, w ?? listener, opts);
  };

  /** on* completion handlers go through the gate too (set before or after open; plain fields or the browser's). */
  const wrapHandlers = (xhr: XMLHttpRequest): void => {
    for (const prop of HANDLERS) {
      let desc: PropertyDescriptor | undefined;
      let o: object | null = xhr;
      while (o && !(desc = Object.getOwnPropertyDescriptor(o, prop))) o = Object.getPrototypeOf(o) as object | null;
      if (desc && !desc.configurable && o === xhr) continue;
      const nativeSet = desc?.set && o !== xhr ? desc.set : undefined;
      let current: unknown = null;
      try {
        current = desc ? (desc.get ? desc.get.call(xhr) : desc.value) : null;
      } catch {
        current = null;
      }
      let wrapper: ((e: Event) => unknown) | null = null;
      const set = (fn: unknown) => {
        wrapper = typeof fn === "function" ? wrap(xhr, fn) : null;
        if (nativeSet) nativeSet.call(xhr, wrapper);
      };
      try {
        Object.defineProperty(xhr, prop, { configurable: true, enumerable: true, get: () => wrapper, set });
        set(current);
      } catch {
        /* leave this handler as it is */
      }
    }
  };

  const stateOf = (xhr: XMLHttpRequest): XhrState => {
    let st = states.get(xhr);
    if (!st) {
      st = { method: "GET", url: "", async: true, headers: new Map(), held: false, abortedWhileHeld: false, faked: [], dlv: "none", queue: [] };
      states.set(xhr, st);
      const s = st;
      // added once per XHR object (reused objects do not accumulate listeners), never wrapped
      const add = (t: string, fn: () => void) => nativeAdd.call(xhr, t, fn);
      add("readystatechange", () => {
        if (xhr.readyState !== 4 || !s.op) return;
        if (s.async) arrive(xhr, s);
        host.ctx.stick(s.op);
      });
      add("error", () => (s.failed = "error"));
      add("timeout", () => (s.failed = "timeout"));
      add("abort", () => (s.failed = "abort"));
      add("loadend", () => {
        const f = s.onEnd;
        s.onEnd = undefined;
        f?.();
      });
      wrapHandlers(xhr);
    }
    return st;
  };

  const wOpen = function (this: XMLHttpRequest, ...args: unknown[]) {
    if (disabled) return (open as (...a: unknown[]) => void).apply(this, args);
    const st = stateOf(this);
    unfake(this, st);
    st.method = String(args[0] ?? "GET");
    st.url = String(args[1] ?? "");
    st.async = args.length < 3 || args[2] !== false;
    st.headers = new Map();
    st.op = undefined;
    st.failed = undefined;
    st.held = false;
    st.abortedWhileHeld = false;
    st.onEnd = undefined;
    st.req = undefined;
    st.dlv = "none";
    st.queue = [];
    return (open as (...a: unknown[]) => void).apply(this, args);
  };

  const wSetHeader = function (this: XMLHttpRequest, name: string, value: string) {
    if (!disabled) {
      const st = states.get(this);
      if (st) st.headers.set(String(name).toLowerCase(), String(value));
    }
    return setHeader.call(this, name, value);
  };

  const wAbort = function (this: XMLHttpRequest) {
    const st = disabled ? undefined : states.get(this);
    if (st && st.dlv === "held") {
      // the response arrived but the app has not seen it: drop it and tell the app it was aborted
      st.dlv = "open";
      st.queue = [];
      if (st.op) host.emit("xhr.aborted-while-held", {}, st.op);
      abort.call(this);
      const fire = (t: string) => {
        try {
          this.dispatchEvent(new Event(t));
        } catch {
          /* ignore */
        }
      };
      fire("abort");
      fire("loadend");
      return;
    }
    if (st && st.held && !st.abortedWhileHeld) {
      // the request was never sent: end it as aborted, tell the app like a real abort, never send it
      st.abortedWhileHeld = true;
      st.held = false;
      if (st.op && st.op.end === undefined) host.endOp(st.op, "aborted", { code: "aborted" });
      const fire = (t: string) => {
        try {
          this.dispatchEvent(new Event(t));
        } catch {
          /* ignore */
        }
      };
      fire("abort");
      fire("loadend");
      return;
    }
    return abort.call(this);
  };

  const wSend = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const st = disabled ? undefined : states.get(this);
    if (!st) return send.call(this, body as XMLHttpRequestBodyInit | null | undefined);
    const b = bodyInfo(body, host);
    if (b.key === undefined) b.key = host.uniqueId(); // a Blob body: not read for XHR identities
    const hdr = [...st.headers].filter(([k]) => !VOLATILE.test(k)).sort(([a], [x]) => (a < x ? -1 : a > x ? 1 : 0));
    const parsed = parseRequest(host, st.method, st.url, b, hdr.length ? fnv1a(hdr.map(([k, v]) => `${k}:${v}`).join("\n")) : "");
    parsed.meta.transport = "xhr";
    const req = parsed.meta;
    const op = host.startOp("xhr", req.signature, { detail: parsed.detail, identity: req.identity, method: req.method, url: req.url });
    st.op = op;
    st.req = req;
    st.failed = undefined;
    st.dlv = "none";
    st.queue = [];
    const xhr = this;
    let cancelStall: () => void = () => undefined;
    st.onEnd = () => {
      cancelStall();
      if (op.end !== undefined) return;
      const status = xhr.status;
      if (st.failed === "abort") return host.endOp(op, "aborted", { code: "aborted" });
      if (st.failed === "timeout" || st.failed === "error" || status === 0) {
        const timeout = st.failed === "timeout";
        host.endOp(op, "error", { code: timeout ? "timeout" : "network", errorText: timeout ? "timeout" : "network error", failure: true });
        if (host.gated(op)) host.trigger({ trigger: "failure", op, req, failure: { kind: timeout ? "timeout" : "network", durMs: (op.end ?? 0) - op.start } }, passiveOnly(), { hold: false, priority: 1 });
        return;
      }
      const failed = FAILURE_STATUS(status);
      host.endOp(op, failed ? "error" : "ok", { code: status, ...(failed ? { errorText: `HTTP ${status}`, failure: true } : {}) });
      if (failed && host.gated(op)) host.trigger({ trigger: "failure", op, req, failure: { kind: "http", status, statusText: xhr.statusText, durMs: (op.end ?? 0) - op.start } }, passiveOnly(), { hold: false, priority: 1 });
    };
    const doSend = () => {
      st.held = false;
      if (st.abortedWhileHeld) return;
      if (host.gated(op) && st.async) cancelStall = host.watchStall(op, req, passiveOnly);
      try {
        send.call(xhr, body as XMLHttpRequestBodyInit | null | undefined);
      } catch (e) {
        st.onEnd = undefined;
        host.endOp(op, "error", { code: "network", errorText: String((e as Error)?.message ?? e), failure: true });
        throw e;
      }
    };
    // synchronous XHRs complete inside send(): never held
    if (!host.gated(op) || !st.async) return doSend();
    st.held = true;
    let decided = false;
    const ctl: Controller = {
      proceeded: () => decided || st.abortedWhileHeld,
      stale: () => st.abortedWhileHeld,
      passive: () => {
        if (decided) return;
        decided = true;
        try {
          doSend();
        } catch (e) {
          host.emit("xhr.send-failed", { error: String((e as Error)?.message ?? e) }, op);
        }
      },
      run: (action): ActionEffect | Promise<ActionEffect> => {
        if (decided || st.abortedWhileHeld) throw new Error("already decided");
        if (action === "block") {
          decided = true;
          st.held = false;
          st.onEnd = undefined;
          host.endOp(op, "blocked", { code: 503, synthetic: true });
          host.ctx.stick(op);
          fake(xhr, st, 503, "Blocked by GenClass", "", [["x-genclass", "blocked"]]);
          return { changed: `Did not send ${opLabel(op)}; answered 503 (x-genclass: blocked).` };
        }
        if (action === "serve_cached") {
          const b = host.cache.get(req.identity);
          if (!b || b.kind !== "body") throw new Error("no cached response");
          decided = true;
          st.held = false;
          st.onEnd = undefined;
          host.endOp(op, "ok", { code: b.status, synthetic: true });
          host.ctx.stick(op);
          fake(xhr, st, b.status, b.statusText, decode(b), [...b.headers, ["x-genclass", "cached"]]);
          return { changed: `Did not send ${opLabel(op)}; answered with the cached ${b.status} response from ${secs(host.clock.now() - b.t)} ago (x-genclass: cached).` };
        }
        if (action === "delay") {
          decided = true;
          const ms = Math.min(250 * 2 ** host.failureStreak(req.signature), 8000);
          return new Promise<ActionEffect>((resolve) => {
            host.clock.setTimeout(() => {
              try {
                doSend();
              } catch {
                /* reported through the op */
              }
              resolve({ changed: `Delayed ${opLabel(op)} by ${secs(ms)} before sending it.` });
            }, ms);
          });
        }
        throw new Error(`unsupported action ${action}`);
      },
    };
    host.trigger({ trigger: "request", op, req }, ctl, { hold: true, priority: 2 });
  };

  function passiveOnly(): Controller {
    return {
      passive: () => undefined,
      run: (a) => {
        throw new Error(`${a} is not available for XMLHttpRequest`);
      },
    };
  }

  try {
    P.open = wOpen as XMLHttpRequest["open"];
    P.send = wSend as XMLHttpRequest["send"];
    P.abort = wAbort as XMLHttpRequest["abort"];
    P.setRequestHeader = wSetHeader as XMLHttpRequest["setRequestHeader"];
    P.addEventListener = wAdd as XMLHttpRequest["addEventListener"];
    P.removeEventListener = wRemove as XMLHttpRequest["removeEventListener"];
  } catch {
    return null;
  }
  return () => {
    disabled = true;
    if (P.open === (wOpen as unknown)) P.open = open;
    if (P.send === (wSend as unknown)) P.send = send;
    if (P.abort === (wAbort as unknown)) P.abort = abort;
    if (P.setRequestHeader === (wSetHeader as unknown)) P.setRequestHeader = setHeader;
    // listeners added while installed keep their (pass-through) wrappers: once any exists, add/remove stay
    // installed as pass-throughs so removeEventListener still finds them
    const restore = (name: "addEventListener" | "removeEventListener", own: PropertyDescriptor | undefined, w: unknown) => {
      if ((P as unknown as Record<string, unknown>)[name] !== w) return;
      if (own) Object.defineProperty(P, name, own);
      else delete (P as unknown as Record<string, unknown>)[name];
    };
    if (!wrappedAny) {
      restore("addEventListener", ownAdd, wAdd);
      restore("removeEventListener", ownRemove, wRemove);
    }
  };
}
