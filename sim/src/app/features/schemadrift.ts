// A server deploy mid-session changes the response schema of a list the app polls: the amount field is renamed,
// becomes a string ("12.00"), is dropped, or responses are occasionally cut off (truncated JSON the client cannot
// parse). A later deploy may roll it back. The app keeps total = sum of amounts and count = number of rows.
// Client variants: naive sum (renamed/dropped -> NaN, strings -> concatenated garbage: written with anomaly
// "shape"), naive formatting (amount.toFixed throws -> uncaught error), schema validation keeping the last good
// data (guard), tolerant coercion with alias mapping (guard). Unhandled parse errors escape as uncaught errors in
// the naive variants.

import { u01 } from "../../rng.js";
import type { Item, ServerResponse } from "../../net/server.js";
import { numIn, rel, type ExternalEvent, type FeatureDef, type Relation, type UserStep } from "../feature.js";
import { errorFor } from "../kit.js";
import { apiOf, seedItems, weightsOf } from "./common.js";

export interface SchemadriftSpec {
  id: string;
  api: string;
  store: string;
  f: { list: string; total: string; count: string; loading: string; error: string; stale: string };
  nameField: string;
  amount: string;
  renamedTo: string;
  items: Item[];
  path: string;
  drift: "rename" | "string" | "drop" | "truncate";
  truncP: number;
  client: "naive-sum" | "naive-format" | "validate" | "coerce";
  pollMs: number;
  rollback: boolean;
  refreshLabel: string;
  growth: number;
  range: [number, number];
}

const isAmount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const schemadrift: FeatureDef<SchemadriftSpec> = {
  kind: "schemadrift",
  make({ rng, entity, naming, id, api, clean }) {
    const num: [string, number, number, number] = entity.nums.find((n) => /price|amount|total|cost|fee|value|balance|gross|fare/.test(n[0])) ?? ["amount", 5, 900, 2];
    const amount = num[0];
    return {
      id,
      api: api.name,
      store: naming.store(entity.p, rng.pick(["summary", "report", "ledger", "overview"])),
      f: { list: naming.field("list", id), total: naming.field("sum", id), count: naming.field("total", id + "n"), loading: naming.field("loading", id), error: naming.field("error", id), stale: naming.word(rng.pick(["stale", "outdated", "degraded", "showingCached"])) },
      nameField: entity.name,
      amount,
      renamedTo: naming.word(rng.pick(["amountValue", "totalAmount", "value", "priceCents", "amt"]).replace(new RegExp(`^${amount}$`), "amt")),
      items: seedItems(rng, entity, rng.int(3, 8), (it) => {
        it[amount] = numIn(rng, num[1], num[2], 2);
      }),
      path: naming.route(entity.p, rng.pick(["", "summary", "recent"])),
      drift: rng.weighted([["rename", 3], ["string", 3], ["drop", 2], ["truncate", 2]] as const),
      truncP: rng.float(0.2, 0.6),
      client: clean ? rng.pick(["validate", "coerce"] as const) : rng.weighted([["naive-sum", 3], ["naive-format", 2], ["validate", 3], ["coerce", 2]] as const),
      pollMs: rng.int(2500, 8000),
      rollback: rng.bool(0.35),
      refreshLabel: `button "${rng.pick(["Refresh", "Reload", "Update"])}"`,
      growth: rng.int(0, 4),
      range: [num[1], num[2]],
    };
  },
  pattern(s) {
    return [`drift:${s.drift}`, `client:${s.client}`, s.rollback ? "deploy-rollback" : "deploy-stays"];
  },
  relations(s): Relation[] {
    const L = `${s.store}.${s.f.list}`;
    const T = `${s.store}.${s.f.total}`;
    const C = `${s.store}.${s.f.count}`;
    const rows = (st: Record<string, unknown>) => (rel.field(st, L) as Item[]) ?? [];
    return [
      { fields: [T, L], desc: "total equals the sum of amounts", check: (st) => rel.near(rel.field(st, T), rows(st).reduce((a, it) => a + Number(it[s.amount]), 0)) },
      { fields: [C, L], desc: "count equals the number of rows", check: (st) => Number(rel.field(st, C)) === rows(st).length },
    ];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:rows`;
    for (const it of s.items) db.insert(coll, it, `seed:${String(it[s.nameField])}`);
    db.kv.set(`${s.id}:schema`, 1);
    srv.route(
      "GET",
      s.path,
      (req) => {
        const rows = db.list(coll);
        if (db.kv.get(`${s.id}:schema`) !== 2) return { status: 200, body: api.list(rows, { schemaVersion: 1 }) };
        if (s.drift === "truncate") {
          const text = JSON.stringify(api.list(rows, { schemaVersion: 2 }));
          const x = u01(s.id, "cut", req.identity, req.t);
          if (x >= s.truncP) return { status: 200, body: api.list(rows, { schemaVersion: 2 }) };
          // A proxy cut the body off mid-stream: valid status and content-type, invalid JSON.
          const res: ServerResponse & { html: string } = { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, html: text.slice(0, Math.max(1, Math.floor(text.length * (0.3 + 0.6 * (x / s.truncP))))) };
          return res;
        }
        const out = rows.map((it): Item => {
          const { [s.amount]: v, ...rest } = it;
          if (s.drift === "rename") return { ...rest, [s.renamedTo]: v ?? null };
          if (s.drift === "string") return { ...rest, [s.amount]: Number(v).toFixed(2) };
          return rest;
        });
        return { status: 200, body: api.list(out, { schemaVersion: 2 }) };
      },
      { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.rows`;
    const S = env.store(s.store, s.id, { [F.list]: [] as Item[], [F.total]: 0, [F.count]: 0, [F.loading]: false, [F.error]: null, [F.stale]: false } as Record<string, unknown>, {
      weights: weightsOf([[F.list, 1], [F.total, 0.7], [F.count, 0.4], [F.loading, 0.1], [F.error, 0], [F.stale, 0.15]]),
      resync: () => refresh(undefined, true),
    });
    let inflight = 0;
    /** Tolerant reader (coerce variant): alias + numeric strings; null when the amount is unusable. */
    const coerce = (it: Item): Item | null => {
      const v = Number(it[s.amount] ?? it[s.renamedTo]);
      return Number.isFinite(v) ? { ...it, [s.amount]: v } : null;
    };
    async function refresh(intent: number | undefined, bg: boolean): Promise<void> {
      const withIntent = intent !== undefined ? { intent } : {};
      const op = kit.op({ role: bg ? "poll" : "refresh", method: "GET", url: s.path, key, background: bg, handled: s.client === "validate" || s.client === "coerce", ...withIntent });
      inflight++;
      if (!bg) kit.write(S, (p) => ({ ...p, [F.loading]: true }), { role: "loading", key, ...withIntent });
      const r = await kit.call(op, { timeoutMs: 8000 });
      inflight--;
      const busy = inflight > 0;
      const keepLastGood = (msg: string | null): void => {
        const cur = S.get();
        if (!msg && cur[F.stale] === true && cur[F.loading] === busy) return;
        kit.write(S, (p) => ({ ...p, [F.loading]: busy, [F.stale]: true, ...(msg ? { [F.error]: msg } : {}) }), { role: "error", op, key, ...withIntent });
        if (msg) kit.shownError();
      };
      if (!r.ok) {
        if (r.outcome === "aborted") return;
        if (r.outcome === "parse-error" && (s.client === "naive-sum" || s.client === "naive-format")) {
          // Defect: `await res.json()` with no try/catch around it.
          const err = errorFor(r, "load");
          env.know.tagError(err, { cause: "parse-error", feature: s.id, op: op.id, diagnosis: "unusual" });
          kit.write(S, (p) => ({ ...p, [F.loading]: busy }), { role: "loading", op, key });
          throw err;
        }
        keepLastGood(bg ? null : "Couldn't refresh, showing the last data");
        return;
      }
      const raw = kit.api.unlist(r.body).items;
      let rows: Item[] = raw;
      if (s.client === "coerce") {
        const ok = raw.map(coerce);
        if (ok.some((x) => x === null)) return keepLastGood(null);
        rows = ok as Item[];
      } else if (s.client === "validate") {
        if (!raw.every((it) => isAmount(it[s.amount]))) return keepLastGood(bg ? null : "Some data could not be loaded");
      } else if (s.client === "naive-format") {
        // Defect: formats amounts assuming numbers; throws on strings / missing fields.
        rows = raw.map((it) => ({ ...it, display: `${String(it[s.nameField])}: ${(it[s.amount] as unknown as number).toFixed(2)}` }));
      }
      // Naive sum: `+` concatenates strings and turns missing fields into NaN.
      const total = rows.reduce<unknown>((a, it) => (a as number) + (it[s.amount] as number), 0);
      const shape = !rows.every((it) => isAmount(it[s.amount]));
      kit.write(S, (p) => ({ ...p, [F.list]: rows, [F.total]: total, [F.count]: rows.length, [F.loading]: busy, [F.error]: null, [F.stale]: false }), { role: bg ? "poll-result" : "results", op, key, ...withIntent, ...(shape ? { anomaly: "shape" } : {}) });
    }
    return {
      init() {
        kit.spawn(() => refresh(undefined, true), "swallow");
        env.setInterval(() => kit.spawn(() => refresh(undefined, true), "uncaught", { cause: "schema-drift", diagnosis: "unusual" }), s.pollMs);
      },
      handle(step: UserStep, intent: number) {
        kit.spawn(() => refresh(intent, false), "uncaught", { cause: "schema-drift", diagnosis: "unusual" });
      },
      cond() {
        return inflight > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(1.2);
    while (t < win.t1 - 800) {
      steps.push(...user.click(t, s.refreshLabel, "refresh", { kind: "refresh", key: `${s.id}.refresh`, mode: "replace" }, { pendingCond: "loading" }).steps);
      t += user.think(2.2);
    }
    return steps;
  },
  external(s, rng, win) {
    const span = win.t1 - win.t0;
    const tDeploy = rng.float(win.t0 + span * 0.3, win.t0 + span * 0.75);
    const deploy = (v: number, t: number, desc: string): ExternalEvent => ({ t, feature: s.id, desc, apply: (w) => void w.db.kv.set(`${s.id}:schema`, v) });
    const out = [deploy(2, tDeploy, `deploy changes the ${s.amount} field (${s.drift})`)];
    if (s.rollback) out.push(deploy(1, tDeploy + rng.float(8000, 30000), "deploy rolled back"));
    // New rows keep arriving (the totals change legitimately too).
    for (let k = 0; k < s.growth; k++) {
      const name = `${s.items[k % s.items.length]![s.nameField]} ${k + 2}`;
      const v = numIn(rng, s.range[0], s.range[1], 2);
      out.push({ t: rng.float(win.t0, win.t1), feature: s.id, desc: "a new row is added", apply: (w) => void w.db.insert(`${s.id}:rows`, { [s.nameField]: name, [s.amount]: v }, `ext:${k}:${name}`, w.now()) });
    }
    return out;
  },
};
