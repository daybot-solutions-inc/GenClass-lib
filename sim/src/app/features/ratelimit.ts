// Strictly rate-limited lookup API (live quotes, availability, geocoding, enrichment). The server allows `limit`
// calls per sliding `windowMs` of arrival times (one client) and answers 429 with Retry-After and X-RateLimit-*
// headers beyond it. The user checks single items, goes through several in a row, or refreshes all of them
// (fan-out); an optional auto-refresh shares the same quota. Intended use mostly fits the quota: double clicks,
// impatient re-clicks, retries and network-level throttling push it over. Knobs: what the client does on 429/5xx
// (honor Retry-After, exponential backoff with jitter, immediate retry loop = storm defect, no retry + error
// banner), parallel vs sequential fan-out, auto-refresh, whether the server counts rejected calls in the window.

import type { Item } from "../../net/server.js";
import type { SimOp } from "../../oracle/knowledge.js";
import type { ExternalEvent, FeatureDef, UserStep } from "../feature.js";
import { numIn } from "../feature.js";
import type { CallResult } from "../kit.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface RatelimitSpec {
  id: string;
  api: string;
  store: string;
  f: { values: string; loading: string; error: string; wait: string };
  nameField: string;
  valueField: string;
  range: [number, number, number];
  items: Item[];
  listPath: string;
  path: string;
  limit: number;
  windowMs: number;
  countRejected: boolean;
  onLimit: "honor" | "backoff" | "storm" | "none";
  fanout: "parallel" | "sequential";
  autoMs: number;
  timeoutMs: number;
  checkLabel: string;
  allLabel: string;
  drift: number;
}

export const ratelimit: FeatureDef<RatelimitSpec> = {
  kind: "ratelimit",
  make({ rng, entity, naming, id, api, clean }) {
    const num: [string, number, number, number] = entity.nums[0] ?? ["value", 1, 500, 2];
    const windowMs = rng.pick([3000, 5000, 10000]);
    const n = rng.int(2, 5);
    // Strict but sized for intended use (~1.2-2.2 calls/s, never below one full fan-out plus two checks).
    const limit = Math.max(n + 2, Math.round((windowMs / 1000) * rng.float(1.2, 2.2)));
    const items = seedItems(rng, entity, n, (it) => {
      if (!(num[0] in it)) it[num[0]] = numIn(rng, num[1], num[2], num[3]);
    });
    return {
      id,
      api: api.name,
      store: naming.store(entity.s, rng.pick(["quotes", "lookup", "rates", "live", "status"])),
      f: { values: naming.field("value", id), loading: naming.field("loading", id), error: naming.field("error", id), wait: naming.word(rng.pick(["retrying", "cooldown", "throttled", "waiting"])) },
      nameField: entity.name,
      valueField: num[0],
      range: [num[1], num[2], num[3]],
      items,
      listPath: naming.route(entity.p),
      path: naming.route(rng.pick(["quotes", "lookup", "rates", "availability", "enrich"]), ":id"),
      limit,
      windowMs,
      countRejected: rng.bool(0.4),
      onLimit: clean ? rng.weighted([["honor", 3], ["backoff", 2]] as const) : rng.weighted([["honor", 3], ["backoff", 3], ["storm", 2], ["none", 2]] as const),
      fanout: rng.weighted([["parallel", 3], ["sequential", 2]] as const),
      autoMs: rng.weighted([[0, 3], [rng.int(6000, 20000), 2]] as const),
      timeoutMs: rng.weighted([[0, 2], [rng.int(3000, 8000), 2]] as const),
      checkLabel: `button "${rng.pick(["Check", "Refresh", "Get quote", "Look up"])}"`,
      allLabel: `button "${rng.pick(["Refresh all", "Update all", "Check all", "Sync"])}"`,
      drift: rng.int(1, 6),
    };
  },
  pattern(s) {
    return [`on429:${s.onLimit}`, `fanout:${s.fanout}`, s.autoMs ? "auto" : "noauto", s.countRejected ? "strict-window" : "lenient-window"];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:items`;
    for (const it of s.items) db.insert(coll, it, `seed:${String(it[s.nameField])}`);
    srv.route("GET", s.listPath, () => ({ status: 200, body: api.list(db.list(coll)) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
    // Sliding window over arrival times (per run: the closure is rebuilt with the server).
    const hits: number[] = [];
    srv.route(
      "GET",
      s.path,
      (req) => {
        while (hits.length && hits[0]! <= req.t - s.windowMs) hits.shift();
        const lim = { "x-ratelimit-limit": String(s.limit), "x-ratelimit-window": `${s.windowMs / 1000}s` };
        if (hits.length >= s.limit) {
          if (s.countRejected) hits.push(req.t);
          const wait = Math.max(1, Math.ceil((hits[0]! + s.windowMs - req.t) / 1000));
          return { status: 429, body: api.error("rate_limited", `limit is ${s.limit} requests per ${s.windowMs / 1000}s`), headers: { ...lim, "x-ratelimit-remaining": "0", "retry-after": String(wait) } };
        }
        hits.push(req.t);
        const it = db.get(coll, String(req.params.id));
        if (!it) return { status: 404, body: api.error("not_found", "unknown item") };
        return { status: 200, body: api.one({ id: it.id ?? null, [s.nameField]: it[s.nameField] ?? null, [s.valueField]: it[s.valueField] ?? null }), headers: { ...lim, "x-ratelimit-remaining": String(s.limit - hits.length) } };
      },
      { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const S = env.store(s.store, s.id, { [F.values]: {}, [F.loading]: false, [F.error]: null, [F.wait]: false } as Record<string, unknown>, {
      weights: weightsOf([[F.values, 1], [F.loading, 0.1], [F.error, 0], [F.wait, 0.15]]),
      resync: () => refreshAll(undefined, true),
    });
    const ids: string[] = [];
    const names: string[] = [];
    const applied = new Map<number, number>();
    const calls = new Map<number, number>();
    let busy = 0;
    const key = (i: number) => `${s.id}.item.${i}`;
    const withIntent = (intent: number | undefined) => (intent !== undefined ? { intent } : {});
    /** Delay before the next attempt, or -1 to give up (the client's 429/5xx policy). */
    function delayFor(i: number, attempt: number, r: CallResult): number {
      const j = env.rng.fork("rl-jitter", s.id, i, calls.get(i) ?? 0, attempt);
      if (s.onLimit === "none") return -1;
      if (s.onLimit === "storm") return attempt < 25 ? j.float(15, 80) : -1;
      if (s.onLimit === "honor") {
        if (attempt >= 4) return -1;
        const ra = Number(r.headers?.get("retry-after"));
        return (r.status === 429 && ra > 0 ? ra * 1000 : 1000 * attempt) + j.float(0, 300);
      }
      return attempt < 5 ? Math.min(16000, 500 * 2 ** attempt) * j.float(0.5, 1.5) : -1;
    }
    function apply(i: number, r: CallResult, op: SimOp, intent: number | undefined): void {
      const v = kit.api.unone(r.body)[s.valueField] ?? null;
      const newest = applied.get(i) ?? -1;
      applied.set(i, Math.max(newest, op.t0));
      const name = names[i]!;
      // A lookup that started before the one already shown (a slow retry) overwrites newer data.
      const classify = () => (op.t0 < newest && (S.get()[F.values] as Record<string, unknown>)[name] !== v ? "stale" : undefined);
      kit.write(S, (p) => ({ ...p, [F.values]: { ...(p[F.values] as Record<string, unknown>), [name]: v }, [F.error]: null, [F.wait]: false }), { role: "results", op, key: key(i), classify, ...withIntent(intent) });
    }
    async function lookup(i: number, intent: number | undefined, bg: boolean, dupOf?: number): Promise<void> {
      const id = ids[i];
      if (id === undefined) return;
      calls.set(i, (calls.get(i) ?? 0) + 1);
      busy++;
      kit.write(S, (p) => ({ ...p, [F.loading]: true }), { role: "loading", key: key(i), ...withIntent(intent) });
      let retryOf: number | undefined;
      let fail: { r: CallResult; op: SimOp } | null = null;
      for (let attempt = 1; ; attempt++) {
        const op = kit.op({
          role: attempt > 1 ? "retry" : "lookup",
          method: "GET",
          url: s.path.replace(":id", encodeURIComponent(id)),
          key: key(i),
          background: bg,
          attempt,
          handled: s.onLimit !== "none",
          ...withIntent(intent),
          ...(retryOf !== undefined ? { retryOf } : {}),
          ...(dupOf !== undefined && attempt === 1 ? { dupOf } : {}),
        });
        if (s.onLimit === "storm" && attempt > 1) op.anomaly = "storm";
        const r = await kit.call(op, s.timeoutMs ? { timeoutMs: s.timeoutMs } : {});
        if (r.ok) {
          apply(i, r, op, intent);
          break;
        }
        if (r.outcome === "aborted") break;
        const retriable = r.status === 429 || r.status >= 500 || r.outcome === "timeout" || r.outcome === "neterr";
        const d = retriable ? delayFor(i, attempt, r) : -1;
        if (d < 0) {
          fail = { r, op };
          break;
        }
        if (r.status === 429 && s.onLimit !== "storm") kit.write(S, (p) => ({ ...p, [F.wait]: true }), { role: "wait", op, key: key(i) });
        retryOf = op.id;
        await env.sleep(d);
      }
      busy--;
      const patch: Record<string, unknown> = { [F.loading]: busy > 0 };
      if (fail) {
        patch[F.error] = errMsg(fail.r.status, fail.r.outcome);
        patch[F.wait] = false;
        kit.shownError();
      }
      kit.write(S, (p) => ({ ...p, ...patch }), { role: fail ? "error" : "loading", key: key(i), ...(fail ? { op: fail.op } : {}) });
    }
    async function refreshAll(intent: number | undefined, bg: boolean): Promise<void> {
      if (s.fanout === "parallel") await Promise.all(ids.map((_, i) => lookup(i, intent, bg)));
      else for (let i = 0; i < ids.length; i++) await lookup(i, intent, bg);
    }
    return {
      init() {
        kit.spawn(async () => {
          for (let attempt = 1; attempt <= 3 && ids.length === 0; attempt++) {
            const op = kit.op({ role: "load", method: "GET", url: s.listPath, key: `${s.id}.list`, background: true, attempt, handled: true });
            const r = await kit.call(op, { timeoutMs: 8000 });
            if (r.ok) {
              for (const it of kit.api.unlist(r.body).items) {
                ids.push(String(it.id));
                names.push(String(it[s.nameField]));
              }
            } else await env.sleep(1000 * attempt);
          }
          await refreshAll(undefined, true);
        }, "swallow");
        if (s.autoMs) {
          env.setInterval(() => {
            if (busy === 0) kit.spawn(() => refreshAll(undefined, true), "swallow");
          }, s.autoMs);
        }
      },
      handle(step: UserStep, intent: number) {
        const it = env.know.getIntent(intent);
        const tag = { cause: "lookup-failed", diagnosis: "failing" };
        if (step.action === "all") kit.spawn(() => refreshAll(intent, false), "uncaught", tag);
        else kit.spawn(() => lookup(Number(step.args?.item ?? 0), intent, false, it?.accidental ? it.repeatOf ?? -1 : undefined), "uncaught", tag);
      },
      cond() {
        return busy > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    const n = s.items.length;
    const check = (t: number, i: number, doubleP?: number) =>
      user.click(t, `${s.checkLabel.slice(0, -1)} ${String(s.items[i]![s.nameField])}"`, "check", { kind: "check", key: `${s.id}.check.${i}`, mode: "replace" }, { args: { item: i }, pendingCond: "busy", ...(doubleP !== undefined ? { doubleP } : {}) }).steps;
    let t = win.t0 + user.think(1.2);
    while (t < win.t1 - 1000) {
      const r = user.rng.next();
      if (r < 0.25) steps.push(...user.click(t, s.allLabel, "all", { kind: "refresh", key: `${s.id}.all`, mode: "replace" }, { pendingCond: "busy" }).steps);
      else if (r < 0.45) {
        // Go through several items in a row (an intended burst; may exceed the quota on its own).
        const k = user.rng.int(2, n);
        const start = user.rng.int(0, n - 1);
        for (let j = 0; j < k; j++) {
          steps.push(...check(t, (start + j) % n, 0));
          t += user.rng.float(200, 900);
        }
      } else steps.push(...check(t, user.rng.int(0, n - 1)));
      t += user.think(1.6);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    for (let k = 0; k < s.drift; k++) {
      const i = rng.int(0, s.items.length - 1);
      const v = numIn(rng, s.range[0], s.range[1], s.range[2]);
      out.push({
        t: rng.float(win.t0, win.t1),
        feature: s.id,
        desc: `${String(s.items[i]![s.nameField])} ${s.valueField} changes`,
        apply(w) {
          const id = w.db.collection(`${s.id}:items`).order[i];
          if (id) w.db.update(`${s.id}:items`, id, { [s.valueField]: v }, w.now());
        },
      });
    }
    return out;
  },
};
