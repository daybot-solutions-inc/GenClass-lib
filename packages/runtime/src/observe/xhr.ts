// XMLHttpRequest observer (basics): ops with causes, request gate (send/delay/block/serve_cached; a blocked or
// cached answer is replayed onto the XHR as a completed 503/cached response), failures and stalls observed for
// detection (the app sees XHR failures directly, so only the passive action applies), context set when the
// request completes (readystatechange 4, registered in open() so it runs before handlers set after open).

import type { ActionEffect, Controller, NetHost } from "../decide/exec.js";
import type { OpRec } from "../trace/ops.js";
import { opLabel } from "../situation/describe.js";
import { secs } from "../util.js";
import { parseRequest } from "./fetch.js";
import type { Buffered } from "./cache.js";

interface XhrState {
  method: string;
  url: string;
  op?: OpRec;
  listening?: boolean;
  failed?: "error" | "timeout" | "abort";
}

const KEY = Symbol.for("genclass.xhr");

function fake(xhr: XMLHttpRequest, status: number, statusText: string, text: string, headers: [string, string][]): void {
  const define = (k: string, v: unknown) => {
    try {
      Object.defineProperty(xhr, k, { configurable: true, get: () => v });
    } catch {
      /* ignore */
    }
  };
  define("readyState", 4);
  define("status", status);
  define("statusText", statusText);
  define("responseText", text);
  let response: unknown = text;
  if (xhr.responseType === "json") {
    try {
      response = JSON.parse(text);
    } catch {
      response = null;
    }
  }
  define("response", response);
  const map = new Map(headers.map(([k, v]) => [k.toLowerCase(), v]));
  try {
    Object.defineProperty(xhr, "getResponseHeader", { configurable: true, value: (k: string) => map.get(String(k).toLowerCase()) ?? null });
    Object.defineProperty(xhr, "getAllResponseHeaders", { configurable: true, value: () => [...map].map(([k, v]) => `${k}: ${v}`).join("\r\n") });
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

function decode(b: Buffered): string {
  try {
    return new TextDecoder().decode(b.body);
  } catch {
    return "";
  }
}

export function installXHR(host: NetHost): (() => void) | null {
  const X = host.global.XMLHttpRequest as { prototype: XMLHttpRequest } | undefined;
  if (!X || !X.prototype) return null;
  const P = X.prototype as XMLHttpRequest & Record<symbol, XhrState | undefined>;
  const open = P.open;
  const send = P.send;

  const wOpen = function (this: XMLHttpRequest & Record<symbol, XhrState | undefined>, ...args: unknown[]) {
    const st: XhrState = { method: String(args[0] ?? "GET"), url: String(args[1] ?? "") };
    this[KEY] = st;
    if (!st.listening) {
      st.listening = true;
      this.addEventListener("readystatechange", () => {
        if (this.readyState === 4 && st.op) host.ctx.stick(st.op);
      });
      this.addEventListener("error", () => (st.failed = "error"));
      this.addEventListener("timeout", () => (st.failed = "timeout"));
      this.addEventListener("abort", () => (st.failed = "abort"));
    }
    return (open as (...a: unknown[]) => void).apply(this, args);
  };

  const wSend = function (this: XMLHttpRequest & Record<symbol, XhrState | undefined>, body?: Document | XMLHttpRequestBodyInit | null) {
    const st = this[KEY];
    if (!st) return send.call(this, body as XMLHttpRequestBodyInit | null | undefined);
    const parsed = parseRequest(host, st.method, st.url, body, true);
    parsed.meta.transport = "xhr";
    const req = parsed.meta;
    const op = host.startOp("xhr", req.signature, { detail: parsed.detail, identity: req.identity, method: req.method, url: req.url });
    st.op = op;
    st.failed = undefined;
    const xhr = this;
    let cancelStall: () => void = () => undefined;
    const onEnd = () => {
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
      const failed = status >= 500 || status === 429 || status === 408;
      host.endOp(op, failed ? "error" : "ok", { code: status, ...(failed ? { errorText: `HTTP ${status}`, failure: true } : {}) });
      if (failed && host.gated(op)) host.trigger({ trigger: "failure", op, req, failure: { kind: "http", status, statusText: xhr.statusText, durMs: (op.end ?? 0) - op.start } }, passiveOnly(), { hold: false, priority: 1 });
    };
    xhr.addEventListener("loadend", onEnd, { once: true } as AddEventListenerOptions);
    const doSend = () => {
      if (host.gated(op)) cancelStall = host.watchStall(op, req, passiveOnly);
      try {
        send.call(xhr, body as XMLHttpRequestBodyInit | null | undefined);
      } catch (e) {
        host.endOp(op, "error", { code: "network", errorText: String((e as Error)?.message ?? e), failure: true });
        throw e;
      }
    };
    if (!host.gated(op)) return doSend();
    let decided = false;
    const ctl: Controller = {
      passive: () => {
        if (decided) return;
        decided = true;
        doSend();
      },
      run: (action): ActionEffect | Promise<ActionEffect> => {
        if (decided) throw new Error("already decided");
        if (action === "block") {
          decided = true;
          host.endOp(op, "blocked", { code: 503, synthetic: true });
          host.ctx.stick(op);
          fake(xhr, 503, "Blocked by GenClass", "", [["x-genclass", "blocked"]]);
          return { changed: `Did not send ${opLabel(op)}; answered 503 (x-genclass: blocked).` };
        }
        if (action === "serve_cached") {
          const b = host.cache.get(req.identity);
          if (!b) throw new Error("no cached response");
          decided = true;
          host.endOp(op, "ok", { code: b.status, synthetic: true });
          host.ctx.stick(op);
          fake(xhr, b.status, b.statusText, decode(b), [...b.headers, ["x-genclass", "cached"]]);
          return { changed: `Did not send ${opLabel(op)}; answered with the cached ${b.status} response from ${secs(host.clock.now() - b.t)} ago (x-genclass: cached).` };
        }
        if (action === "delay") {
          decided = true;
          const ms = Math.min(250 * 2 ** host.failureStreak(req.signature), 8000);
          return new Promise<ActionEffect>((resolve) => {
            host.clock.setTimeout(() => {
              doSend();
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

  P.open = wOpen as XMLHttpRequest["open"];
  P.send = wSend as XMLHttpRequest["send"];
  return () => {
    if (P.open === (wOpen as unknown)) P.open = open;
    if (P.send === (wSend as unknown)) P.send = send;
  };
}
