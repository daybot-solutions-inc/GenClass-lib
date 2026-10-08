// EventSource observer: like WebSocket. The stream connection is an op (ends at open or error); every message
// (`message` and custom event types, with lastEventId in the event) is an instantaneous root op created inside the
// dispatch, ambient while the app's handlers run, and passes the delivery gate with the stream's order kept.
// Custom event types are intercepted when the app first listens to them.

import type { OpRec } from "../trace/ops.js";
import type { OpStatus } from "../types.js";
import type { EndOpts } from "../decide/exec.js";
import { normalizePath, parseUrl } from "../util.js";
import { MessageGate, type MsgHost } from "./messages.js";

const OWN = new Set(["open", "error"]);

export function installEventSource(h: MsgHost): (() => void) | null {
  const g = h.global;
  const Native = g.EventSource as (new (url: string | URL, init?: EventSourceInit) => EventSource) | undefined;
  if (typeof Native !== "function") return null;
  let disabled = false;
  const gates = new WeakMap<object, MessageGate>();
  class GenClassEventSource extends (Native as unknown as typeof EventSource) {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      if (disabled) return;
      const u = parseUrl(String(url), h.baseHref());
      const path = normalizePath(u.where);
      let conn: OpRec | null = null;
      try {
        conn = h.startOp(`SSE ${path}`, { detail: "connect" });
      } catch {
        conn = null;
      }
      const endConn = (status: OpStatus, o?: EndOpts) => {
        if (conn && conn.end === undefined) h.endOp(conn, status, o);
      };
      const raw = (type: string, fn: (e: Event) => void) => super.addEventListener(type, fn as EventListener);
      raw("open", () => endConn("ok"));
      raw("error", () => endConn("error", { code: "network", failure: true }));
      const gate = new MessageGate(this, h, "eventsource", path, raw);
      gates.set(this, gate);
      gate.ensure("message");
      gate.ensure("error");
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override addEventListener(type: string, listener: any, options?: boolean | AddEventListenerOptions): void {
      const gate = gates.get(this);
      if (gate && !OWN.has(type)) gate.ensure(type);
      super.addEventListener(type, listener, options);
    }
  }
  g.EventSource = GenClassEventSource;
  return () => {
    disabled = true;
    if (g.EventSource === GenClassEventSource) g.EventSource = Native;
  };
}
