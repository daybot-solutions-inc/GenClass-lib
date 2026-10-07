// WebSocket observer: the connection is an op (ends when open, or with an error/close before open); every
// incoming message is an instantaneous root op that is ambient while the app's message handlers run, so writes
// they make are attributed to that message; outgoing sends are recorded.

import type { Context } from "../trace/context.js";
import type { OpRec, StartOpts } from "../trace/ops.js";
import type { EndOpts } from "../decide/exec.js";
import type { OpStatus } from "../types.js";
import { describe, normalizePath, parseUrl, truncate, type Redactor } from "../util.js";

export interface WsHost {
  global: Record<string, unknown>;
  ctx: Context;
  redact(): Redactor;
  baseHref(): string | undefined;
  startOp(name: string, o: Omit<StartOpts, "startSeq" | "t">): OpRec;
  endOp(op: OpRec, status: OpStatus, o?: EndOpts): void;
  event(name: string, data: Record<string, unknown>, op?: OpRec): void;
}

function summary(data: unknown, redact: Redactor): string {
  if (typeof data === "string") {
    const t = data.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return describe(JSON.parse(t), "message", redact, 60);
      } catch {
        /* not JSON */
      }
    }
    return JSON.stringify(truncate(t, 40));
  }
  if (data && typeof (data as Blob).size === "number") return `${(data as Blob).size} bytes`;
  if (data instanceof ArrayBuffer) return `${data.byteLength} bytes`;
  return "binary";
}

export function installWebSocket(h: WsHost): (() => void) | null {
  const g = h.global;
  const Native = g.WebSocket as (new (url: string | URL, protocols?: string | string[]) => WebSocket) | undefined;
  if (typeof Native !== "function") return null;
  class GenClassWebSocket extends (Native as unknown as typeof WebSocket) {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const u = parseUrl(String(url), h.baseHref());
      const path = normalizePath(u.where);
      let conn: OpRec | null = null;
      try {
        conn = h.startOp(`WS ${path}`, { detail: "connect" });
      } catch {
        conn = null;
      }
      const endConn = (status: OpStatus, o?: EndOpts) => {
        if (conn && conn.end === undefined) h.endOp(conn, status, o);
      };
      this.addEventListener("open", () => endConn("ok"));
      this.addEventListener("error", () => endConn("error", { code: "network", failure: true }));
      this.addEventListener("close", (e) => endConn("error", { code: (e as CloseEvent).code }));
      this.addEventListener("message", (e) => {
        try {
          const s = summary((e as MessageEvent).data, h.redact());
          const m = h.startOp(`WS message ${path}`, { cause: null, instant: true, detail: s });
          h.event("ws.message", { path, summary: s }, m);
          h.ctx.stick(m);
        } catch {
          /* tracing never breaks the socket */
        }
      });
      const send = this.send;
      this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        try {
          const s = summary(data, h.redact());
          const m = h.startOp(`WS send ${path}`, { instant: true, detail: s });
          h.event("ws.send", { path, summary: s }, m);
        } catch {
          /* ignore */
        }
        return send.call(this, data);
      };
    }
  }
  g.WebSocket = GenClassWebSocket;
  return () => {
    if (g.WebSocket === GenClassWebSocket) g.WebSocket = Native;
  };
}
