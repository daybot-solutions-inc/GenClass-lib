// Polling dashboard. The server's metrics change over time (external events). Knobs: setInterval (polls can
// overlap) vs setTimeout chain, skip-if-in-flight guard, failure handling (exponential backoff / immediate tight
// retry = storm defect / ignore), app timeout, manual refresh button, time-range switch (stale responses for
// the old range), sequence guard on responses.

import type { FeatureDef, UserStep } from "../feature.js";
import { errorFor } from "../kit.js";
import { title } from "../naming.js";
import { apiOf, weightsOf } from "./common.js";

export interface PollSpec {
  id: string;
  api: string;
  store: string;
  f: { metrics: string; status: string; error: string; range: string; loading: string };
  metrics: string[];
  path: string;
  rangeParam: string;
  ranges: string[];
  intervalMs: number;
  mode: "interval" | "chain";
  skipIfInflight: boolean;
  onFail: "backoff" | "tight" | "ignore" | "throw";
  timeoutMs: number;
  seqGuard: boolean;
  refreshLabel: string;
  rangeLabel: string;
  changes: number;
  startValues: Record<string, number>;
}

export const poll: FeatureDef<PollSpec> = {
  kind: "poll",
  make({ rng, domain, naming, id, api }) {
    const metrics = rng.sample(domain.metrics, rng.int(2, Math.min(4, domain.metrics.length))).map((m) => naming.word(m));
    const startValues: Record<string, number> = {};
    for (const m of metrics) startValues[m] = rng.int(1, 900);
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["dashboard", "status", "monitor", "overview", "live"]), rng.pick(["", "stats", "panel"])),
      f: { metrics: naming.field("metrics", id), status: naming.field("status", id), error: naming.field("error", id), range: rng.pick(["range", "window", "period", "span"]), loading: naming.field("loading", id) },
      metrics,
      path: naming.route(rng.pick(["metrics", "stats", "status", "health", "summary"])),
      rangeParam: rng.pick(["range", "window", "period", "since"]),
      ranges: rng.pick([["1h", "24h", "7d"], ["15m", "1h", "6h"], ["today", "week", "month"]]),
      intervalMs: rng.pick([1000, 1500, 2000, 3000, 5000]),
      mode: rng.weighted([["interval", 3], ["chain", 3]] as const),
      skipIfInflight: rng.bool(0.5),
      onFail: rng.weighted([["backoff", 3], ["tight", 2], ["ignore", 3], ["throw", 1]] as const),
      timeoutMs: rng.weighted([[0, 3], [rng.int(1500, 6000), 2]] as const),
      seqGuard: rng.bool(0.35),
      refreshLabel: `button "${rng.pick(["Refresh", "Reload", "Update now", "↻"])}"`,
      rangeLabel: `select "${title(rng.pick(["range", "time window", "period"]))}"`,
      changes: rng.int(2, 8),
      startValues,
    };
  },
  pattern(s) {
    return [`mode:${s.mode}`, s.skipIfInflight ? "skip-inflight" : "overlap", `fail:${s.onFail}`, s.seqGuard ? "seq" : "noseq", s.timeoutMs ? "timeout" : "notimeout"];
  },
  server(s, srv, db) {
    const name = `${s.id}:metrics`;
    db.doc(name, s.startValues);
    const api = apiOf(s.api);
    srv.route(
      "GET",
      s.path,
      (req) => {
        const r = req.query.get(s.rangeParam) ?? s.ranges[0]!;
        const d = db.doc(name);
        const mul = s.ranges.indexOf(r) + 1;
        const out: Record<string, number> = {};
        for (const m of s.metrics) out[m] = Number(d.fields[m] ?? 0) * Math.max(1, mul);
        return { status: 200, body: api.one({ [s.rangeParam]: r, values: out, version: d.version }) };
      },
      { feature: s.id, kind: "read", idempotent: true, resource: `d:${name}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const init: Record<string, unknown> = { [F.metrics]: {} as Record<string, number>, [F.status]: "idle", [F.error]: null, [F.range]: s.ranges[0], [F.loading]: false };
    let inflight = 0;
    let seq = 0;
    let applied = 0;
    let fails = 0;
    let timer: unknown = null;
    let stopped = false;
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.metrics, 1], [F.status, 0.3], [F.error, 0], [F.range, 0.4], [F.loading, 0.1]]),
      resync: () => fetchOnce(true, "resync"),
    });
    const key = `${s.id}.range`;
    async function fetchOnce(bg: boolean, why: string, intent?: number): Promise<void> {
      if (s.skipIfInflight && inflight > 0 && why === "poll") return;
      const range = String(S.get()[F.range]);
      const my = ++seq;
      inflight++;
      const curIntent = intent ?? env.know.latestIntent(key)?.id;
      const op = kit.op({
        role: why,
        method: "GET",
        url: `${s.path}?${s.rangeParam}=${encodeURIComponent(range)}`,
        key,
        background: bg,
        handled: s.onFail !== "throw",
        ...(curIntent !== undefined ? { intent: curIntent } : {}),
        ...(why === "poll" && inflight > 1 ? { dupOf: -1 } : {}),
        ...(why === "retry" && s.onFail === "tight" ? { anomaly: "storm" } : {}),
      });
      if (why === "poll" && inflight > 1) {
        // Overlapping identical poll: the previous one is still in flight.
        const prev = [...env.know.ops].reverse().find((o) => o.feature === s.id && o.id !== op.id && o.tEnd === undefined && o.url === op.url);
        if (prev) op.dupOf = prev.id;
        else delete op.dupOf;
      }
      const opts: { timeoutMs?: number } = {};
      if (s.timeoutMs) opts.timeoutMs = s.timeoutMs;
      const r = await kit.call(op, opts);
      inflight--;
      if (r.ok) {
        fails = 0;
        if (s.seqGuard && my < applied) return;
        applied = Math.max(applied, my);
        const body = kit.api.unone(r.body) as Record<string, unknown>;
        const values = (body.values ?? {}) as Record<string, number>;
        const respRange = String(body[s.rangeParam] ?? range);
        const classify = () => {
          if (respRange !== String(S.get()[F.range])) return "stale";
          const newer = env.know.ops.some((o) => o.feature === s.id && o.id > op.id && o.outcome === "ok" && o.tEnd !== undefined && o.tEnd < env.now() && o.url === op.url);
          return newer ? "stale" : undefined;
        };
        kit.write(S, (p) => ({ ...p, [F.metrics]: values, [F.status]: "ok", [F.error]: null, [F.loading]: inflight > 0 }), { role: "poll-result", op, key, classify });
        return;
      }
      if (r.outcome === "aborted") return;
      fails++;
      kit.write(S, (p) => ({ ...p, [F.status]: "error", [F.error]: `${fails} failed`, [F.loading]: inflight > 0 }), { role: "poll-error", op, key });
      if (s.onFail === "throw" && fails >= 2) throw errorFor(r, "poll");
      if (s.onFail === "tight" && fails < 30) {
        await env.sleep(50);
        return fetchOnce(true, "retry");
      }
    }
    function schedule(): void {
      if (stopped) return;
      const delay = s.onFail === "backoff" && fails > 0 ? Math.min(30000, s.intervalMs * 2 ** fails) : s.intervalMs;
      timer = env.setTimeout(() => {
        kit.spawn(async () => {
          await fetchOnce(true, "poll");
          schedule();
        }, "uncaught", { cause: "poll-failed", diagnosis: "failing" });
      }, delay);
    }
    return {
      init() {
        kit.write(S, (p) => ({ ...p, [F.loading]: true }), { role: "loading", key });
        kit.spawn(() => fetchOnce(true, "initial"), "swallow");
        if (s.mode === "interval") {
          env.setInterval(() => {
            if (s.onFail === "backoff" && fails > 0 && env.rng.fork("skip", seq).bool(0.5)) return;
            kit.spawn(() => fetchOnce(true, "poll"), "uncaught", { cause: "poll-failed", diagnosis: "failing" });
          }, s.intervalMs);
        } else schedule();
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "range") {
          kit.write(S, (p) => ({ ...p, [F.range]: String(step.ui.value) }), { role: "input", intent, key });
          kit.spawn(() => fetchOnce(false, "range", intent), "uncaught", { cause: "poll-failed", diagnosis: "failing" });
        } else {
          kit.spawn(() => fetchOnce(false, "refresh", intent), "uncaught", { cause: "poll-failed", diagnosis: "failing" });
        }
        void timer;
      },
      cond() {
        return inflight > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(1.5);
    let range = s.ranges[0]!;
    while (t < win.t1 - 800) {
      if (user.rng.bool(0.45)) {
        const c = user.click(t, s.refreshLabel, "refresh", { kind: "refresh", key: `${s.id}.refresh`, mode: "replace" }, { pendingCond: "inflight" });
        steps.push(...c.steps);
      } else {
        const opts = s.ranges.filter((r) => r !== range);
        range = user.rng.pick(opts);
        steps.push({ t, feature: s.id, action: "range", ui: { kind: "change", target: s.rangeLabel, value: range }, intent: { kind: "range", key: `${s.id}.range`, mode: "replace", accidental: false } });
      }
      t += user.think(2);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: import("../feature.js").ExternalEvent[] = [];
    for (let i = 0; i < s.changes; i++) {
      const t = rng.float(win.t0, win.t1);
      const m = rng.pick(s.metrics);
      const delta = rng.int(-50, 120);
      out.push({
        t,
        feature: s.id,
        desc: `metric ${m} changes`,
        apply(w) {
          const name = `${s.id}:metrics`;
          const d = w.db.doc(name);
          w.db.writeDoc(name, { [m]: Math.max(0, Number(d.fields[m] ?? 0) + delta) }, w.now());
        },
      });
    }
    return out;
  },
};
