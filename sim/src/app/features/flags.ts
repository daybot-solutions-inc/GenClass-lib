// Feature flags polled from GET /flags. Mid-session a rollout flips one flag (server-side) and the app switches its
// data path to the v2 endpoint, which adds a field to every row (a benign behaviour change). Some deployments of
// v2 are broken: 500 on every call, or a renamed value field (genuine anomaly: v2 ops carry anomaly "shape"). The
// rollout may be reverted later. Knobs: flags polled vs fetched once and cached forever (never switches), on v2
// failure fall back to v1 (guard) or show an error, validate the v2 rows before use (guard) or derive the total
// from whatever arrives (total silently 0). The client keeps total = sum of the value field.

import type { Item } from "../../net/server.js";
import { numIn, rel, type ExternalEvent, type FeatureDef, type UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface FlagsSpec {
  id: string;
  api: string;
  flagStore: string;
  dataStore: string;
  f: { flags: string; list: string; total: string; loading: string; error: string };
  flag: string;
  others: string[];
  nameField: string;
  valueField: string;
  newField: string;
  renamedTo: string;
  items: Item[];
  flagsPath: string;
  v1Path: string;
  v2Path: string;
  sortParam: string;
  sorts: string[];
  v2: "ok" | "500" | "renamed";
  cache: "poll" | "forever";
  pollMs: number;
  fallback: boolean;
  validate: boolean;
  revert: boolean;
  refreshLabel: string;
  sortLabel: string;
}

export const flags: FeatureDef<FlagsSpec> = {
  kind: "flags",
  make({ rng, entity, naming, id, api, clean }) {
    const num: [string, number, number, number] = entity.nums[0] ?? ["value", 1, 500, 2];
    const flag = naming.word(rng.pick(["newPricing", "v2Api", "fastList", "betaTable", "newRanking", "smartSort"]));
    const v2 = rng.weighted([["ok", 5], ["500", 2], ["renamed", 3]] as const);
    return {
      id,
      api: api.name,
      flagStore: naming.store(rng.pick(["flags", "features", "rollout", "toggles"])),
      dataStore: naming.store(entity.p, rng.pick(["table", "view", "report"])),
      f: { flags: naming.word(rng.pick(["flags", "features", "enabled"])), list: naming.field("list", id), total: naming.field("sum", id), loading: naming.field("loading", id), error: naming.field("error", id) },
      flag,
      others: rng.sample(["darkMode", "newNav", "csvExport", "chatWidget", "betaBanner"], 2).map((x) => naming.word(x)),
      nameField: entity.name,
      valueField: num[0],
      newField: naming.word(rng.pick(["rating", "trend", "badge", "score", "rank"])),
      renamedTo: naming.word(rng.pick(["amount", "val", "valueCents", "figure"])),
      items: seedItems(rng, entity, rng.int(3, 9), (it) => {
        if (!(num[0] in it)) it[num[0]] = numIn(rng, num[1], num[2], num[3]);
      }),
      flagsPath: naming.route(rng.pick(["flags", "features", "config/flags"]).replace("/", "-")),
      v1Path: naming.route(entity.p),
      v2Path: naming.route(entity.p, rng.pick(["v2", "beta", "next"])),
      sortParam: rng.pick(["sort", "order", "orderBy"]),
      sorts: ["name", "value", "recent"],
      v2,
      cache: rng.weighted([["poll", 4], ["forever", 1]] as const),
      pollMs: rng.int(4000, 15000),
      fallback: clean ? true : rng.bool(0.5),
      validate: clean ? true : rng.bool(0.45),
      revert: v2 !== "ok" ? rng.bool(0.5) : rng.bool(0.1),
      refreshLabel: `button "${rng.pick(["Refresh", "Reload", "↻"])}"`,
      sortLabel: `select "${rng.pick(["Sort by", "Order", "Sort"])}"`,
    };
  },
  pattern(s) {
    return [`v2:${s.v2}`, `flags:${s.cache}`, s.fallback ? "fallback" : "nofallback", s.validate ? "validate" : "novalidate"];
  },
  relations(s) {
    const T = `${s.dataStore}.${s.f.total}`;
    const L = `${s.dataStore}.${s.f.list}`;
    return [{ fields: [T, L], desc: "total equals the sum of the listed values", check: (st) => rel.near(rel.field(st, T), ((rel.field(st, L) as Item[]) ?? []).reduce((a, it) => a + Number(it[s.valueField]), 0)) }];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:items`;
    for (const it of s.items) db.insert(coll, it, `seed:${String(it[s.nameField])}`);
    db.kv.set(`${s.id}:flag`, false);
    const sorted = (q: URLSearchParams) => {
      const by = q.get(s.sortParam) ?? "name";
      const all = db.list(coll);
      if (by === "value") return all.slice().sort((a, b) => Number(b[s.valueField]) - Number(a[s.valueField]));
      if (by === "recent") return all.slice().reverse();
      return all.slice().sort((a, b) => String(a[s.nameField]).localeCompare(String(b[s.nameField])));
    };
    srv.route("GET", s.flagsPath, () => ({ status: 200, body: api.one({ [s.flag]: db.kv.get(`${s.id}:flag`) === true, [s.others[0]!]: true, [s.others[1]!]: false }) }), { feature: s.id, kind: "read", idempotent: true });
    srv.route("GET", s.v1Path, (req) => ({ status: 200, body: api.list(sorted(req.query)) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
    srv.route(
      "GET",
      s.v2Path,
      (req) => {
        if (s.v2 === "500") return { status: 500, body: api.error("internal", "TypeError: Cannot read properties of undefined (reading 'map')") };
        const rows = sorted(req.query).map((it, i): Item => {
          const extra = { [s.newField]: (String(it[s.nameField]).length + i) % 5 };
          if (s.v2 === "ok") return { ...it, ...extra };
          const { [s.valueField]: v, ...rest } = it;
          return { ...rest, ...extra, [s.renamedTo]: v ?? null };
        });
        return { status: 200, body: api.list(rows, { schema: 2 }) };
      },
      { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const FS = env.store(s.flagStore, s.id, { [F.flags]: {} } as Record<string, unknown>, { weights: weightsOf([[F.flags, 0.2]]) });
    const D = env.store(s.dataStore, s.id, { [F.list]: [] as Item[], [F.total]: 0, [F.loading]: false, [F.error]: null } as Record<string, unknown>, {
      weights: weightsOf([[F.list, 1], [F.total, 0.6], [F.loading, 0.1], [F.error, 0]]),
      resync: () => loadData(undefined, true),
    });
    const key = `${s.id}.data`;
    let sort = s.sorts[0]!;
    let ready = false;
    const on = () => (FS.get()[F.flags] as Record<string, boolean>)[s.flag] === true;
    async function loadData(intent: number | undefined, bg: boolean, forceV1 = false): Promise<void> {
      const v2 = on() && !forceV1;
      const withIntent = intent !== undefined ? { intent } : {};
      const op = kit.op({ role: v2 ? "load-v2" : "load", method: "GET", url: `${v2 ? s.v2Path : s.v1Path}?${s.sortParam}=${sort}`, key, background: bg, handled: s.fallback, ...withIntent });
      if (v2 && s.v2 !== "ok") op.anomaly = "shape"; // misdeployed endpoint (sim knowledge)
      kit.write(D, (p) => ({ ...p, [F.loading]: true }), { role: "loading", key, ...withIntent });
      const r = await kit.call(op, { timeoutMs: 8000 });
      const items = r.ok ? kit.api.unlist(r.body).items : [];
      const valid = r.ok && items.every((it) => typeof it[s.valueField] === "number");
      if (r.outcome === "aborted") return;
      if (!r.ok || (s.validate && !valid)) {
        if (v2 && s.fallback) return loadData(intent, bg, true); // guard: the old path still works
        kit.write(D, (p) => ({ ...p, [F.loading]: false, [F.error]: r.ok ? "Unexpected response from server" : errMsg(r.status, r.outcome) }), { role: "error", op, key, ...withIntent });
        kit.shownError();
        return;
      }
      // `|| 0` hides a missing field: with the renamed v2 field the total silently drops to 0.
      const total = items.reduce((a, it) => a + (Number(it[s.valueField]) || 0), 0);
      kit.write(D, (p) => ({ ...p, [F.list]: items, [F.total]: total, [F.loading]: false, [F.error]: null }), { role: v2 ? "data" : "load", op, key, ...withIntent });
    }
    async function loadFlags(): Promise<void> {
      const op = kit.op({ role: "flags", method: "GET", url: s.flagsPath, key: `${s.id}.flags`, background: true, handled: true });
      const r = await kit.call(op, { timeoutMs: 5000 });
      if (!r.ok) return;
      const fl = kit.api.unone(r.body);
      const was = on();
      kit.write(FS, (p) => ({ ...p, [F.flags]: { ...fl } }), { role: "load", op, key: `${s.id}.flags` });
      // Re-render with the new code path when the flag changed.
      if (ready && was !== on()) await loadData(undefined, true);
    }
    return {
      init() {
        kit.spawn(async () => {
          await loadFlags();
          ready = true;
          await loadData(undefined, true);
        }, "swallow");
        if (s.cache === "poll") env.setInterval(() => kit.spawn(loadFlags, "swallow"), s.pollMs);
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "sort") sort = String(step.ui.value);
        kit.spawn(() => loadData(intent, false), "uncaught", { cause: "load-failed", diagnosis: "failing" });
      },
      cond() {
        return D.get()[F.loading] === true;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(1);
    let sort = s.sorts[0]!;
    while (t < win.t1 - 800) {
      if (user.rng.bool(0.6)) steps.push(...user.click(t, s.refreshLabel, "refresh", { kind: "refresh", key: `${s.id}.refresh`, mode: "replace" }, { pendingCond: "loading" }).steps);
      else {
        sort = user.rng.pick(s.sorts.filter((x) => x !== sort));
        steps.push({ t, feature: s.id, action: "sort", ui: { kind: "change", target: s.sortLabel, value: sort }, intent: { kind: "sort", key: `${s.id}.sort`, mode: "replace", accidental: false } });
      }
      t += user.think(2);
    }
    return steps;
  },
  external(s, rng, win) {
    const tOn = rng.float(win.t0 + (win.t1 - win.t0) * 0.25, win.t0 + (win.t1 - win.t0) * 0.7);
    const set = (v: boolean, t: number, desc: string): ExternalEvent => ({ t, feature: s.id, desc, apply: (w) => void w.db.kv.set(`${s.id}:flag`, v) });
    const out = [set(true, tOn, `rollout enables ${title(s.flag)}`)];
    if (s.revert) out.push(set(false, tOn + rng.float(10000, 40000), `rollout of ${title(s.flag)} reverted`));
    return out;
  },
};
