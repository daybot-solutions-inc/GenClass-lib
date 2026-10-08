// React-Query/SWR-style cache in front of a filtered list. Queries are keyed by filter; a cached entry is served at
// once on mount and revalidated in the background when older than staleTime (also on window focus / visibility and
// on an optional refetch interval). Failed queries retry 3× like the libraries do. Mutations (create, toggle) update
// the cache optimistically or wait, then invalidate the list keys. Knobs: dedupe of identical in-flight queries
// (else every observer — the list and a header badge — and both focus listeners fire their own GET), retry backoff
// (exponential / fixed / none), invalidation on settle vs right at mutate time (that refetch can reach the server
// before the mutation commits and overwrite with pre-mutation data), cancel in-flight queries before an optimistic
// update (else a revalidation started earlier lands on top of it), item total kept on the optimistic path or not.

import type { Item } from "../../net/server.js";
import { rel, type ExternalEvent, type FeatureDef, type Relation, type UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface QueryCacheSpec {
  id: string;
  api: string;
  store: string;
  f: { list: string; filter: string; total: string; fetching: string; error: string; draft: string };
  path: string;
  itemPath: string;
  nameField: string;
  flag: string;
  items: Item[];
  words: string[];
  staleMs: number;
  dedupe: boolean;
  observers: number;
  retry: "backoff" | "fixed" | "none";
  invalidate: "settled" | "mutate";
  optimistic: boolean;
  cancelOnMutate: boolean;
  intervalMs: number;
  focus: boolean;
  totalOnAllPaths: boolean;
  externalEdits: number;
  labels: { input: string; tabs: Record<string, string> };
}

type Obj = Record<string, unknown>;
const FILTERS = ["all", "yes", "no"] as const;
interface Entry {
  data: Item[] | null;
  at: number;
  inflight: Promise<void> | null;
  ctl: AbortController | null;
  opId?: number;
}
interface Mutation {
  kind: "create" | "toggle";
  name?: string;
  id?: string;
  value?: boolean;
  state: "pending" | "ok" | "failed";
  tEnd?: number;
}

export const querycache: FeatureDef<QueryCacheSpec> = {
  kind: "querycache",
  make({ rng, entity, naming, id, api, clean }) {
    const g = <T>(good: T, v: T): T => (clean ? good : v);
    const flag = naming.word(entity.flags[0] ?? rng.pick(["done", "starred", "archived"]));
    const optimistic = rng.bool(0.55);
    return {
      id,
      api: api.name,
      store: naming.store(entity.p, rng.pick(["query", "view", "page", "screen"])),
      f: { list: naming.field("list", id), filter: naming.field("filter", id), total: naming.field("total", id), fetching: naming.field("loading", id), error: naming.field("error", id), draft: naming.field("draft", id) },
      path: naming.route(entity.p),
      itemPath: naming.route(entity.p, ":id"),
      nameField: entity.name,
      flag,
      items: seedItems(rng, entity, rng.int(6, 16), (it) => {
        for (const fl of entity.flags) delete it[fl];
        it[flag] = rng.bool(0.35);
      }),
      words: entity.words,
      staleMs: rng.weighted([[0, 3], [rng.int(2000, 8000), 2], [rng.int(15000, 60000), 1]] as const),
      dedupe: g(true, rng.bool(0.5)),
      observers: rng.weighted([[1, 3], [2, 2]] as const),
      retry: g("backoff", rng.weighted([["backoff", 4], ["fixed", 2], ["none", 2]] as const)),
      invalidate: g("settled", rng.weighted([["settled", 3], ["mutate", 2]] as const)),
      optimistic,
      cancelOnMutate: g(true, rng.bool(0.45)),
      intervalMs: rng.weighted([[0, 3], [rng.int(4000, 15000), 2]] as const),
      focus: rng.bool(0.7),
      totalOnAllPaths: g(true, rng.bool(0.6)),
      externalEdits: rng.weighted([[0, 2], [1, 2], [3, 1]] as const),
      labels: {
        input: `input "${rng.pick(["New", "Add"])} ${entity.s}"`,
        tabs: { all: `tab "All"`, yes: `tab "${title(flag)}"`, no: `tab "${rng.pick(["Not", "Un", "Without"])} ${flag.toLowerCase()}"` },
      },
    };
  },
  pattern(s) {
    return [s.dedupe ? "dedupe" : "nodedupe", `retry:${s.retry}`, `invalidate:${s.invalidate}`, s.optimistic ? (s.cancelOnMutate ? "optimistic+cancel" : "optimistic-nocancel") : "pessimistic", s.staleMs === 0 ? "stale:0" : "stale:time", s.intervalMs ? "interval" : "nointerval", s.focus ? "focus" : "nofocus", `observers:${s.observers}`, s.totalOnAllPaths ? "total" : "total-partial"];
  },
  relations(s): Relation[] {
    const c = `${s.store}.${s.f.total}`;
    const l = `${s.store}.${s.f.list}`;
    return [{ fields: [c, l], desc: "total equals number of listed items", check: (st) => Number(rel.field(st, c)) === ((rel.field(st, l) as unknown[]) ?? []).length }];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:items`;
    for (const it of s.items) db.insert(coll, it, `seed:${String(it[s.nameField])}`);
    srv.route(
      "GET",
      s.path,
      (req) => {
        const q = req.query.get(s.flag);
        const items = db.list(coll).filter((x) => q === null || (x[s.flag] === true) === (q === "true"));
        return { status: 200, body: api.list(items, { total: items.length }) };
      },
      { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` },
    );
    srv.route(
      "POST",
      s.path,
      (req) => {
        const b = (req.body ?? {}) as Obj;
        const name = String(b[s.nameField] ?? "").trim();
        if (!name) return { status: 422, body: api.error("invalid", `${s.nameField} is required`) };
        return { status: 201, body: api.one(db.insert(coll, { [s.nameField]: name, [s.flag]: false }, name, req.t)) };
      },
      { feature: s.id, kind: "write", idempotent: false, resource: `c:${coll}` },
    );
    srv.route(
      "PATCH",
      s.itemPath,
      (req) => {
        const b = (req.body ?? {}) as Obj;
        const it = db.update(coll, req.params.id!, { [s.flag]: b[s.flag] === true }, req.t);
        return it ? { status: 200, body: api.one(it) } : { status: 404, body: api.error("not_found", "no such item") };
      },
      { feature: s.id, kind: "write", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const S = env.store(s.store, s.id, { [F.list]: [] as Item[], [F.filter]: "all", [F.total]: 0, [F.fetching]: true, [F.error]: null, [F.draft]: "" } as Obj, {
      weights: weightsOf([[F.list, 1], [F.filter, 0.4], [F.total, 0.5], [F.fetching, 0.1], [F.error, 0], [F.draft, 0.3]]),
      resync: () => fetchQuery(mounted, "resync", undefined, true),
    });
    const cache = new Map<string, Entry>();
    const mutations: Mutation[] = [];
    let mounted = "all";
    const entry = (k: string): Entry => {
      let e = cache.get(k);
      if (!e) {
        e = { data: null, at: -Infinity, inflight: null, ctl: null };
        cache.set(k, e);
      }
      return e;
    };
    const matches = (v: boolean, k: string) => k === "all" || (k === "yes") === v;
    const urlOf = (k: string) => (k === "all" ? s.path : `${s.path}?${s.flag}=${k === "yes"}`);
    const listOf = (p: Obj) => (p[F.list] as Item[]) ?? [];
    const reflected = (m: Mutation, items: Item[], k: string): boolean => {
      if (m.kind === "create") return !matches(false, k) || items.some((x) => x[s.nameField] === m.name);
      const it = items.find((x) => x.id === m.id);
      if (!matches(m.value === true, k)) return !it;
      return k === "all" && !it ? true : !!it && it[s.flag] === m.value;
    };
    function settle(k: string, items: Item[], op: ReturnType<typeof kit.op>, intent: number | undefined): void {
      const e = entry(k);
      e.data = items;
      e.at = env.now();
      if (k !== mounted) return;
      const classify = () => {
        // Data fetched before one of our mutations committed (or while it is still pending) would undo it on screen.
        for (const m of mutations) {
          const relevant = m.state === "pending" || (m.state === "ok" && (m.tEnd ?? 0) > op.t0);
          if (relevant && !reflected(m, items, k)) return "stale";
        }
        // Same key as the view shows (the user left this tab and came back): current data, not a superseded view.
        return intent !== undefined && env.know.superseded(intent) && mounted === k ? "expected" : undefined;
      };
      kit.write(S, (p) => ({ ...p, [F.list]: items, [F.total]: items.length, [F.fetching]: false, [F.error]: null }), { role: op.role === "load" ? "load" : "refetch", op, intent, key: `${s.id}.q.${k}`, classify });
    }
    async function run(k: string, why: string, intent: number | undefined, ctl: AbortController, dupOf: number | undefined): Promise<void> {
      const e = entry(k);
      const done = () => {
        if (e.ctl === ctl) {
          e.ctl = null;
          e.inflight = null;
        }
      };
      let prev: number | undefined;
      for (let attempt = 1; ; attempt++) {
        const op = kit.op({ role: why, method: "GET", url: urlOf(k), key: `${s.id}.q.${k}`, intent, background: intent === undefined, handled: s.retry !== "none", attempt, ...(prev !== undefined ? { retryOf: prev } : {}), ...(dupOf !== undefined && attempt === 1 ? { dupOf } : {}) });
        if (attempt === 1) e.opId = op.id;
        const r = await kit.call(op, { signal: ctl.signal, timeoutMs: 10000 });
        if (r.outcome === "aborted") return done();
        if (r.ok) {
          done();
          return settle(k, kit.api.unlist(r.body).items, op, intent);
        }
        const permanent = r.status >= 400 && r.status < 500 && r.status !== 429;
        if (s.retry === "none" || attempt >= 4 || permanent) {
          done();
          if (k !== mounted) return;
          const msg = errMsg(r.status, r.outcome);
          kit.write(S, (p) => ({ ...p, [F.fetching]: false, [F.error]: msg }), { role: "error", op, intent, key: `${s.id}.q.${k}` });
          kit.shownError();
          return;
        }
        prev = op.id;
        await env.sleep(s.retry === "backoff" ? Math.min(30000, 1000 * 2 ** (attempt - 1)) : 300);
        if (ctl.signal.aborted) return done();
      }
    }
    /** Fetch a query; `force` (invalidation) cancels an in-flight fetch and starts a fresh one. */
    function fetchQuery(k: string, why: string, intent?: number, force = false): Promise<void> {
      const e = entry(k);
      if (e.inflight && force) {
        e.ctl?.abort();
        e.inflight = null;
        e.ctl = null;
      }
      if (s.dedupe && e.inflight) return e.inflight;
      const dupOf = e.inflight ? e.opId : undefined;
      const ctl = new AbortController();
      if (k === mounted && S.get()[F.fetching] !== true) kit.write(S, (p) => ({ ...p, [F.fetching]: true }), { role: "loading", intent, key: `${s.id}.q.${k}` });
      const p = run(k, why, intent, ctl, dupOf);
      e.inflight = p;
      e.ctl = ctl;
      return p;
    }
    function revalidate(why: string, intent?: number): void {
      const e = entry(mounted);
      if (env.now() - e.at < s.staleMs) return;
      for (let i = 0; i < s.observers; i++) kit.spawn(() => fetchQuery(mounted, why, intent), "swallow");
    }
    function invalidate(intent: number): void {
      for (const e of cache.values()) e.at = -Infinity;
      kit.spawn(() => fetchQuery(mounted, "invalidate", intent, true), "swallow");
    }
    function mount(k: string, intent: number): void {
      mounted = k;
      const e = entry(k);
      const cached = e.data;
      kit.write(S, (p) => ({ ...p, [F.filter]: k }), { role: "input", intent, key: `${s.id}.filter` });
      const list = cached ?? [];
      kit.write(S, (p) => ({ ...p, [F.list]: list, [F.total]: list.length, [F.error]: null, [F.fetching]: !cached }), { role: cached ? "swr-cache" : "loading", intent, key: `${s.id}.q.${k}` });
      revalidate(cached ? "revalidate" : "load", intent);
    }
    async function mutate(m: Mutation, intent: number, req: { method: string; url: string; body: Obj }, optimistic: (list: Item[]) => Item[]): Promise<void> {
      mutations.push(m);
      if (mutations.length > 40) mutations.shift();
      const key = `${s.id}.mut`;
      let snapshot: Item[] | null = null;
      if (s.optimistic) {
        if (s.cancelOnMutate) for (const e of cache.values()) if (e.ctl) {
          e.ctl.abort();
          e.ctl = null;
          e.inflight = null;
        }
        snapshot = listOf(S.get());
        const full = s.totalOnAllPaths;
        // Defect variant: the optimistic path forgets the total (only matters when the length changes).
        const breaks = !full && optimistic(snapshot).length !== snapshot.length;
        kit.write(S, (p) => {
          const list = optimistic(listOf(p));
          return { ...p, [F.list]: list, ...(full ? { [F.total]: list.length } : {}) };
        }, { role: "optimistic", intent, key, ...(breaks ? { anomaly: "partial" } : {}) });
        entry(mounted).data = optimistic(snapshot);
      }
      // Defect: invalidating right away; the refetch can reach the server before the mutation commits.
      if (s.invalidate === "mutate") invalidate(intent);
      const op = kit.op({ role: m.kind, method: req.method, url: req.url, body: req.body, intent, key, idempotent: m.kind !== "create" });
      const r = await kit.call(op, { timeoutMs: 10000 });
      m.state = r.ok ? "ok" : "failed";
      m.tEnd = env.now();
      if (!r.ok) {
        const snap = snapshot;
        const msg = errMsg(r.status, r.outcome);
        kit.write(S, (p) => ({ ...p, ...(snap ? { [F.list]: snap, [F.total]: snap.length } : {}), [F.error]: msg }), { role: snap ? "rollback" : "error", op, intent, key });
        kit.shownError();
      }
      if (s.invalidate === "settled") invalidate(intent);
    }
    return {
      init() {
        for (let i = 0; i < s.observers; i++) kit.spawn(() => fetchQuery("all", "load"), "swallow");
        if (s.intervalMs) env.setInterval(() => kit.spawn(() => fetchQuery(mounted, "interval"), "swallow"), s.intervalMs);
        if (s.focus) {
          env.on("focus", () => revalidate("focus"));
          env.on("visibilitychange", () => {
            if (env.G.document.visibilityState !== "hidden") revalidate("focus");
          });
        }
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "filter") return mount(String(step.ui.value ?? "all"), intent);
        if (step.action === "type") {
          const v = String(step.ui.value ?? "");
          kit.write(S, (p) => ({ ...p, [F.draft]: v }), { role: "input", intent, key: `${s.id}.draft` });
          return;
        }
        if (step.action === "add") {
          const name = String(S.get()[F.draft] ?? "").trim();
          if (!name) return;
          kit.write(S, (p) => ({ ...p, [F.draft]: "" }), { role: "input", intent, key: `${s.id}.draft` });
          const k = mounted;
          const tmp: Item = { id: `tmp-${intent}`, [s.nameField]: name, [s.flag]: false };
          kit.spawn(() => mutate({ kind: "create", name, state: "pending" }, intent, { method: "POST", url: s.path, body: { [s.nameField]: name } }, (list) => (matches(false, k) ? [...list, tmp] : list)), "uncaught", { cause: "mutation-failed", diagnosis: "failing" });
          return;
        }
        const name = String(step.args?.name ?? "");
        const it = listOf(S.get()).find((x) => String(x[s.nameField]) === name && !String(x.id).startsWith("tmp-"));
        if (!it) return;
        const id = String(it.id);
        const value = it[s.flag] !== true;
        const k = mounted;
        kit.spawn(
          () => mutate({ kind: "toggle", id, value, state: "pending" }, intent, { method: "PATCH", url: s.itemPath.replace(":id", encodeURIComponent(id)), body: { [s.flag]: value } }, (list) => list.map((x) => (x.id === id ? { ...x, [s.flag]: value } : x)).filter((x) => x.id !== id || matches(value, k))),
          "uncaught",
          { cause: "mutation-failed", diagnosis: "failing" },
        );
      },
      cond() {
        return S.get()[F.fetching] === true;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    const names = s.items.map((it) => String(it[s.nameField]));
    let tab = "all";
    let t = win.t0 + user.think(0.8);
    while (t < win.t1 - 1000) {
      const r = user.rng.next();
      if (r < 0.3) {
        tab = user.rng.pick(FILTERS.filter((x) => x !== tab));
        steps.push({ t, feature: s.id, action: "filter", ui: { kind: "click", target: s.labels.tabs[tab]!, value: tab }, intent: { kind: "filter", key: `${s.id}.filter`, mode: "replace", accidental: false } });
        // Flipping back to the previous tab right away (served from cache, then revalidated).
        if (user.rng.bool(0.2)) {
          tab = "all";
          steps.push({ t: t + user.rng.float(400, 1500), feature: s.id, action: "filter", ui: { kind: "click", target: s.labels.tabs.all!, value: "all" }, intent: { kind: "filter", key: `${s.id}.filter`, mode: "replace", accidental: false } });
          t += 1500;
        }
      } else if (r < 0.55) {
        const text = `${user.rng.pick(s.words)}${user.rng.bool(0.4) ? " " + user.rng.pick(s.words) : ""}`;
        const typed = user.type(t, "", text, s.labels.input, "type", `${s.id}.draft`);
        steps.push(...typed.steps);
        t = typed.t + user.rng.float(100, 500);
        steps.push(...user.click(t, s.labels.input, "add", { kind: "create", key: `${s.id}.create` }, { kind: "key", value: "Enter", doubleP: Math.min(0.04, user.p.doubleClickP) }).steps);
        names.push(text);
      } else {
        const name = user.rng.pick(names);
        const c = user.click(t, `checkbox "${name}"`, "toggle", { kind: "toggle", key: `${s.id}.item.${name}`, mode: "replace" }, { args: { name } });
        steps.push(...c.steps);
      }
      t += user.think(1.1);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    for (let i = 0; i < s.externalEdits; i++) {
      const pick = rng.int(0, 999);
      out.push({
        t: rng.float(win.t0 + 1000, Math.max(win.t0 + 1100, win.t1)),
        feature: s.id,
        desc: `another user flips a ${s.flag}`,
        apply(w) {
          const coll = `${s.id}:items`;
          const ids = w.db.collection(coll).order;
          const id = ids[pick % Math.max(1, ids.length)];
          const it = id ? w.db.get(coll, id) : undefined;
          if (it) w.db.update(coll, id!, { [s.flag]: it[s.flag] !== true }, w.now());
        },
      });
    }
    return out;
  },
};
