// Ambient-op context propagation (CONTRACT §3, best effort).
//
// `current` is the op whose work is executing right now. It is set
//   - synchronously while a user handler or runtime.op body runs (run),
//   - for the rest of a macrotask's microtask checkpoint after a wrapped fetch/XHR/body method settles, a user
//     action is recorded, or a propagated timer fires (stick); clock.afterTask clears it.
// Timer callbacks get a *lazy* op that only becomes a real "timer" op if something uses it (a request starts or
// a state write happens), so idle timers cost nothing.

import type { Clock } from "../types.js";
import type { OpRec } from "./ops.js";

/**
 * A timer op created only if something uses it. Its parent is always a real op (or null), never another lazy op:
 * a recursive setTimeout loop links each tick to the nearest op that exists, so no chain of closures builds up.
 */
export class LazyOp {
  private made: OpRec | null = null;
  private make: ((parent: OpRec | null) => OpRec) | null;
  private parentOp: OpRec | null;
  constructor(parent: OpRec | null, make: (parent: OpRec | null) => OpRec) {
    this.parentOp = parent;
    this.make = make;
  }
  materialize(): OpRec {
    if (!this.made) {
      this.made = this.make!(this.parentOp);
      this.make = null;
      this.parentOp = null;
    }
    return this.made;
  }
  get materialized(): OpRec | null {
    return this.made;
  }
  /** The op that timers scheduled from inside this one should link to. */
  get nearest(): OpRec | null {
    return this.made ?? this.parentOp;
  }
}

export type Ambient = OpRec | LazyOp | null;

export class Context {
  private cur: Ambient = null;
  /** The user op recorded in the current task (cleared by afterTask). */
  private taskUser: OpRec | null = null;

  constructor(private readonly clock: Clock) {}

  /** The ambient op, materializing a lazy timer op. */
  op(): OpRec | null {
    const c = this.cur;
    if (c instanceof LazyOp) {
      const m = c.materialize();
      this.cur = m;
      return m;
    }
    return c;
  }

  /** The ambient value without materializing (to chain lazy ops). */
  peek(): Ambient {
    return this.cur;
  }

  run<T>(op: Ambient, fn: () => T): T {
    const prev = this.cur;
    this.cur = op;
    try {
      return fn();
    } finally {
      this.cur = prev;
    }
  }

  /** Make `op` ambient until the end of the current macrotask (cleared by clock.afterTask). */
  stick(op: OpRec | LazyOp): void {
    this.cur = op;
    this.clock.afterTask(() => {
      const c = this.cur;
      if (c === op || (op instanceof LazyOp && c === op.materialized)) this.cur = null;
    });
  }

  /** Record a user op for the current task: writes in this task that descend from it are user writes. */
  stickUser(op: OpRec): void {
    this.taskUser = op;
    this.stick(op);
    this.clock.afterTask(() => {
      if (this.taskUser === op) this.taskUser = null;
    });
  }

  /** True when `op` is the current task's user op or descends from it. */
  isUserSync(op: OpRec | null): boolean {
    const u = this.taskUser;
    if (!u || !op) return false;
    return op === u || op.root === u.root || op.root === u.id;
  }

  clear(): void {
    this.cur = null;
    this.taskUser = null;
  }
}
