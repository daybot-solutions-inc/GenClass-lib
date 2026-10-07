// Timers observer (CONTRACT §3): callbacks of setTimeout/setInterval run with a lazy "timer" op as the ambient
// op (its cause is the op that was ambient when the timer was scheduled). The op only materializes if the
// callback starts a request or writes state, so idle timers cost one small object.

import type { Context, LazyOp } from "../trace/context.js";
import type { OpRec } from "../trace/ops.js";
import { secs } from "../util.js";

export interface TimerHost {
  global: Record<string, unknown>;
  ctx: Context;
  lazyTimer(parent: OpRec | LazyOp | null, label: string): LazyOp;
}

type TimerFn = (fn: unknown, ms?: number, ...args: unknown[]) => unknown;

export function installTimers(h: TimerHost): (() => void) | null {
  const g = h.global;
  const st = g.setTimeout as TimerFn | undefined;
  const si = g.setInterval as TimerFn | undefined;
  if (typeof st !== "function") return null;
  const wrap = (orig: TimerFn, kind: "timer" | "interval"): TimerFn =>
    function (this: unknown, fn: unknown, ms?: number, ...args: unknown[]) {
      if (typeof fn !== "function") return orig.call(g, fn, ms, ...args);
      const parent = h.ctx.peek();
      const delay = Math.max(0, Number(ms) || 0);
      const label = kind === "timer" ? `timer ${delay < 1000 ? `${Math.round(delay)}ms` : secs(delay)}` : `interval ${secs(delay)}`;
      const cb = function (this: unknown, ...a: unknown[]) {
        h.ctx.stick(h.lazyTimer(parent, label));
        return (fn as (...x: unknown[]) => unknown).apply(this, a);
      };
      return orig.call(g, cb, ms, ...args);
    };
  const wst = wrap(st, "timer");
  g.setTimeout = wst;
  let wsi: TimerFn | undefined;
  if (typeof si === "function") {
    wsi = wrap(si, "interval");
    g.setInterval = wsi;
  }
  return () => {
    if (g.setTimeout === wst) g.setTimeout = st;
    if (wsi && g.setInterval === wsi) g.setInterval = si;
  };
}
