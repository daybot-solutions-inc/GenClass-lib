// Faceted search: a query box, two facet filters and a sort; the server returns the matching items with the total
// and per-facet counts, and any change refetches. Knobs: response guard (none: the response for an older facet
// combination lands last and is applied; request id; abort), update shape (atomic list + total + counts; split: list
// and counts from two endpoints written as each arrives; partial: counts refreshed on facet changes but not on
// query changes), URL sync (from the inputs, or from the applied response: drifts with stale responses), debounce.

import type { ApiStyle, Item } from "../../net/server.js";
import type { Rng } from "../../rng.js";
import { rel, type ExternalEvent, type FeatureDef, type UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, queryWords, seedItems, weightsOf } from "./common.js";

interface Dim { name: string; values: string[]; from: string; lo: number; hi: number }

export interface FacetsSpec {
  id: string;
  api: string;
  store: string;
  f: { q: string; filters: string; sort: string; items: string; total: string; facets: string; url: string; loading: string; error: string };
  coll: string;
  nameField: string;
  dims: Dim[];
  sortFields: string[];
  items: Item[];
  paths: { search: string; facets: string };
  guard: "none" | "reqid" | "abort";
  update: "atomic" | "split" | "partial";
  urlFrom: "state" | "response";
  debounceMs: number;
  labels: { q: string; sort: string; clear: string };
  queries: string[];
  externalAdds: number;
}

function knob<T>(rng: Rng, clean: boolean | undefined, good: T, opts: readonly (readonly [T, number])[]): T {
  const v = rng.weighted(opts);
  return clean ? good : v;
}

const valueOf = (it: Item, d: Dim): string => {
  if (d.from === "status") return String(it.status);
  if (d.from === "flag") return it[d.name] === true ? "yes" : "no";
  const v = Number(it[d.from] ?? 0);
  const third = (d.hi - d.lo) / 3;
  return v < d.lo + third ? "low" : v < d.lo + 2 * third ? "mid" : "high";
};
const pack = (api: ApiStyle, items: Item[], extra: Record<string, unknown>) => (api.name === "bare" ? { hits: items, ...extra } : api.list(items, extra));
const unpack = (api: ApiStyle, body: unknown) => {
  if (api.name !== "bare") return api.unlist(body);
  const { hits, ...extra } = (body ?? {}) as Record<string, unknown>;
  return { items: (Array.isArray(hits) ? hits : []) as Item[], extra };
};

export const facets: FeatureDef<FacetsSpec> = {
  kind: "facets",
  make({ rng, clean, entity, naming, id, api }) {
    const statuses = entity.status.length >= 2 ? entity.status : ["open", "closed"];
    const dims: Dim[] = [{ name: "status", values: statuses, from: "status", lo: 0, hi: 0 }];
    const num = entity.nums[0];
    if (num) dims.push({ name: naming.word(`${num[0]} range`), values: ["low", "mid", "high"], from: num[0], lo: num[1], hi: num[2] });
    else if (entity.flags.length) dims.push({ name: entity.flags[0]!, values: ["yes", "no"], from: "flag", lo: 0, hi: 0 });
    return {
      id,
      api: api.name,
      store: naming.store(entity.p, rng.pick(["browse", "explorer", "catalog", "finder"])),
      f: { q: naming.field("query", id), filters: naming.field("filter", id), sort: naming.field("sort", id), items: naming.field("list", id), total: naming.field("total", id), facets: rng.pick(["facets", "facetCounts", "aggregations", "buckets"]), url: rng.pick(["url", "search", "queryString", "permalink"]), loading: naming.field("loading", id), error: naming.field("error", id) },
      coll: entity.p,
      nameField: entity.name,
      dims,
      sortFields: [entity.name, ...entity.nums.map((n) => n[0])].slice(0, 3),
      items: seedItems(rng, entity, rng.int(12, 40), (it) => { it.status = rng.pick(statuses); }),
      paths: { search: naming.route(entity.p, rng.pick(["search", "browse", "query"])), facets: naming.route(entity.p, rng.pick(["facets", "aggregations", "counts"])) },
      guard: knob(rng, clean, "reqid", [["none", 4], ["reqid", 3], ["abort", 2]] as const),
      update: knob(rng, clean, "atomic", [["atomic", 4], ["split", 2], ["partial", 2]] as const),
      urlFrom: knob(rng, clean, "state", [["state", 1], ["response", 1]] as const),
      debounceMs: rng.weighted([[0, 2], [rng.int(150, 400), 3]] as const),
      labels: { q: `input "${rng.pick(["Search", "Filter"])} ${entity.p}"`, sort: `select "${rng.pick(["Sort by", "Order"])}"`, clear: `button "${rng.pick(["Clear filters", "Reset", "Clear all"])}"` },
      queries: queryWords(rng, entity),
      externalAdds: rng.int(0, 3),
    };
  },
  pattern(s) {
    return [`guard:${s.guard}`, `update:${s.update}`, `url:${s.urlFrom}`, s.debounceMs ? "debounce" : "nodebounce"];
  },
  relations(s) {
    const T = `${s.store}.${s.f.total}`;
    const I = `${s.store}.${s.f.items}`;
    const Fc = `${s.store}.${s.f.facets}`;
    const d0 = s.dims[0]!.name;
    return [
      { fields: [T, I], desc: "total equals number of items (unpaginated)", check: (st) => Number(rel.field(st, T)) === ((rel.field(st, I) as unknown[]) ?? []).length },
      { fields: [Fc, T], desc: `${d0} facet counts add up to total`, check: (st) => Object.values(((rel.field(st, Fc) as Record<string, Record<string, number>>) ?? {})[d0] ?? {}).reduce((a, n) => a + Number(n), 0) === Number(rel.field(st, T)) },
    ];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:${s.coll}`;
    for (const it of s.items) db.insert(coll, it, `seed:${JSON.stringify(it)}`);
    const rows = (q: URLSearchParams) => {
      const text = (q.get("q") ?? "").toLowerCase();
      const sort = q.get("sort") ?? s.sortFields[0]!;
      return db
        .list(coll)
        .filter((it) => (!text || String(it[s.nameField] ?? "").toLowerCase().includes(text)) && s.dims.every((d) => !q.get(d.name) || q.get(d.name) === "all" || valueOf(it, d) === q.get(d.name)))
        .sort((a, b) => (String(a[sort]) < String(b[sort]) ? -1 : String(a[sort]) > String(b[sort]) ? 1 : 0));
    };
    const counts = (list: Item[]) => Object.fromEntries(s.dims.map((d) => [d.name, Object.fromEntries(d.values.map((v) => [v, list.filter((it) => valueOf(it, d) === v).length]))]));
    const meta = { feature: s.id, kind: "read" as const, idempotent: true, resource: `c:${coll}` };
    srv.route("GET", s.paths.search, (req) => {
      const list = rows(req.query);
      return { status: 200, body: pack(api, list.slice(0, 60), { total: list.length, ...(s.update === "split" ? {} : { facets: counts(list) }) }) };
    }, meta);
    srv.route("GET", s.paths.facets, (req) => ({ status: 200, body: api.one({ facets: counts(rows(req.query)) }) }), meta);
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.query`;
    const filters0 = () => Object.fromEntries(s.dims.map((d) => [d.name, "all"]));
    const qs = (v: Record<string, unknown>) => {
      const f = v[F.filters] as Record<string, string>;
      const parts = [v[F.q] ? `q=${encodeURIComponent(String(v[F.q]))}` : "", ...s.dims.map((d) => (f[d.name] && f[d.name] !== "all" ? `${d.name}=${encodeURIComponent(f[d.name]!)}` : "")), `sort=${String(v[F.sort])}`];
      return "?" + parts.filter(Boolean).join("&");
    };
    const init: Record<string, unknown> = { [F.q]: "", [F.filters]: filters0(), [F.sort]: s.sortFields[0], [F.items]: [] as Item[], [F.total]: 0, [F.facets]: {}, [F.url]: "", [F.loading]: false, [F.error]: null };
    init[F.url] = qs(init);
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.q, 0.4], [F.filters, 0.4], [F.sort, 0.3], [F.items, 1], [F.total, 0.5], [F.facets, 0.5], [F.url, 0.2], [F.loading, 0.1], [F.error, 0]]),
      resync: () => run(env.know.latestIntent(key)?.id, "resync", true),
    });
    let latest = 0;
    let ctl: AbortController | null = null;
    let timer: unknown = null;
    function input(patch: Record<string, unknown>, intent: number): void {
      kit.write(S, (p) => {
        const o = { ...p, ...patch };
        return s.urlFrom === "state" ? { ...o, [F.url]: qs(o) } : o;
      }, { role: "input", intent, key });
    }
    function run(intent: number | undefined, why: string, bg = false): void {
      const params = qs(S.get());
      const my = ++latest;
      if (s.guard === "abort" && ctl) ctl.abort();
      const myCtl = s.guard === "abort" ? new AbortController() : null;
      ctl = myCtl;
      kit.write(S, (p) => ({ ...p, [F.loading]: true }), { role: "loading", key, ...(intent !== undefined ? { intent } : {}) });
      const fetchOne = (path: string, role: string, apply: (body: unknown, verdict: string | undefined, op: ReturnType<typeof kit.op>) => void) => {
        const op = kit.op({ role, method: "GET", url: `${path}${params}`, key, background: bg, ...(intent !== undefined ? { intent } : {}) });
        kit.spawn(async () => {
          const r = await kit.call(op, { timeoutMs: 9000, ...(myCtl ? { signal: myCtl.signal } : {}) });
          if (r.outcome === "aborted" || (s.guard === "reqid" && my !== latest)) return;
          if (!r.ok) {
            kit.write(S, (p) => ({ ...p, [F.loading]: false, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, key });
            kit.shownError();
            return;
          }
          // Results for the inputs shown now are current even if their intent was superseded (A -> B -> A).
          apply(r.body, qs(S.get()) !== params ? "stale" : intent !== undefined && env.know.superseded(intent) ? "expected" : undefined, op);
        }, "uncaught", { cause: "facets-failed", diagnosis: "failing", op });
      };
      const skipCounts = s.update === "partial" && why === "query";
      fetchOne(s.paths.search, "results", (body, verdict, op) => {
        const { items, extra } = unpack(kit.api, body);
        const patch: Record<string, unknown> = { [F.items]: items, [F.total]: typeof extra.total === "number" ? extra.total : items.length, [F.loading]: false, [F.error]: null };
        if (s.update !== "split" && !skipCounts) patch[F.facets] = extra.facets ?? {};
        if (s.urlFrom === "response") patch[F.url] = params;
        kit.write(S, (p) => ({ ...p, ...patch }), { role: "results", op, key, classify: () => verdict, ...(intent !== undefined ? { intent } : {}), ...(skipCounts ? { anomaly: "partial" } : {}) });
      });
      if (s.update === "split") {
        fetchOne(s.paths.facets, "facet-counts", (body, verdict, op) => {
          const counts = (kit.api.unone(body) as Record<string, unknown>).facets ?? {};
          kit.write(S, (p) => ({ ...p, [F.facets]: counts }), { role: "data", op, key, classify: () => verdict, ...(intent !== undefined ? { intent } : {}) });
        });
      }
    }
    return {
      init() {
        run(undefined, "initial", true);
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "type") {
          input({ [F.q]: String(step.ui.value ?? "") }, intent);
          if (timer) env.clearTimeout(timer);
          timer = null;
          if (!s.debounceMs) return run(intent, "query");
          timer = env.setTimeout(() => {
            timer = null;
            run(intent, "query");
          }, s.debounceMs);
          return;
        }
        if (step.action === "facet") input({ [F.filters]: { ...(S.get()[F.filters] as object), [String(step.args?.dim)]: String(step.ui.value) } }, intent);
        else if (step.action === "sort") input({ [F.sort]: String(step.ui.value) }, intent);
        else input({ [F.filters]: filters0(), [F.q]: "" }, intent);
        run(intent, step.action);
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    const st = (t: number, action: string, target: string, value: string, args?: Record<string, unknown>): UserStep => ({ t, feature: s.id, action, ui: { kind: "change", target, value }, ...(args ? { args } : {}), intent: { kind: action, key: `${s.id}.query`, mode: "replace", accidental: false } });
    let t = win.t0 + user.think(0.8);
    let q = "";
    let qi = 0;
    while (t < win.t1 - 800) {
      const r = user.rng.next();
      if (r < 0.25) {
        const word = s.queries[qi++ % s.queries.length]!;
        if (q && user.rng.bool(0.6)) {
          while (q.length) {
            t += user.key() * 0.6;
            q = q.slice(0, -1);
            steps.push({ ...st(t, "type", s.labels.q, q), ui: { kind: "type", target: s.labels.q, value: q } });
          }
        }
        const typed = user.type(t, q, (q ? " " : "") + word.slice(0, user.rng.int(2, word.length)), s.labels.q, "type", `${s.id}.query`);
        steps.push(...typed.steps);
        q = typed.steps.length ? String(typed.steps[typed.steps.length - 1]!.ui.value) : q;
        t = typed.t;
      } else if (r < 0.75) {
        // Click through a few facet values quickly (checkbox / chip after chip).
        for (let i = 0, n = user.rng.weighted([[1, 3], [2, 3], [3, 2]] as const); i < n; i++) {
          const d = user.rng.pick(s.dims);
          steps.push(st(t, "facet", `checkbox "${title(d.name)}"`, user.rng.pick(["all", ...d.values]), { dim: d.name }));
          t += user.rng.float(180, 800);
        }
      } else if (r < 0.9) steps.push(st(t, "sort", s.labels.sort, user.rng.pick(s.sortFields)));
      else {
        steps.push({ ...st(t, "clear", s.labels.clear, ""), ui: { kind: "click", target: s.labels.clear } });
        q = "";
      }
      t += user.think(1.1);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    for (let i = 0; i < s.externalAdds; i++) {
      const it: Item = { ...s.items[rng.int(0, s.items.length - 1)]!, status: rng.pick(s.dims[0]!.values) };
      out.push({ t: rng.float(win.t0 + 1000, win.t1), feature: s.id, desc: `another user adds a ${s.coll} entry`, apply(w) {
        w.db.insert(`${s.id}:${s.coll}`, { ...it }, `ext:${i}:${JSON.stringify(it)}`, w.now());
      } });
    }
    return out;
  },
};
