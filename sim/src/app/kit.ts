// Building blocks for feature code: tagged requests (with app-level timeout/abort/retry knobs), tagged writes,
// user-visible error reporting. Features compose these with explicit control flow so that guards and defects are
// real code paths, not flags read by the oracle.

import type { ApiStyle } from "../net/server.js";
import { SIM_OP_HEADER, simOpHeaderValue } from "../net/network.js";
import type { SimOp } from "../oracle/knowledge.js";
import type { AppEnv, Store, WriteMeta } from "./env.js";

export interface CallResult {
  ok: boolean;
  status: number;
  body: unknown;
  /** "ok" | "http-error" | "neterr" | "aborted" | "timeout" | "parse-error" */
  outcome: NonNullable<SimOp["outcome"]>;
  error?: unknown;
  headers?: Headers;
}

export interface OpInit {
  role: string;
  method: string;
  url: string;
  body?: unknown;
  intent?: number;
  key?: string;
  idempotent?: boolean;
  background?: boolean;
  handled?: boolean;
  attempt?: number;
  retryOf?: number;
  dupOf?: number;
  /** Sim knowledge: this op's effect is anomalous ("storm", "partial", "shape", ...). */
  anomaly?: string;
  classify?: () => string | undefined;
}

export interface CallOpts {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** App-level timeout: abort after this many ms (0 = none). */
  timeoutMs?: number;
}

export class Kit {
  constructor(
    readonly env: AppEnv,
    readonly feature: string,
    readonly api: ApiStyle,
  ) {}

  op(p: OpInit): SimOp {
    const o: Omit<SimOp, "id" | "t0" | "attempt"> & { attempt?: number } = {
      feature: this.feature,
      role: p.role,
      method: p.method,
      url: p.url,
      idempotent: p.idempotent ?? (p.method === "GET" || p.method === "PUT" || p.method === "DELETE"),
      background: p.background ?? false,
    };
    if (p.body !== undefined) o.body = JSON.stringify(p.body);
    if (p.intent !== undefined) o.intent = p.intent;
    if (p.key !== undefined) o.key = p.key;
    if (p.handled !== undefined) o.handled = p.handled;
    if (p.attempt !== undefined) o.attempt = p.attempt;
    if (p.retryOf !== undefined) o.retryOf = p.retryOf;
    if (p.dupOf !== undefined) o.dupOf = p.dupOf;
    if (p.anomaly !== undefined) o.anomaly = p.anomaly;
    if (p.classify) o.classify = p.classify;
    return this.env.know.beginOp(o);
  }

  /** Perform the op's request. Never throws: the caller decides how failures surface. */
  call(op: SimOp, opts: CallOpts = {}): Promise<CallResult> {
    const env = this.env;
    // Ideal world = exactly-once: an app-generated duplicate shares the original request's result.
    if (env.ideal && op.dupOf !== undefined) {
      const orig = env.results.get(op.dupOf);
      if (orig) {
        return orig.then((r) => {
          env.know.endOp(op, r.outcome, r.status);
          return r;
        });
      }
    }
    const p = this.callNet(op, opts);
    env.results.set(op.id, p);
    return p;
  }

  private async callNet(op: SimOp, opts: CallOpts): Promise<CallResult> {
    const env = this.env;
    const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}), [SIM_OP_HEADER]: simOpHeaderValue(op.id) };
    if (op.body !== undefined) headers["content-type"] = "application/json";
    let ctl: AbortController | null = null;
    let timer: unknown = null;
    let timedOut = false;
    let signal = opts.signal;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      ctl = new AbortController();
      const outer = opts.signal;
      if (outer) {
        if (outer.aborted) ctl.abort(outer.reason);
        else outer.addEventListener("abort", () => ctl!.abort(outer.reason), { once: true });
      }
      timer = env.setTimeout(() => {
        timedOut = true;
        ctl!.abort(new DOMException("signal timed out", "TimeoutError"));
      }, opts.timeoutMs);
      signal = ctl.signal;
    }
    const init: RequestInit = { method: op.method, headers };
    if (op.body !== undefined) init.body = op.body;
    if (signal) init.signal = signal;
    let res: Response;
    try {
      res = await env.fetch(op.url, init, op);
    } catch (e) {
      if (timer) env.clearTimeout(timer);
      const name = (e as { name?: string })?.name;
      const outcome = timedOut ? "timeout" : name === "AbortError" || name === "TimeoutError" ? "aborted" : "neterr";
      env.know.endOp(op, outcome);
      return { ok: false, status: 0, body: undefined, outcome, error: e };
    }
    if (timer) env.clearTimeout(timer);
    let body: unknown = undefined;
    const ct = res.headers.get("content-type") ?? "";
    try {
      const text = await res.text();
      body = text && ct.includes("json") ? JSON.parse(text) : text || undefined;
    } catch (e) {
      env.know.endOp(op, "parse-error", res.status);
      return { ok: false, status: res.status, body: undefined, outcome: "parse-error", error: e, headers: res.headers };
    }
    if (typeof body === "string" && res.ok) {
      // HTML or garbage where JSON was expected: the app's JSON parse would throw.
      const err = new SyntaxError(`Unexpected token '<', "${body.slice(0, 12)}"... is not valid JSON`);
      env.know.endOp(op, "parse-error", res.status);
      return { ok: false, status: res.status, body: undefined, outcome: "parse-error", error: err, headers: res.headers };
    }
    const outcome = res.ok ? "ok" : "http-error";
    env.know.endOp(op, outcome, res.status);
    return { ok: res.ok, status: res.status, body, outcome, headers: res.headers };
  }

  write<T>(store: Store<T>, next: T | ((prev: T) => T), meta: Omit<WriteMeta, "feature">): void {
    store.set(next, { ...meta, feature: this.feature });
  }

  /** Count a user-visible error episode (the app shows an error message). */
  shownError(): void {
    this.env.know.shownErrors++;
    this.env.know.shownErrorTimes.push(this.env.now());
  }

  /** Run an async handler; errors escaping it become uncaught errors (defect) or are swallowed (guard). */
  spawn(fn: () => Promise<void>, onEscape: "uncaught" | "swallow" = "uncaught", tag?: { cause: string; diagnosis: string; op?: SimOp }): void {
    fn().catch((e) => {
      if (onEscape === "swallow") return;
      const t = tag ?? { cause: "unhandled", diagnosis: "failing" };
      const errTag: { cause: string; feature: string; diagnosis: string; op?: number } = { cause: t.cause, feature: this.feature, diagnosis: t.diagnosis };
      if (t.op) errTag.op = t.op.id;
      if (!this.env.know.errors.has(e as object)) this.env.know.tagError(e, errTag);
      this.env.uncaught(e, "unhandledrejection");
    });
  }
}

/** Error thrown by app code when a request failed and the app does not handle it. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorFor(r: CallResult, what: string): Error {
  if (r.error instanceof Error) return r.error;
  if (r.status) return new HttpError(r.status, `${what} failed with ${r.status}`);
  return new TypeError("Failed to fetch");
}

export function sleepJitter(env: AppEnv, ms: number): Promise<void> {
  return env.sleep(ms);
}
