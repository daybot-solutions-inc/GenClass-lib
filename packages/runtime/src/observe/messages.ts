// The delivery gate for push channels (WebSocket, EventSource). Each incoming message is an instantaneous root op
// created synchronously inside the message dispatch (before any app listener runs). If the delivery decision holds
// it, the event is stopped before the app's listeners and re-dispatched later; messages (and close/error events)
// that arrive while one is held queue behind it, so a channel's order is always kept. Holding is only latency.

import type { OpRec, StartOpts } from "../trace/ops.js";
import type { Context } from "../trace/context.js";
import type { EndOpts } from "../decide/exec.js";
import type { OpStatus } from "../types.js";
import { describe, truncate, type Redactor } from "../util.js";
import { parseJsonBody } from "../situation/content.js";

export interface MsgHost {
  global: Record<string, unknown>;
  ctx: Context;
  redact(): Redactor;
  baseHref(): string | undefined;
  startOp(name: string, o: Omit<StartOpts, "startSeq" | "t">): OpRec;
  endOp(op: OpRec, status: OpStatus, o?: EndOpts): void;
  event(name: string, data: Record<string, unknown>, op?: OpRec): void;
  /**
   * The delivery gate (runtime): `release` delivers the message, synchronously when nothing is salient or nothing
   * can be held. `bodyNow` is the parsed message itself (in memory), for an analysis before the app's listeners run.
   */
  deliverMessage(
    o: { op: OpRec; channel: "websocket" | "eventsource"; message: { path: string; summary: string }; queuedAhead: number; body?: () => Promise<unknown>; bodyNow?: () => unknown },
    release: () => void,
  ): void;
  /** A live channel went down (closed or errored after it was open) or came up (opened). */
  channel?(state: "down" | "up", channel: "websocket" | "eventsource", path: string, code?: number | string): void;
}

const PARSE_MAX = 16 * 1024;

export function messageSummary(data: unknown, redact: Redactor): string {
  if (typeof data === "string") {
    const t = data.length > PARSE_MAX ? "" : data.trim();
    if (!t) return `${data.length} chars`;
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

interface Item {
  ev: Event;
  op: OpRec | null;
  summary: string;
  /** Ready to be dispatched to the app (decision taken, or a close/error event). */
  ready: boolean;
  deciding: boolean;
}

function cloneEvent(ev: Event): Event {
  const M = (globalThis as { MessageEvent?: typeof MessageEvent }).MessageEvent;
  if (M && ev instanceof M) {
    const m = ev as MessageEvent;
    return new M(m.type, { data: m.data, origin: m.origin, lastEventId: m.lastEventId, ports: [...(m.ports ?? [])] });
  }
  const C = (globalThis as { CloseEvent?: typeof CloseEvent }).CloseEvent;
  if (C && ev instanceof C) {
    const c = ev as CloseEvent;
    return new C(c.type, { code: c.code, reason: c.reason, wasClean: c.wasClean });
  }
  return new Event(ev.type);
}

export class MessageGate {
  private queue: Item[] = [];
  private mine = new WeakMap<Event, OpRec | null>();
  private interceptors = new Set<string>();

  constructor(
    private readonly target: EventTarget,
    private readonly host: MsgHost,
    private readonly channel: "websocket" | "eventsource",
    private readonly path: string,
    private readonly addRaw: (type: string, fn: (e: Event) => void) => void,
  ) {}

  /** Register the gate's first listener for an event type (once). */
  ensure(type: string): void {
    if (this.interceptors.has(type)) return;
    this.interceptors.add(type);
    this.addRaw(type, type === "close" || type === "error" ? this.orderOnly : this.intercept);
  }

  private opName(type: string): string {
    return this.channel === "websocket" ? `WS message ${this.path}` : type === "message" ? `SSE message ${this.path}` : `SSE ${type} ${this.path}`;
  }

  /** close/error events keep their place behind held messages. */
  private orderOnly = (e: Event): void => {
    if (this.mine.has(e)) return;
    if (!this.queue.length) return;
    e.stopImmediatePropagation();
    this.queue.push({ ev: e, op: null, summary: "", ready: true, deciding: false });
  };

  private intercept = (e: Event): void => {
    if (this.mine.has(e)) {
      // our own re-dispatch of a released message: the app's listeners run with the message op ambient
      const op = this.mine.get(e);
      if (op) this.host.ctx.stick(op);
      return;
    }
    let item: Item;
    try {
      const summary = messageSummary((e as MessageEvent).data, this.host.redact());
      const op = this.host.startOp(this.opName(e.type), { cause: null, instant: true, detail: summary });
      this.host.event(`${this.channel === "websocket" ? "ws" : "sse"}.message`, { path: this.path, summary, type: e.type }, op);
      item = { ev: e, op, summary, ready: false, deciding: false };
    } catch {
      return; // tracing never breaks a channel
    }
    if (this.queue.length) {
      // keep the channel's order: wait behind the held message(s)
      e.stopImmediatePropagation();
      this.queue.push(item);
      return;
    }
    if (this.decide(item, true)) {
      this.host.ctx.stick(item.op!);
      return; // not held: the event continues to the app's listeners now
    }
    e.stopImmediatePropagation();
    this.queue.push(item);
  };

  /** Ask the delivery gate. Returns true when released synchronously. */
  private decide(item: Item, first: boolean): boolean {
    item.deciding = true;
    let sync = true;
    let releasedSync = false;
    this.host.deliverMessage(
      {
        op: item.op!,
        channel: this.channel,
        message: { path: this.path, summary: item.summary },
        queuedAhead: first ? 0 : this.queue.indexOf(item),
        body: () => Promise.resolve(parseJsonBody((item.ev as MessageEvent).data as string)),
        bodyNow: () => parseJsonBody((item.ev as MessageEvent).data as string),
      },
      () => {
        if (sync) {
          releasedSync = true;
          return;
        }
        item.ready = true;
        this.pump();
      },
    );
    sync = false;
    return releasedSync;
  }

  /** Dispatch released messages in order; the next held one gets its own decision when it reaches the head. */
  private pump(): void {
    while (this.queue.length) {
      const head = this.queue[0];
      if (!head.ready) {
        if (head.deciding) return;
        if (!this.decide(head, false)) return;
        head.ready = true;
      }
      this.queue.shift();
      const copy = cloneEvent(head.ev);
      this.mine.set(copy, head.op);
      try {
        this.target.dispatchEvent(copy);
      } catch {
        /* a listener threw: the platform reports it */
      }
    }
  }
}
