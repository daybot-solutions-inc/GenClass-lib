// Shared types of automatic state discovery (InitOptions.autoState; src/discover/*).
//
// Discovery runs inside the host app's own calls (React's commit, a setState, a Redux/Zustand devtools call): every
// entry point is wrapped in try/catch and never throws into the app. Discovered React state and stores connected
// through the Redux DevTools `connect` API are OBSERVED-ONLY (hub kind "observed"): GenClass records their writes
// with the op that made them, but can never hold, drop or revert them. Redux stores created through the devtools
// compose/enhancer shims get the full adapter (src/adapters/redux.ts), like a manual genclassEnhancer.

import type { Clock } from "../types.js";

/** The writer of a write, captured when the app made it (resolved to an op only when the write is recorded). */
export interface Captured {
  /** Opaque ambient value (an op, a lazy timer op or null). */
  readonly amb: unknown;
  /** Made in a user handler's task (a user-sync write). */
  readonly user: boolean;
  /** Capture order (several writers in one React commit apply in this order). */
  readonly seq: number;
}

/** An observed-only store: `write` records a value the app already holds. */
export interface ObservedStore {
  readonly name: string;
  write(value: unknown, writer: Captured | null): void;
}

export interface DiscoveryHost {
  readonly global: Record<string, unknown>;
  readonly clock: Clock;
  /** Capture the writer of a write happening right now (cheap: nothing is materialised). */
  capture(): Captured;
  /** Register an observed-only store under a free name derived from `base`; null when the store cap is reached. */
  observed(base: string, initial: unknown, source: string): ObservedStore | null;
  /** A free store name derived from `base` (never clashing with a store the app registered). */
  freeName(base: string): string | null;
  /** Mark a registered store as discovered (devtools, stores()). */
  tag(name: string, source: string): void;
  log(msg: string, e?: unknown): void;
}

export interface WalkStats {
  /** Commits seen. */
  commits: number;
  /** Commits whose walk stopped at the time budget. */
  overBudget: number;
  /** Fibers visited (all commits). */
  visited: number;
  /** Commit-walk durations in ms (last 1,024 commits). */
  samples: number[];
  /** Walk errors (discovery turns itself off after 5). */
  errors: number;
}

/** Name usable as a store name: [A-Za-z0-9_$], at most 40 characters ("" when nothing is left). */
export function storeBase(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(/[^A-Za-z0-9_$]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}
