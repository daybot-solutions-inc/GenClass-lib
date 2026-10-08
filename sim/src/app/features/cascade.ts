// Dependent selects (country → region → city, category → subcategory → item, ...): every change of a parent fetches
// the child options. Knobs: request ids / abort / parent check on responses (guards) vs none (defect: options of an
// old parent land after the parent changed, out of order); clearing children on a parent change and validating the
// selected child against fresh options (guards) vs keeping a child that is no longer valid (defect: relation
// "selected child ∈ options of the selected parent" breaks); error display.

import { rel, type FeatureDef, type Relation, type UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, weightsOf } from "./common.js";

interface Opt {
  id: string;
  name: string;
  children?: Opt[];
}

export interface CascadeSpec {
  id: string;
  api: string;
  store: string;
  levels: { name: string; sel: string; opts: string; param: string; path: string; label: string }[];
  tree: Opt[];
  f: { loading: string; error: string };
  guard: "none" | "reqid" | "abort" | "check";
  clear: boolean;
  validate: boolean;
  onError: "show" | "silent";
}

const SETS: { names: string[]; pools: string[][] }[] = [
  { names: ["country", "region", "city"], pools: [["Canada", "Germany", "Japan", "Brazil", "Kenya", "India", "Spain", "Chile"], ["North", "South", "East", "West", "Central", "Coastal", "Highlands"], ["Port Alder", "Lakeview", "Millbrook", "Fairhaven", "Stonebridge", "Riverton", "Westfield", "Ashford", "Kingsley"]] },
  { names: ["make", "model", "trim"], pools: [["Aurora", "Vantage", "Kestrel", "Nomad", "Pioneer"], ["S1", "GT", "X5", "Tour", "Sport", "City"], ["base", "plus", "premium", "limited", "eco"]] },
  { names: ["department", "team", "member"], pools: [["Sales", "Support", "Platform", "Finance", "Design"], ["alpha", "core", "growth", "infra", "ops", "web"], ["ana", "ben", "chen", "dara", "eli", "farah", "gus", "hana"]] },
  { names: ["warehouse", "zone", "bin"], pools: [["Dock A", "Dock B", "North DC", "South DC"], ["cold", "bulk", "picking", "returns", "overflow"], ["B-01", "B-02", "B-07", "C-11", "C-14", "D-03", "D-09"]] },
];

const plural = (w: string) => (/[^aeiou]y$/.test(w) ? w.slice(0, -1) + "ies" : /(s|x|ch|sh)$/.test(w) ? w + "es" : w + "s");

const optsOf = (tree: Opt[], path: string[]): Opt[] => {
  let cur: Opt[] = tree;
  for (const id of path) cur = cur.find((o) => o.id === id)?.children ?? [];
  return cur;
};

export const cascade: FeatureDef<CascadeSpec> = {
  kind: "cascade",
  make({ rng, domain, entity, naming, id, api, clean }) {
    const set = rng.bool(0.3)
      ? { names: ["category", "subcategory", entity.s], pools: [domain.entities.flatMap((e) => e.status.concat(e.p)).slice(0, 8), ["basic", "pro", "plus", "mini", "max", "lite"], domain.entities.flatMap((e) => e.words)] }
      : rng.pick(SETS);
    const depth = rng.bool(0.6) ? 3 : 2;
    let n = 10;
    const build = (lv: number): Opt[] => {
      const pool = set.pools[lv]!.length ? set.pools[lv]! : ["one", "two", "three"];
      return rng.sample(pool, rng.int(2, Math.min(5, pool.length))).map((name) => {
        const o: Opt = { id: String(1000 * (lv + 1) + n++), name };
        if (lv + 1 < depth) o.children = build(lv + 1);
        return o;
      });
    };
    const tree = build(0);
    const levels = set.names.slice(0, depth).map((nm, i) => ({
      name: nm,
      sel: naming.word(nm),
      opts: naming.word(`${nm} options`),
      param: naming.word(`${nm} id`),
      path: naming.route(i === 0 ? plural(nm) : plural(set.names[i - 1]!), i === 0 ? "" : rng.pick([plural(nm), "children", "options"])),
      label: `select "${title(nm)}"`,
    }));
    const guard = rng.weighted([["none", 4], ["reqid", 2], ["abort", 2], ["check", 2]] as const);
    const clear = rng.bool(0.5);
    const validate = rng.bool(0.4);
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["address", "picker", "location", "selection", "filters"]), rng.pick(["", "form"])),
      levels,
      tree,
      f: { loading: naming.field("loading", id), error: naming.field("error", id) },
      guard: clean && guard === "none" ? "reqid" : guard,
      clear: clean || clear,
      validate: clean || validate,
      onError: rng.weighted([["show", 3], ["silent", 1]] as const),
    };
  },
  pattern(s) {
    return [`guard:${s.guard}`, s.clear ? "clear" : "noclear", s.validate ? "validate" : "novalidate", `depth:${s.levels.length}`];
  },
  relations(s) {
    const out: Relation[] = [];
    for (let i = 1; i < s.levels.length; i++) {
      const sel = `${s.store}.${s.levels[i]!.sel}`;
      const opts = `${s.store}.${s.levels[i]!.opts}`;
      const parent = `${s.store}.${s.levels[i - 1]!.sel}`;
      out.push({
        fields: [sel, opts, parent],
        desc: `${s.levels[i]!.name} options belong to the selected ${s.levels[i - 1]!.name} and contain the selected ${s.levels[i]!.name}`,
        check: (st) => {
          const o = (rel.field(st, opts) as { id: string; parentId?: string }[]) ?? [];
          const p = rel.field(st, parent);
          const v = rel.field(st, sel);
          if (o.some((x) => x.parentId !== undefined && String(x.parentId) !== String(p))) return false;
          return v === null || v === undefined || o.some((x) => String(x.id) === String(v));
        },
      });
    }
    return out;
  },
  server(s, srv) {
    const api = apiOf(s.api);
    s.levels.forEach((lv, i) => {
      if (i === 0) {
        srv.route("GET", lv.path, () => ({ status: 200, body: api.list(s.tree.map((o) => ({ id: o.id, name: o.name }))) }), { feature: s.id, kind: "read", idempotent: true });
        return;
      }
      const pp = s.levels[i - 1]!.param;
      srv.route(
        "GET",
        lv.path,
        (req) => {
          const pid = req.query.get(pp) ?? "";
          // Find the parent anywhere at level i-1.
          let parents: Opt[] = s.tree;
          for (let k = 0; k < i - 1; k++) parents = parents.flatMap((o) => o.children ?? []);
          const parent = parents.find((o) => o.id === pid);
          if (!parent) return { status: 404, body: api.error("not_found", `unknown ${s.levels[i - 1]!.name}`) };
          return { status: 200, body: api.list((parent.children ?? []).map((o) => ({ id: o.id, name: o.name, parentId: pid }))) };
        },
        { feature: s.id, kind: "read", idempotent: true },
      );
    });
  },
  client(s, env, kit) {
    const F = s.f;
    const L = s.levels;
    const init: Record<string, unknown> = { [F.loading]: false, [F.error]: null };
    const w: [string, number][] = [[F.loading, 0.1], [F.error, 0]];
    for (const lv of L) {
      init[lv.sel] = null;
      init[lv.opts] = [];
      w.push([lv.sel, 0.4], [lv.opts, 1]);
    }
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf(w),
      resync: async () => {
        for (let i = 1; i < L.length; i++) {
          const p = S.get()[L[i - 1]!.sel];
          if (p !== null && p !== undefined) await load(i, String(p), env.know.latestIntent(`${s.id}.${L[i - 1]!.name}`)?.id, true);
        }
      },
    });
    const seq = L.map(() => 0);
    const ctl: (AbortController | null)[] = L.map(() => null);
    let pending = 0;
    const clearFrom = (lv: number) => (p: Record<string, unknown>) => {
      const o = { ...p };
      for (let k = lv; k < L.length; k++) {
        o[L[k]!.sel] = null;
        o[L[k]!.opts] = [];
      }
      return o;
    };
    async function load(lv: number, parentId: string, intent: number | undefined, bg: boolean): Promise<void> {
      const my = ++seq[lv]!;
      if (s.guard === "abort") ctl[lv]?.abort();
      const myCtl = s.guard === "abort" ? new AbortController() : null;
      ctl[lv] = myCtl;
      pending++;
      kit.write(S, (p) => ({ ...p, [F.loading]: true }), { role: "loading", intent, key: `${s.id}.opts${lv}` });
      const url = lv === 0 ? L[0]!.path : `${L[lv]!.path}?${L[lv - 1]!.param}=${encodeURIComponent(parentId)}`;
      const op = kit.op({ role: `options:${L[lv]!.name}`, method: "GET", url, intent, key: `${s.id}.opts${lv}`, background: bg, handled: s.onError === "show" });
      const r = await kit.call(op, myCtl ? { signal: myCtl.signal, timeoutMs: 10000 } : { timeoutMs: 10000 });
      pending--;
      if (r.outcome === "aborted") return;
      if (s.guard === "reqid" && my !== seq[lv]) return;
      if (s.guard === "check" && lv > 0 && String(S.get()[L[lv - 1]!.sel]) !== parentId) return;
      if (!r.ok) {
        kit.write(S, (p) => ({ ...p, [F.loading]: pending > 0, ...(s.onError === "show" ? { [F.error]: errMsg(r.status, r.outcome) } : {}) }), { role: "error", op, intent });
        if (s.onError === "show") kit.shownError();
        return;
      }
      const opts = kit.api.unlist(r.body).items;
      const classify = () => (lv > 0 && String(S.get()[L[lv - 1]!.sel]) !== parentId ? "stale" : undefined);
      kit.write(
        S,
        (p) => {
          let o: Record<string, unknown> = { ...p, [L[lv]!.opts]: opts, [F.loading]: pending > 0, [F.error]: null };
          const cur = p[L[lv]!.sel];
          // Guard: a selection that is not among the fresh options is reset (with everything below it).
          if (s.validate && cur !== null && cur !== undefined && !opts.some((x) => String(x.id) === String(cur))) o = { ...clearFrom(lv + 1)(o), [L[lv]!.sel]: null };
          return o;
        },
        { role: "results", op, intent, key: `${s.id}.opts${lv}`, classify },
      );
    }
    return {
      init() {
        kit.spawn(() => load(0, "", undefined, true), "swallow");
      },
      handle(step: UserStep, intent: number) {
        const lv = Number(step.args?.level ?? 0);
        const v = String(step.args?.id ?? "");
        kit.write(S, (p) => ({ ...(s.clear ? clearFrom(lv + 1)(p) : p), [L[lv]!.sel]: v }), { role: "input", intent, key: `${s.id}.${L[lv]!.name}` });
        if (lv + 1 < L.length) kit.spawn(() => load(lv + 1, v, intent, false), "uncaught", { cause: "options-failed", diagnosis: "failing" });
      },
      cond() {
        return pending > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.8);
    const pick = (path: string[]): Opt | undefined => {
      const o = optsOf(s.tree, path);
      return o.length ? user.rng.pick(o) : undefined;
    };
    const choose = (lv: number, o: Opt) =>
      steps.push({ t, feature: s.id, action: "select", ui: { kind: "change", target: s.levels[lv]!.label, value: o.name }, args: { level: lv, id: o.id }, intent: { kind: "select", key: `${s.id}.${s.levels[lv]!.name}`, mode: "replace", accidental: false } });
    let cur: string[] = [];
    while (t < win.t1 - 1500) {
      // Pick top to bottom; sometimes revise a lower level only, change the top level right away (changed mind),
      // or stop midway.
      const start = cur.length >= 2 && user.rng.bool(0.35) ? user.rng.int(1, cur.length - 1) : 0;
      const path = cur.slice(0, start);
      for (let lv = start; lv < s.levels.length; lv++) {
        const o = pick(path);
        if (!o) break;
        choose(lv, o);
        let chosen = o;
        if (lv === 0 && user.rng.bool(0.25)) {
          t += user.rng.float(150, 700);
          const o2 = pick(path);
          if (o2) {
            choose(lv, o2);
            chosen = o2;
          }
        }
        path.push(chosen.id);
        if (lv < s.levels.length - 1 && user.rng.bool(0.1)) break;
        t += user.think(0.9);
      }
      cur = path;
      t += user.think(2.5);
    }
    return steps;
  },
};
