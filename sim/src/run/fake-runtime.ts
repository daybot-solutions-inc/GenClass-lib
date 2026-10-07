// TEST DOUBLE ONLY. A tiny stand-in for @genclass/runtime that follows CONTRACT §3-§8 closely enough to exercise
// the sim's pipeline (decision points, forced actions, counterfactual replay) in unit tests before/without the
// real runtime. Its situations are crude text; rows generated with it are marked meta.runtime = "fake" and must
// never be used for training. The generator refuses to use it unless --allow-fake is passed.

import type { Answer, Clock, DecisionProvider, JevState, Question } from "../types.js";
import type { AtomLike, RuntimeLike, RuntimeOptions, SituationLike } from "./rt.js";

interface Op {
  id: number;
  kind: string;
  name: string;
  start: number;
  end?: number;
  status?: string;
  cause?: number;
  identity?: string;
}

const ACTIONS: Record<string, string[]> = {
  mutation: ["apply", "discard", "defer"],
  request: ["send", "coalesce", "delay", "block", "serve_cached"],
  failure: ["deliver", "retry", "serve_cached"],
  stall: ["wait", "hedge", "serve_cached"],
  error: ["ignore"],
};
const DESC: Record<string, string> = {
  apply: "let this write update the state now",
  discard: "drop this write and keep the current state",
  defer: "hold this write until the related in-flight operations finish, then decide again",
  send: "send the request now",
  coalesce: "do not send; reuse the result of the identical request that is in flight or just finished",
  delay: "wait before sending, backing off so the service can recover",
  block: "do not send; fail this request immediately",
  serve_cached: "answer with the last successful response for this request instead",
  deliver: "pass the failure to the application as it is",
  retry: "retry the request after a short backoff",
  wait: "keep waiting for the request",
  hedge: "send a second identical request and use whichever answers first",
  ignore: "leave the state as it is",
};
const DIAG: Record<string, string> = {
  expected: "normal behaviour, nothing is wrong",
  stale: "outdated data or an older operation is about to replace newer state",
  conflict: "concurrent operations are competing over the same state or resource",
  duplicate: "the same change or request is happening again without a new intent",
  inconsistent: "the state contradicts itself or relationships it normally keeps",
  failing: "an operation keeps failing or its failures follow a pattern",
  slow: "an operation is far slower than usual",
  overload: "work is being triggered far more often than usual",
  unusual: "this differs from how the same operation normally behaves",
  transient: "a one-off failure that is likely to succeed if tried again",
};

export function createFakeRuntime(o: RuntimeOptions): RuntimeLike {
  const clock: Clock = o.clock;
  const G = o.global as Record<string, unknown>;
  const decider: DecisionProvider = o.decider;
  const diagnoses = o.diagnoses ?? DIAG;
  const ops = new Map<number, Op>();
  let nextOp = 1;
  let nextMut = 1;
  let seq = 0;
  const events: { seq: number; t: number; kind: string; name: string; op?: number }[] = [];
  const listeners = new Set<(e: unknown) => void>();
  let ambient: Op | null = null;
  const lastWrite = new Map<string, { op?: number; t: number }>();
  const recentReq: { identity: string; t: number; op: number }[] = [];
  const inflightById = new Map<string, Promise<Response>>();
  const cache = new Map<string, Response>();
  const streak = new Map<string, number>();
  const lat = new Map<string, number[]>();
  const realFetch = G.fetch as (i: unknown, init?: RequestInit) => Promise<Response>;

  const emit = (kind: string, name: string, op?: number) => {
    const e: { seq: number; t: number; kind: string; name: string; op?: number } = { seq: ++seq, t: clock.now(), kind, name };
    if (op !== undefined) e.op = op;
    events.push(e);
    if (events.length > 300) events.shift();
    for (const fn of listeners) fn(e);
  };
  const startOp = (kind: string, name: string, identity?: string): Op => {
    const op: Op = { id: nextOp++, kind, name, start: clock.now() };
    if (ambient) op.cause = ambient.id;
    if (identity) op.identity = identity;
    ops.set(op.id, op);
    o.hooks?.opCreated?.({ id: op.id, kind, name, ...(op.cause !== undefined ? { cause: op.cause } : {}) });
    emit("op.start", name, op.id);
    return op;
  };
  const endOp = (op: Op, status: string) => {
    op.end = clock.now();
    op.status = status;
    emit("op.end", `${op.name} ${status}`, op.id);
  };
  const stick = (op: Op | null) => {
    ambient = op;
    clock.afterTask(() => {
      if (ambient === op) ambient = null;
    });
  };
  const sit = (trigger: string, subject: string, facts: string[]): { state: JevState; questions: Record<string, Question> } => {
    const inflight = [...ops.values()].filter((x) => x.end === undefined && x.kind === "fetch").map((x) => `${x.name} (${((clock.now() - x.start) / 1000).toFixed(2)}s)`);
    const timeline = events.slice(-12).map((e) => `${((e.t - clock.now()) / 1000).toFixed(2)}s ${e.kind} ${e.name}`);
    const loc = G.location as { pathname?: string } | undefined;
    const app = o.app();
    return {
      state: { app: `${app.title ?? ""} ${app.route ?? loc?.pathname ?? ""}`.trim(), trigger: subject, facts: facts.length ? facts : ["nothing unusual"], in_flight: inflight.length ? inflight : "none", timeline },
      questions: trigger === "ask" ? {} : {
        action: { type: "choice", instructions: `What should the runtime do with ${subject}?`, criteria: {} },
        diagnosis: { type: "choice", instructions: "What is happening?", criteria: { ...diagnoses } },
      },
    };
  };
  const decide = (trigger: string, subject: string, facts: string[], actions: string[], extra: Record<string, unknown>): Promise<string> => {
    const s = sit(trigger, subject, facts);
    const crit: Record<string, string> = {};
    for (const a of actions) crit[a] = DESC[a] ?? a;
    (s.questions.action as { criteria: Record<string, string> }).criteria = crit;
    emit("decision", `${trigger}: ${subject}`);
    return decider.evaluate({ trigger: trigger as never, state: s.state, questions: s.questions, subject: { kind: trigger, ...extra } }).then((ans: Record<string, Answer>) => {
      const a = ans.action;
      return a && a.type === "choice" ? a.choice : actions[0]!;
    });
  };

  // --------------------------------------------------------------------------------------------- fetch
  const wrapped = (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    const path = url.split("?")[0]!.replace(/\/[0-9a-f-]{6,}|\/\d+/gi, "/:id");
    const name = `${method} ${path}`;
    const identity = `${method} ${url} ${typeof init?.body === "string" ? init.body : ""}`;
    const op = startOp("fetch", name, identity);
    const now = clock.now();
    const identical = recentReq.filter((r) => r.identity === identity && now - r.t < 3000);
    const st = streak.get(name) ?? 0;
    recentReq.push({ identity, t: now, op: op.id });
    if (recentReq.length > 200) recentReq.shift();
    const facts: string[] = [];
    if (identical.length) facts.push(`${identical.length} identical request(s) in the last 3 s`);
    if (st > 0) facts.push(`${st} failure(s) in a row for ${name}`);
    const actions = ["send", "delay", "block"];
    if (identical.length && inflightById.has(identity)) actions.splice(1, 0, "coalesce");
    if (method === "GET" && cache.has(identity)) actions.push("serve_cached");
    const doSend = (): Promise<Response> => {
      const t0 = clock.now();
      const p = realFetch(input, init).then(
        async (res) => {
          inflightById.delete(identity);
          const arr = lat.get(name) ?? [];
          arr.push(clock.now() - t0);
          lat.set(name, arr);
          if (res.status >= 500 || res.status === 429 || res.status === 408) {
            streak.set(name, (streak.get(name) ?? 0) + 1);
            const fa = ["deliver", "retry"];
            if (method === "GET" && cache.has(identity)) fa.push("serve_cached");
            const a = await decide("failure", `${name} failed with ${res.status}`, [`status ${res.status}`, `${streak.get(name)} failure(s) in a row`], fa, { op: op.id });
            if (a === "retry") {
              await new Promise<void>((r) => clock.setTimeout(r, 200));
              return realFetch(input, init);
            }
            if (a === "serve_cached") return cache.get(identity)!.clone();
            endOp(op, "error");
            stick(op);
            return res;
          }
          streak.set(name, 0);
          if (method === "GET" && res.ok) cache.set(identity, res.clone());
          endOp(op, "ok");
          stick(op);
          return res;
        },
        async (err) => {
          inflightById.delete(identity);
          if ((err as { name?: string })?.name === "AbortError" || (err as { name?: string })?.name === "TimeoutError") {
            endOp(op, "aborted");
            throw err;
          }
          streak.set(name, (streak.get(name) ?? 0) + 1);
          const a = await decide("failure", `${name} failed: network error`, [`${streak.get(name)} failure(s) in a row`], ["deliver", "retry"], { op: op.id });
          if (a === "retry") {
            await new Promise<void>((r) => clock.setTimeout(r, 200));
            return realFetch(input, init);
          }
          endOp(op, "error");
          stick(op);
          throw err;
        },
      );
      const shared = p.then((r) => r.clone());
      shared.catch(() => undefined);
      inflightById.set(identity, shared);
      const samples = lat.get(name) ?? [];
      if (samples.length >= 3) {
        const med = samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
        clock.setTimeout(() => {
          if (op.end !== undefined) return;
          const sa = ["wait"];
          if (method === "GET") sa.push("hedge");
          void decide("stall", `${name} is slow`, [`in flight ${((clock.now() - t0) / 1000).toFixed(1)} s, usual ${(med / 1000).toFixed(2)} s`], sa, { op: op.id });
        }, Math.max(1000, med * 4));
      }
      return p;
    };
    if (facts.length === 0) return doSend();
    return decide("request", `${name}`, facts, actions, { op: op.id }).then(async (a) => {
      if (a === "coalesce" && inflightById.has(identity)) {
        const shared = await inflightById.get(identity)!;
        endOp(op, "ok");
        return shared.clone();
      }
      if (a === "block") {
        endOp(op, "blocked");
        return new Response(JSON.stringify({ error: "blocked" }), { status: 503, headers: { "x-genclass": "blocked" } });
      }
      if (a === "serve_cached" && cache.has(identity)) {
        endOp(op, "ok");
        return cache.get(identity)!.clone();
      }
      if (a === "delay") await new Promise<void>((r) => clock.setTimeout(r, Math.min(8000, 250 * 2 ** st)));
      return doSend();
    });
  };
  G.fetch = wrapped;

  // --------------------------------------------------------------------------------------------- stores
  const atom = <T,>(name: string, initial: T): AtomLike<T> => {
    let v = initial;
    const subs = new Set<(v: T) => void>();
    const applyNow = (next: T | ((p: T) => T), cause: Op | null) => {
      const nv = typeof next === "function" ? (next as (p: T) => T)(v) : next;
      if (Object.is(nv, v)) return;
      v = nv;
      const lw: { op?: number; t: number } = { t: clock.now() };
      if (cause) lw.op = cause.id;
      lastWrite.set(name, lw);
      emit("state", name, cause?.id);
      for (const fn of subs) fn(v);
    };
    return {
      name,
      get: () => v,
      subscribe: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      set: (next) => {
        const cause = ambient;
        const isUser = cause?.kind === "user";
        const lw = lastWrite.get(name);
        const causeOp = cause ? ops.get(cause.id) : undefined;
        const salient = !isUser && !!causeOp && !!lw && lw.op !== cause?.id && lw.t > causeOp.start && causeOp.kind === "fetch";
        if (!salient) return applyNow(next, cause);
        const mut = nextMut++;
        o.hooks?.mutationProposed?.({ id: mut, store: name, paths: [name], ...(cause ? { cause: cause.id } : {}) });
        void decide("mutation", `write to ${name} from ${causeOp!.name}`, [`${name} was written by another operation ${((clock.now() - lw!.t) / 1000).toFixed(2)} s ago, after this one started`], ACTIONS.mutation!, { mutation: mut, store: name, cause: cause?.id }).then((a) => {
          if (a === "discard") return;
          if (a === "defer") {
            clock.setTimeout(() => applyNow(next, cause), 300);
            return;
          }
          applyNow(next, cause);
        });
      },
    };
  };

  const rt: RuntimeLike = {
    atom: (name, initial) => atom(name, initial),
    user(action, handler) {
      const op = startOp("user", `${action.kind} ${action.target ?? ""}`.trim());
      emit("user", `${action.kind} ${action.target ?? ""} ${action.value ?? ""}`.trim(), op.id);
      const prev = ambient;
      ambient = op;
      try {
        return handler?.();
      } finally {
        ambient = prev;
        stick(op);
      }
    },
    reportError(error) {
      emit("error", String((error as Error)?.message ?? error));
      void decide("error", `uncaught ${(error as Error)?.name ?? "Error"}: ${(error as Error)?.message ?? ""}`, [], ACTIONS.error!, { error });
    },
    situation(trigger = "ask"): SituationLike {
      const s = sit(trigger, "developer question", []);
      return { trigger, subject: "now", state: s.state, questions: s.questions, actions: [] };
    },
    on(type, fn) {
      if (type !== "event") return () => undefined;
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      G.fetch = realFetch;
      listeners.clear();
    },
  };
  return rt;
}
