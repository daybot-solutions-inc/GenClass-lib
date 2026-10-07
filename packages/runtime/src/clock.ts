// Clock: the only source of time and scheduling inside the runtime (CONTRACT §0.3, §3).
//
// browserClock captures the real timers at module load, so the runtime's own scheduling never goes through
// the timers observer (which wraps the app's global setTimeout) and never observes itself.

import type { Clock } from "./types.js";

type AnyFn = (...args: unknown[]) => unknown;
const G = globalThis as unknown as Record<string, unknown>;

const realSetTimeout = (G.setTimeout as AnyFn | undefined)?.bind(globalThis) as
  | ((fn: () => void, ms: number) => unknown)
  | undefined;
const realClearTimeout = (G.clearTimeout as AnyFn | undefined)?.bind(globalThis) as ((h: unknown) => void) | undefined;
const realSetImmediate = (G.setImmediate as AnyFn | undefined)?.bind(globalThis) as ((fn: () => void) => unknown) | undefined;
const RealMessageChannel = G.MessageChannel as (new () => MessageChannel) | undefined;
const perf = G.performance as { now(): number } | undefined;
const hasWindow = typeof G.window === "object" && G.window !== null;

/** Batches afterTask callbacks: one flush per macrotask, after its microtasks. */
function makeAfterTask(): (fn: () => void) => void {
  let queue: (() => void)[] = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const q = queue;
    queue = [];
    for (const fn of q) {
      try {
        fn();
      } catch {
        /* afterTask callbacks never throw into the host */
      }
    }
  };
  let post: () => void;
  if (realSetImmediate && !hasWindow) {
    // Node (and Node-hosted DOM shims): setImmediate runs after the current task's microtasks.
    post = () => realSetImmediate(flush);
  } else if (RealMessageChannel) {
    const ch = new RealMessageChannel();
    ch.port1.onmessage = flush;
    const p1 = ch.port1 as unknown as { unref?: () => void };
    const p2 = ch.port2 as unknown as { unref?: () => void };
    p1.unref?.();
    p2.unref?.();
    post = () => ch.port2.postMessage(null);
  } else if (realSetImmediate) {
    post = () => realSetImmediate(flush);
  } else {
    post = () => realSetTimeout?.(flush, 0);
  }
  return (fn: () => void) => {
    queue.push(fn);
    if (!scheduled) {
      scheduled = true;
      post();
    }
  };
}

let startT = 0;
function nowMs(): number {
  if (perf && typeof perf.now === "function") return perf.now();
  // No performance.now: fall back to a monotonic counter derived from the event loop (never Date.now).
  return (startT += 1);
}

/** The real clock: performance.now, timers captured at module load, MessageChannel/setImmediate afterTask. */
export const browserClock: Clock = {
  now: nowMs,
  setTimeout(fn: () => void, ms: number): unknown {
    if (!realSetTimeout) throw new Error("GenClass: no setTimeout available; pass a clock");
    const h = realSetTimeout(fn, Math.max(0, ms)) as { unref?: () => void } | number;
    // In Node, never keep the process alive for runtime housekeeping timers.
    if (h && typeof h === "object" && typeof h.unref === "function" && !hasWindow) h.unref();
    return h;
  },
  clearTimeout(h: unknown): void {
    if (h !== undefined && h !== null) realClearTimeout?.(h);
  },
  afterTask: makeAfterTask(),
};
