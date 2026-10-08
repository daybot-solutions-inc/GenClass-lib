// WebSocket observer: the connection is an op (ends when open, or with an error/close before open); every
// incoming message is an instantaneous root op created inside the message dispatch, ambient while the app's
// handlers run, and passes the delivery gate (a held message and everything after it on the same socket wait, in
// order); outgoing sends are recorded.

import type { OpRec } from "../trace/ops.js";
import type { EndOpts } from "../decide/exec.js";
import type { OpStatus } from "../types.js";
import { normalizePath, parseUrl } from "../util.js";
import { MessageGate, messageSummary, type MsgHost } from "./messages.js";

export type WsHost = MsgHost;

export function installWebSocket(h: MsgHost): (() => void) | null {
  const g = h.global;
  const Native = g.WebSocket as (new (url: string | URL, protocols?: string | string[]) => WebSocket) | undefined;
  if (typeof Native !== "function") return null;
  let disabled = false;
  class GenClassWebSocket extends (Native as unknown as typeof WebSocket) {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      if (disabled) return; // a reference kept by another library after destroy(): plain WebSocket
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
      const raw = (type: string, fn: (e: Event) => void) => super.addEventListener(type, fn as EventListener);
      let down = false;
      const goDown = (code: number | string) => {
        if (down) return;
        down = true;
        try {
          h.channel?.("down", "websocket", path, code);
        } catch {
          /* tracing never breaks a channel */
        }
      };
      raw("open", () => {
        endConn("ok");
        try {
          h.channel?.("up", "websocket", path);
        } catch {
          /* ignore */
        }
      });
      raw("error", () => {
        endConn("error", { code: "network", failure: true });
        goDown("network");
      });
      raw("close", (e) => {
        const code = (e as CloseEvent).code;
        endConn("error", { code });
        if (code !== 1000) goDown(code);
      });
      const gate = new MessageGate(this, h, "websocket", path, raw);
      gate.ensure("message");
      gate.ensure("close");
      gate.ensure("error");
      const send = this.send;
      this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        try {
          const s = messageSummary(data, h.redact());
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
    disabled = true;
    if (g.WebSocket === GenClassWebSocket) g.WebSocket = Native;
  };
}
