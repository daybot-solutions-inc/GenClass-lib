// The sim's own knowledge of what the app is doing and why: user intents, app-level operations (requests with
// their purpose), store writes (with the operation/intent that produced them) and error causes. Diagnosis labels
// are computed from this knowledge, never from the runtime's text.

export type Mode = "replace" | "accumulate";

export interface Intent {
  id: number;
  t: number;
  feature: string;
  /** e.g. "query", "save", "add", "toggle", "open", "refresh" */
  kind: string;
  /** The slot the intent targets. Newer replace-intents on the same key supersede older ones. */
  key: string;
  mode: Mode;
  /** A repeat with no new intent (double click, impatient re-click). */
  accidental: boolean;
  repeatOf?: number;
}

export interface SimOp {
  id: number;
  feature: string;
  role: string;
  intent?: number;
  key?: string;
  method: string;
  url: string;
  body?: string;
  idempotent: boolean;
  /** App-level attempt (1 = first). */
  attempt: number;
  retryOf?: number;
  t0: number;
  tEnd?: number;
  outcome?: "ok" | "http-error" | "neterr" | "aborted" | "timeout" | "parse-error" | "blocked";
  status?: number;
  /** Background work (poll, push-triggered reload, initial load). */
  background: boolean;
  /** The app handles failures of this op gracefully (own retry/fallback, no user-visible error). */
  handled?: boolean;
  /** Another op of the same intent this one repeats (accidental double submit, overlapping poll). */
  dupOf?: number;
  /** Set by the feature when a defect path or server anomaly shaped this op's effect. */
  anomaly?: "partial" | "shape" | "empty" | "benign-change" | string;
  /** Runtime op id (when correlated). */
  rtOp?: number;
  /** Network log entries (ids) this op produced (first attempt, runtime retries/hedges). */
  net?: number[];
  /** Feature-provided classifier evaluated at decision time. */
  classify?: () => string | undefined;
}

export interface SimWrite {
  id: number;
  t: number;
  store: string;
  /** Top-level fields the write changes (relative to the value at proposal time). */
  fields?: string[];
  feature: string;
  role: string;
  op?: number;
  intent?: number;
  key?: string;
  anomaly?: string;
  classify?: () => string | undefined;
  rtMutation?: number;
}

export interface ErrorTag {
  cause: string;
  feature: string;
  op?: number;
  /** Diagnosis the error stems from. */
  diagnosis: string;
}

export class Knowledge {
  intents: Intent[] = [];
  ops: SimOp[] = [];
  writes: SimWrite[] = [];
  errors = new WeakMap<object, ErrorTag>();
  errorList: { t: number; tag: ErrorTag }[] = [];
  /** runtime op id -> sim op id */
  rtOps = new Map<number, number>();
  /** runtime mutation id -> sim write id */
  rtMutations = new Map<number, number>();
  /** Ambient sim op while the app synchronously calls fetch (for runtime op correlation). */
  callingOp: SimOp | null = null;
  /** Ambient intent while the runner calls runtime.user (runtime user op -> intent). */
  callingIntent: number | null = null;
  /** runtime user op id -> intent id */
  rtUserOps = new Map<number, number>();
  /** runtime op id -> runtime parent op id */
  rtParents = new Map<number, number>();
  /** Ambient sim write while the app synchronously calls set (for runtime mutation correlation). */
  writing: SimWrite | null = null;
  /** "store.field" -> time of the latest user-input write to it. */
  userFieldTime = new Map<string, number>();
  /** Per key: time of the latest local (user-driven) change. */
  localChange = new Map<string, number>();
  /** Per key: start time of the op whose data was most recently applied. */
  appliedReadStart = new Map<string, number>();
  /** Per signature: consecutive failures seen by the app. */
  streak = new Map<string, number>();
  /** User-visible error episodes (count and times). */
  shownErrors = 0;
  shownErrorTimes: number[] = [];
  now: () => number = () => 0;

  intent(p: Omit<Intent, "id" | "t"> & { t?: number }): Intent {
    const it: Intent = { id: this.intents.length + 1, t: p.t ?? this.now(), feature: p.feature, kind: p.kind, key: p.key, mode: p.mode, accidental: p.accidental };
    if (p.repeatOf !== undefined) it.repeatOf = p.repeatOf;
    this.intents.push(it);
    if (!it.accidental && it.mode === "replace") this.localChange.set(it.key, it.t);
    return it;
  }

  getIntent(id: number | undefined): Intent | undefined {
    return id === undefined ? undefined : this.intents[id - 1];
  }

  /** Latest non-accidental intent on a key. */
  latestIntent(key: string): Intent | undefined {
    for (let i = this.intents.length - 1; i >= 0; i--) {
      const it = this.intents[i]!;
      if (it.key === key && !it.accidental) return it;
    }
    return undefined;
  }

  /** True when a newer non-accidental replace-intent exists on the same key. */
  superseded(intentId: number | undefined): boolean {
    const it = this.getIntent(intentId);
    if (!it || it.mode !== "replace") return false;
    const latest = this.latestIntent(it.key);
    return !!latest && latest.id > it.id;
  }

  beginOp(p: Omit<SimOp, "id" | "t0" | "attempt"> & { attempt?: number }): SimOp {
    const op: SimOp = { ...p, id: this.ops.length + 1, t0: this.now(), attempt: p.attempt ?? 1 };
    this.ops.push(op);
    return op;
  }

  getOp(id: number | undefined): SimOp | undefined {
    return id === undefined ? undefined : this.ops[id - 1];
  }

  endOp(op: SimOp, outcome: SimOp["outcome"], status?: number): void {
    if (op.tEnd !== undefined) return;
    op.tEnd = this.now();
    op.outcome = outcome;
    if (status !== undefined) op.status = status;
    const sig = sigOf(op);
    if (outcome === "ok") this.streak.set(sig, 0);
    else if (outcome !== "aborted") this.streak.set(sig, (this.streak.get(sig) ?? 0) + 1);
  }

  write(p: Omit<SimWrite, "id" | "t">): SimWrite {
    const w: SimWrite = { ...p, id: this.writes.length + 1, t: this.now() };
    this.writes.push(w);
    return w;
  }

  getWrite(id: number | undefined): SimWrite | undefined {
    return id === undefined ? undefined : this.writes[id - 1];
  }

  tagError(err: unknown, tag: ErrorTag): void {
    if (err && typeof err === "object") this.errors.set(err, tag);
    this.errorList.push({ t: this.now(), tag });
  }

  /** In-flight ops at time t (app view). */
  inflight(): SimOp[] {
    return this.ops.filter((o) => o.tEnd === undefined);
  }
}

/** Coarse signature of an app op (method + path with id-like segments normalised). */
export function sigOf(op: { method: string; url: string }): string {
  const path = op.url.split("?")[0]!;
  return `${op.method} ${path
    .split("/")
    .map((s) => (/^\d+$/.test(s) || /^[0-9a-f-]{16,}$/i.test(s) || /^[a-z]{2,4}_[a-z0-9]{6,}$/i.test(s) ? ":id" : s))
    .join("/")}`;
}
