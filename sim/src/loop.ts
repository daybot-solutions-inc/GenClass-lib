// Virtual event loop. Macrotasks are ordered by (virtual time, insertion seq). After each macrotask the loop yields
// one real `setImmediate` turn, which lets Node drain the microtask queue completely (promise jobs, including
// undici Response body reads, settle purely in microtasks: verified on the VM), then runs `afterTask` hooks (and
// drains again) before the next macrotask. Virtual time jumps; nothing here reads real time.

import type { Clock } from "./types.js";

export type TaskOwner = "app" | "net" | "runtime" | "user" | "sim";

interface Task {
  t: number;
  seq: number;
  fn: () => void;
  owner: TaskOwner;
  cancelled: boolean;
}

class MinHeap {
  private a: Task[] = [];
  get size(): number {
    return this.a.length;
  }
  private less(x: Task, y: Task): boolean {
    return x.t < y.t || (x.t === y.t && x.seq < y.seq);
  }
  push(x: Task): void {
    const a = this.a;
    a.push(x);
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
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
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

const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

export class LoopError extends Error {}

export class VirtualLoop {
  private t = 0;
  private seq = 0;
  private heap = new MinHeap();
  private after: (() => void)[] = [];
  tasksRun = 0;
  /** Called after every macrotask has fully settled (microtasks + afterTask hooks). */
  onSettled: (() => void) | null = null;
  /** Errors thrown synchronously by app-owned tasks (timers): the app's "uncaught exception". */
  onAppError: ((e: unknown) => void) | null = null;
  /** Errors thrown by sim/net/runtime-owned tasks: internal failures (the trajectory is dropped). */
  internalErrors: unknown[] = [];
  private stopped = false;

  now(): number {
    return this.t;
  }

  schedule(ms: number, fn: () => void, owner: TaskOwner): Task {
    const d = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const task: Task = { t: this.t + d, seq: this.seq++, fn, owner, cancelled: false };
    this.heap.push(task);
    return task;
  }

  at(t: number, fn: () => void, owner: TaskOwner): Task {
    return this.schedule(Math.max(0, t - this.t), fn, owner);
  }

  cancel(h: unknown): void {
    if (h && typeof h === "object" && "cancelled" in h) (h as Task).cancelled = true;
  }

  afterTask(fn: () => void): void {
    this.after.push(fn);
  }

  /** The `Clock` handed to the runtime: its timers are runtime-owned. */
  clockFor(owner: TaskOwner = "runtime"): Clock {
    return {
      now: () => this.t,
      setTimeout: (fn: () => void, ms: number) => this.schedule(ms, fn, owner),
      clearTimeout: (h: unknown) => this.cancel(h),
      afterTask: (fn: () => void) => this.afterTask(fn),
    };
  }

  pending(): number {
    return this.heap.size;
  }

  nextTime(): number | undefined {
    for (;;) {
      const top = this.heap.peek();
      if (!top) return undefined;
      if (top.cancelled) {
        this.heap.pop();
        continue;
      }
      return top.t;
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** Let microtasks queued outside any macrotask (setup code) settle, then run afterTask hooks. */
  async settle(): Promise<void> {
    await turn();
    await this.flushAfter();
  }

  private async flushAfter(): Promise<void> {
    let guard = 0;
    while (this.after.length > 0) {
      if (++guard > 1000) throw new LoopError("afterTask hooks keep re-arming");
      const fns = this.after;
      this.after = [];
      for (const fn of fns) {
        try {
          fn();
        } catch (e) {
          this.internalErrors.push(e);
        }
      }
      await turn();
    }
  }

  /** Run macrotasks with time <= tEnd; leaves `now` at tEnd. */
  async runUntil(tEnd: number, maxTasks = 2_000_000): Promise<void> {
    while (!this.stopped) {
      const top = this.heap.peek();
      if (!top || top.t > tEnd) break;
      this.heap.pop();
      if (top.cancelled) continue;
      if (top.t > this.t) this.t = top.t;
      if (++this.tasksRun > maxTasks) throw new LoopError(`task budget exceeded (${maxTasks})`);
      try {
        top.fn();
      } catch (e) {
        if (top.owner === "app" || top.owner === "user") {
          if (this.onAppError) this.onAppError(e);
          else this.internalErrors.push(e);
        } else {
          this.internalErrors.push(e);
        }
      }
      await turn();
      if (this.after.length > 0) await this.flushAfter();
      if (this.onSettled) this.onSettled();
    }
    if (!this.stopped && tEnd > this.t) this.t = tEnd;
  }
}
