// In-page virtual event loop. Every macrotask source that app code, frameworks and the runtime use is virtualised:
// setTimeout/setInterval (with Chromium's nesting clamp), requestAnimationFrame, requestIdleCallback, MessageChannel
// (React's scheduler, the runtime's afterTask), scheduler.postTask/yield, AbortSignal.timeout, Date,
// performance.now, Math.random and crypto randomness. Tasks run in (virtual time, phase, seq) order; after each one
// the loop yields real macrotasks (captured real MessageChannel) until every tracked native async operation
// (body reads, blob reads) has settled, so microtask chains and native follow-ups complete "inside" the same
// virtual instant. Nothing depends on real time, so the same config yields the same execution, byte for byte.

export interface Task {
  t: number;
  phase: number;
  seq: number;
  fn: () => void;
  kind: string;
  cancelled: boolean;
  /** setTimeout nesting level (Chromium clamps nested timers to 4 ms from level 5). */
  nest: number;
}

type AnyFn = (...a: unknown[]) => unknown;

/** Min-heap on (t, phase, seq). */
class Heap {
  private a: Task[] = [];
  get size(): number {
    return this.a.length;
  }
  private less(x: Task, y: Task): boolean {
    return x.t < y.t || (x.t === y.t && (x.phase < y.phase || (x.phase === y.phase && x.seq < y.seq)));
  }
  push(t: Task): void {
    const a = this.a;
    a.push(t);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  peek(): Task | undefined {
    return this.a[0];
  }
  pop(): Task | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && this.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }
}

export class VirtualLoop {
  now = 0;
  private seq = 0;
  private heap = new Heap();
  /** Native async operations in progress (body reads...). The loop drains them before the next virtual task. */
  pendingNative = 0;
  tasksRun = 0;
  /** Current timer nesting level (0 outside timer callbacks). */
  private nest = 0;
  internalErrors: string[] = [];
  /** Called after every task once its microtasks and native follow-ups settled. */
  onTaskEnd: (() => void) | null = null;
  /** Called with errors thrown by tasks (uncaught app errors). */
  onTaskError: ((e: unknown) => void) | null = null;
  private realYield: () => Promise<void>;
  stopped = false;

  constructor(RealMC: typeof MessageChannel) {
    const ch = new RealMC();
    let wake: (() => void) | null = null;
    ch.port1.onmessage = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    this.realYield = () =>
      new Promise<void>((r) => {
        wake = r;
        ch.port2.postMessage(null);
      });
  }

  schedule(delay: number, fn: () => void, kind: string, phase = 0, nest = 0): Task {
    const t: Task = { t: this.now + Math.max(0, delay), phase, seq: this.seq++, fn, kind, cancelled: false, nest };
    this.heap.push(t);
    return t;
  }

  at(time: number, fn: () => void, kind: string, phase = 0): Task {
    const t: Task = { t: Math.max(this.now, time), phase, seq: this.seq++, fn, kind, cancelled: false, nest: 0 };
    this.heap.push(t);
    return t;
  }

  cancel(t: unknown): void {
    if (t && typeof t === "object" && "cancelled" in (t as Task)) (t as Task).cancelled = true;
  }

  get nesting(): number {
    return this.nest;
  }

  /** Yield real macrotasks until native work settles (at least `min` hops, at most 400). */
  async settleNative(min = 2): Promise<void> {
    let hops = 0;
    while (hops < min || (this.pendingNative > 0 && hops < 400)) {
      await this.realYield();
      hops++;
    }
  }

  /** Run tasks up to virtual time `tStop` (inclusive), then set now = tStop. */
  async runUntil(tStop: number, maxTasks = 3_000_000): Promise<void> {
    await this.settleNative();
    for (;;) {
      if (this.stopped) return;
      const top = this.heap.peek();
      if (!top || top.t > tStop) break;
      this.heap.pop();
      if (top.cancelled) continue;
      this.now = top.t;
      this.nest = top.nest;
      this.tasksRun++;
      try {
        top.fn();
      } catch (e) {
        this.onTaskError?.(e);
      }
      this.nest = 0;
      await this.settleNative();
      this.onTaskEnd?.();
      if (this.tasksRun > maxTasks) {
        this.internalErrors.push(`task budget exceeded at t=${this.now}`);
        return;
      }
    }
    if (tStop > this.now) this.now = tStop;
  }
}

/** sfc32 seeded generator (same construction as sim/src/rng.ts). */
export function sfc32(seed: number): () => number {
  let x = seed >>> 0;
  const sm = () => {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = sm();
  let b = sm();
  let c = sm();
  let d = sm();
  const next = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    return t / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

/**
 * Install virtual time on `w` (the page window). Returns the loop. Must run before any page script (init script).
 */
export function installTime(w: Window & typeof globalThis, opts: { epoch: number; randomSeed: number }): VirtualLoop {
  const g = w as unknown as Record<string, unknown>;
  const RealMC = w.MessageChannel;
  const loop = new VirtualLoop(RealMC);

  // ---------------------------------------------------------------------------------------------- timers
  const timers = new Map<number, Task>();
  let nextId = 1;
  const setTimeoutV = (fn: unknown, ms?: unknown, ...args: unknown[]): number => {
    const id = nextId++;
    const cb = typeof fn === "function" ? fn : () => (0, eval)(String(fn));
    const nest = loop.nesting + 1;
    let delay = Math.max(0, Number(ms) || 0);
    if (nest > 5 && delay < 4) delay = 4;
    const task = loop.schedule(delay, () => {
      timers.delete(id);
      (cb as AnyFn)(...args);
    }, "timer", 0, nest);
    timers.set(id, task);
    return id;
  };
  const clearTimeoutV = (id: unknown): void => {
    const t = timers.get(Number(id));
    if (t) {
      t.cancelled = true;
      timers.delete(Number(id));
    }
  };
  const setIntervalV = (fn: unknown, ms?: unknown, ...args: unknown[]): number => {
    const id = nextId++;
    const period = Math.max(4, Number(ms) || 0);
    const tick = () => {
      const task = loop.schedule(period, () => {
        if (!timers.has(id)) return;
        tick();
        (fn as AnyFn)(...args);
      }, "interval", 0, 6);
      timers.set(id, task);
    };
    tick();
    return id;
  };
  g.setTimeout = setTimeoutV;
  g.clearTimeout = clearTimeoutV;
  g.setInterval = setIntervalV;
  g.clearInterval = clearTimeoutV;

  // -------------------------------------------------------------------------------- animation / idle
  let rafQueue: Map<number, FrameRequestCallback> | null = null;
  let rafId = 1;
  const FRAME = 1000 / 60;
  g.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = rafId++;
    if (!rafQueue) {
      rafQueue = new Map();
      const next = Math.floor(loop.now / FRAME + 1) * FRAME;
      loop.at(next, () => {
        const q = rafQueue!;
        rafQueue = null;
        for (const f of q.values()) {
          try {
            f(loop.now);
          } catch (e) {
            loop.onTaskError?.(e);
          }
        }
      }, "raf");
    }
    rafQueue.set(id, cb);
    return id;
  };
  g.cancelAnimationFrame = (id: number): void => {
    rafQueue?.delete(id);
  };
  const idle = new Map<number, Task>();
  g.requestIdleCallback = (cb: IdleRequestCallback, _o?: IdleRequestOptions): number => {
    const id = nextId++;
    idle.set(id, loop.schedule(1, () => {
      idle.delete(id);
      cb({ didTimeout: false, timeRemaining: () => 40 });
    }, "idle", 1));
    return id;
  };
  g.cancelIdleCallback = (id: number): void => {
    const t = idle.get(id);
    if (t) t.cancelled = true;
  };

  // ------------------------------------------------------------------------------------ MessageChannel
  class VMessagePort extends EventTarget {
    other: VMessagePort | null = null;
    private handler: ((e: MessageEvent) => void) | null = null;
    private started = false;
    private closed = false;
    private queue: MessageEvent[] = [];
    get onmessage(): ((e: MessageEvent) => void) | null {
      return this.handler;
    }
    set onmessage(fn: ((e: MessageEvent) => void) | null) {
      this.handler = fn;
      this.start();
    }
    onmessageerror: unknown = null;
    start(): void {
      if (this.started) return;
      this.started = true;
      const q = this.queue;
      this.queue = [];
      for (const ev of q) loop.schedule(0, () => this.deliver(ev), "message");
    }
    close(): void {
      this.closed = true;
    }
    deliver(ev: MessageEvent): void {
      if (this.closed) return;
      this.dispatchEvent(ev);
      this.handler?.call(this, ev);
    }
    postMessage(data: unknown): void {
      const target = this.other;
      if (!target || this.closed) return;
      let copy: unknown = data;
      try {
        copy = data === null || typeof data !== "object" ? data : structuredClone(data);
      } catch {
        copy = data;
      }
      const ev = new MessageEvent("message", { data: copy });
      if (!target.started) {
        target.queue.push(ev);
        return;
      }
      loop.schedule(0, () => target.deliver(ev), "message");
    }
    override addEventListener(type: string, cb: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions): void {
      super.addEventListener(type, cb, o);
    }
  }
  class VMessageChannel {
    port1: VMessagePort;
    port2: VMessagePort;
    constructor() {
      this.port1 = new VMessagePort();
      this.port2 = new VMessagePort();
      this.port1.other = this.port2;
      this.port2.other = this.port1;
    }
  }
  g.MessageChannel = VMessageChannel;
  g.MessagePort = VMessagePort;

  // ------------------------------------------------------------------------------ scheduler.postTask/yield
  const sch = g.scheduler as Record<string, unknown> | undefined;
  if (sch && typeof sch === "object") {
    try {
      sch.postTask = (fn: () => unknown, o?: { delay?: number; signal?: AbortSignal }) =>
        new Promise((res, rej) => {
          const t = loop.schedule(o?.delay ?? 0, () => {
            try {
              res(fn());
            } catch (e) {
              rej(e);
            }
          }, "postTask");
          o?.signal?.addEventListener("abort", () => {
            t.cancelled = true;
            rej(o.signal!.reason);
          });
        });
      sch.yield = () => new Promise<void>((res) => loop.schedule(0, () => res(), "yield"));
    } catch {
      /* read-only */
    }
  }

  // ------------------------------------------------------------------------------------ AbortSignal.timeout
  try {
    (AbortSignal as unknown as Record<string, unknown>).timeout = (ms: number) => {
      const c = new AbortController();
      setTimeoutV(() => c.abort(new DOMException("signal timed out", "TimeoutError")), ms);
      return c.signal;
    };
  } catch {
    /* ignore */
  }

  // ------------------------------------------------------------------------------------- Date, performance
  const RealDate = Date;
  const epoch = opts.epoch;
  function VDate(this: unknown, ...args: unknown[]): unknown {
    if (!new.target) return new RealDate(epoch + loop.now).toString();
    if (args.length === 0) return new RealDate(epoch + loop.now);
    return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
  }
  VDate.prototype = RealDate.prototype;
  (VDate as unknown as Record<string, unknown>).now = () => Math.floor(epoch + loop.now);
  (VDate as unknown as Record<string, unknown>).parse = RealDate.parse;
  (VDate as unknown as Record<string, unknown>).UTC = RealDate.UTC;
  g.Date = VDate;
  const perfNow = () => loop.now;
  try {
    Object.defineProperty(w.performance, "now", { value: perfNow, configurable: true, writable: true });
  } catch {
    /* ignore */
  }

  // ------------------------------------------------------------------------------------------ randomness
  const rnd = sfc32(opts.randomSeed);
  Math.random = rnd;
  try {
    const c = w.crypto as Crypto & Record<string, unknown>;
    const grv = <T extends ArrayBufferView | null>(arr: T): T => {
      if (arr && ArrayBuffer.isView(arr)) {
        const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
        for (let i = 0; i < u8.length; i++) u8[i] = Math.floor(rnd() * 256);
      }
      return arr;
    };
    Object.defineProperty(c, "getRandomValues", { value: grv, configurable: true, writable: true });
    Object.defineProperty(c, "randomUUID", {
      value: () => {
        const b = grv(new Uint8Array(16));
        b[6] = (b[6]! & 0x0f) | 0x40;
        b[8] = (b[8]! & 0x3f) | 0x80;
        const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      },
      configurable: true,
      writable: true,
    });
  } catch {
    /* ignore */
  }

  // ------------------------------------------------------------------- native async work tracking (bodies)
  const track = (proto: object | undefined, names: string[]) => {
    if (!proto) return;
    for (const n of names) {
      const d = Object.getOwnPropertyDescriptor(proto, n);
      if (!d || typeof d.value !== "function") continue;
      const orig = d.value as AnyFn;
      Object.defineProperty(proto, n, {
        ...d,
        value: function (this: unknown, ...a: unknown[]) {
          const p = orig.apply(this, a) as Promise<unknown>;
          if (!p || typeof (p as Promise<unknown>).then !== "function") return p;
          loop.pendingNative++;
          const done = () => {
            loop.pendingNative--;
          };
          (p as Promise<unknown>).then(done, done);
          return p;
        },
      });
    }
  };
  track(w.Response?.prototype, ["json", "text", "arrayBuffer", "blob", "formData", "bytes"]);
  track(w.Request?.prototype, ["json", "text", "arrayBuffer", "blob", "formData", "bytes"]);
  track(w.Blob?.prototype, ["text", "arrayBuffer", "bytes"]);
  track((w as unknown as { ReadableStreamDefaultReader?: { prototype: object } }).ReadableStreamDefaultReader?.prototype, ["read"]);

  // FileReader completes on real time: count each read as native work until its loadend
  const FR = (w as unknown as { FileReader?: { prototype: Record<string, unknown> } }).FileReader;
  if (FR) {
    for (const n of ["readAsText", "readAsArrayBuffer", "readAsDataURL", "readAsBinaryString"]) {
      const orig = FR.prototype[n] as AnyFn | undefined;
      if (typeof orig !== "function") continue;
      FR.prototype[n] = function (this: EventTarget, ...a: unknown[]) {
        loop.pendingNative++;
        let done = false;
        this.addEventListener("loadend", () => {
          if (!done) {
            done = true;
            loop.pendingNative--;
          }
        }, { once: true });
        try {
          return orig.apply(this, a);
        } catch (e) {
          if (!done) {
            done = true;
            loop.pendingNative--;
          }
          throw e;
        }
      };
    }
  }

  // ----------------------------------------------------------- observers that depend on real layout timing
  class VObserver {
    constructor(_cb: unknown) {}
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  }
  g.ResizeObserver = VObserver;
  g.IntersectionObserver = VObserver;
  g.PerformanceObserver = class extends VObserver {
    static supportedEntryTypes: string[] = [];
  };
  return loop;
}
