// Service-worker style cached fetch inside the app: a catalogue/feed with category tabs whose list requests go
// through a client-side cache (a Map in the page, or persisted to localStorage). Strategies: cache-first (never
// revalidates: a tab keeps what it first got, including an empty or broken response cached during an incident),
// network-first with an app timeout and cache fallback on failure (benign on failure), and stale-while-revalidate
// (cache shown at once, then the network result). Knob: check that a response still belongs to the selected tab
// before applying it; without it a slow fetch/revalidation for the previous tab overwrites the current one.

import type { Item } from "../../net/server.js";
import type { Store } from "../env.js";
import { rel, type ExternalEvent, type FeatureDef, type UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface SwcacheSpec {
  id: string;
  api: string;
  store: string;
  f: { list: string; category: string; loading: string; error: string; cached: string };
  nameField: string;
  catField: string;
  categories: string[];
  items: Item[];
  path: string;
  param: string;
  strategy: "cache-first" | "network-first" | "swr";
  keyGuard: boolean;
  persist: boolean;
  nfTimeoutMs: number;
  tabLabel: string;
  refreshLabel: string;
  changes: number;
  words: string[];
}

export const swcache: FeatureDef<SwcacheSpec> = {
  kind: "swcache",
  make({ rng, entity, naming, id, api, clean }) {
    const categories = entity.status.length >= 3 ? entity.status.slice(0, 4) : rng.sample(["new", "popular", "featured", "nearby", "sale", "mine"], rng.int(3, 4));
    const catField = naming.word(rng.pick(["category", "section", "group", "tab"]));
    return {
      id,
      api: api.name,
      store: naming.store(entity.p, rng.pick(["feed", "catalog", "browse", "list"])),
      f: { list: naming.field("list", id), category: naming.field("filter", id), loading: naming.field("loading", id), error: naming.field("error", id), cached: naming.word(rng.pick(["fromCache", "isStale", "cached", "offlineCopy"])) },
      nameField: entity.name,
      catField,
      categories,
      items: seedItems(rng, entity, rng.int(6, 16), (it, i) => {
        it[catField] = categories[i % categories.length]!;
      }),
      path: naming.route(entity.p),
      param: rng.pick(["category", "tab", "section", "filter"]),
      strategy: clean ? rng.pick(["network-first", "swr"] as const) : rng.weighted([["cache-first", 3], ["network-first", 3], ["swr", 4]] as const),
      keyGuard: clean ? true : rng.bool(0.45),
      persist: rng.bool(0.4),
      nfTimeoutMs: rng.int(1500, 5000),
      tabLabel: `tab "${title(entity.p)}"`,
      refreshLabel: `button "${rng.pick(["Refresh", "Reload", "↻", "Update"])}"`,
      changes: rng.int(1, 6),
      words: entity.words,
    };
  },
  pattern(s) {
    return [`strategy:${s.strategy}`, s.keyGuard ? "key-guard" : "no-key-guard", s.persist ? "persist" : "memory"];
  },
  relations(s) {
    const L = `${s.store}.${s.f.list}`;
    const C = `${s.store}.${s.f.category}`;
    return [{ fields: [L, C], desc: "listed items belong to the selected category", check: (st) => ((rel.field(st, L) as Item[]) ?? []).every((it) => it[s.catField] === rel.field(st, C)) }];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:items`;
    for (const it of s.items) db.insert(coll, it, `seed:${String(it[s.nameField])}`);
    srv.route(
      "GET",
      s.path,
      (req) => {
        const c = req.query.get(s.param) ?? "";
        const items = db.list(coll).filter((it) => !c || it[s.catField] === c);
        return { status: 200, body: api.list(items, { total: items.length }), headers: { "cache-control": "max-age=0" } };
      },
      { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.category`;
    const S: Store<Record<string, unknown>> = env.store(s.store, s.id, { [F.list]: [] as Item[], [F.category]: s.categories[0], [F.loading]: false, [F.error]: null, [F.cached]: false } as Record<string, unknown>, {
      weights: weightsOf([[F.list, 1], [F.category, 0.4], [F.loading, 0.1], [F.error, 0], [F.cached, 0.15]]),
      resync: (): Promise<void> => show(String(S.get()[F.category]), undefined, "resync"),
    });
    const urlOf = (cat: string) => `${s.path}?${s.param}=${encodeURIComponent(cat)}`;
    // The cache: URL -> items (in memory, or localStorage when persisted).
    const mem = new Map<string, Item[]>();
    const applied = new Map<string, number>();
    const ls = env.G.localStorage;
    const cacheGet = (u: string): Item[] | undefined => {
      if (!s.persist) return mem.get(u);
      try {
        const raw = ls.getItem(`sw:${u}`);
        return raw ? (JSON.parse(raw) as Item[]) : undefined;
      } catch {
        return undefined;
      }
    };
    const cachePut = (u: string, items: Item[]): void => {
      if (!s.persist) mem.set(u, items);
      else {
        try {
          ls.setItem(`sw:${u}`, JSON.stringify(items));
        } catch {
          /* quota */
        }
      }
    };
    let loading = 0;
    async function show(cat: string, intent: number | undefined, why: "init" | "select" | "refresh" | "resync"): Promise<void> {
      const u = urlOf(cat);
      const hit = cacheGet(u);
      const withIntent = intent !== undefined ? { intent } : {};
      const current = () => String(S.get()[F.category]) === cat;
      // Cache-first answers from the cache and never revalidates (a resync is a hard reload).
      if (hit && (s.strategy === "swr" || (s.strategy === "cache-first" && why !== "resync"))) {
        // Every category has items, so an empty or nameless cached copy was cached during an incident.
        const anomaly = hit.length === 0 ? "empty" : hit.some((it) => it[s.nameField] == null) ? "shape" : undefined;
        kit.write(S, (p) => ({ ...p, [F.list]: hit, [F.cached]: true, [F.error]: null }), { role: "cache", key, ...withIntent, ...(anomaly ? { anomaly } : {}) });
        if (s.strategy === "cache-first") return;
      }
      const revalidate = !!hit && s.strategy === "swr";
      if (!revalidate) {
        loading++;
        kit.write(S, (p) => ({ ...p, [F.loading]: true }), { role: "loading", key, ...withIntent });
      }
      const op = kit.op({ role: why === "refresh" ? "refresh" : revalidate ? "revalidate" : "fetch", method: "GET", url: u, key, background: why === "init" || why === "resync" || revalidate, handled: s.strategy !== "cache-first", ...withIntent });
      const r = await kit.call(op, { timeoutMs: s.strategy === "network-first" ? s.nfTimeoutMs : 10000 });
      if (!revalidate) loading--;
      const busy = loading > 0;
      if (r.ok) {
        const items = kit.api.unlist(r.body).items;
        cachePut(u, items);
        if (s.keyGuard && !current()) {
          kit.write(S, (p) => ({ ...p, [F.loading]: busy }), { role: "loading", op, key });
          return;
        }
        const newest = applied.get(u) ?? -1;
        applied.set(u, Math.max(newest, op.t0));
        kit.write(S, (p) => ({ ...p, [F.list]: items, [F.cached]: false, [F.error]: null, [F.loading]: busy }), { role: revalidate ? "swr-cache" : "results", op, key, ...withIntent, classify: () => (op.t0 < newest && JSON.stringify(S.get()[F.list]) !== JSON.stringify(items) ? "stale" : undefined) });
        return;
      }
      if (r.outcome === "aborted") return;
      if (hit && s.strategy === "network-first") {
        // Offline / slow network: fall back to the cached copy (benign).
        if (s.keyGuard && !current()) return;
        kit.write(S, (p) => ({ ...p, [F.list]: hit, [F.cached]: true, [F.loading]: busy }), { role: "cache", op, key, ...withIntent });
        return;
      }
      if (revalidate) return; // keep showing the cached copy
      kit.write(S, (p) => ({ ...p, [F.error]: errMsg(r.status, r.outcome), [F.loading]: busy }), { role: "error", op, key, ...withIntent });
      kit.shownError();
    }
    return {
      init() {
        kit.spawn(() => show(s.categories[0]!, undefined, "init"), "swallow");
      },
      handle(step: UserStep, intent: number) {
        const tag = { cause: "feed-failed", diagnosis: "failing" };
        if (step.action === "refresh") return kit.spawn(() => show(String(S.get()[F.category]), intent, "refresh"), "uncaught", tag);
        const cat = String(step.ui.value);
        // Switching tabs clears the list (spinner) until the cache or the network answers.
        kit.write(S, (p) => ({ ...p, [F.category]: cat, [F.list]: [], [F.cached]: false, [F.error]: null }), { role: "input", intent, key });
        kit.spawn(() => show(cat, intent, "select"), "uncaught", tag);
      },
      cond() {
        return loading > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let cur = s.categories[0]!;
    let t = win.t0 + user.think(0.8);
    while (t < win.t1 - 800) {
      if (user.rng.bool(0.3)) steps.push(...user.click(t, s.refreshLabel, "refresh", { kind: "refresh", key: `${s.id}.refresh`, mode: "replace" }, { pendingCond: "loading" }).steps);
      else {
        // Switch tab; sometimes flick through two tabs quickly (or straight back to the previous one).
        const n = user.rng.bool(0.3) ? 2 : 1;
        for (let i = 0; i < n; i++) {
          cur = user.rng.pick(s.categories.filter((c) => c !== cur));
          steps.push({ t, feature: s.id, action: "select", ui: { kind: "click", target: `${s.tabLabel.slice(0, -1)}: ${title(cur)}"`, value: cur }, intent: { kind: "select", key: `${s.id}.category`, mode: "replace", accidental: false } });
          t += user.rng.float(250, 900);
        }
      }
      t += user.think(1.3);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    for (let k = 0; k < s.changes; k++) {
      const cat = rng.pick(s.categories);
      const name = `${rng.pick(s.words)} ${rng.pick(s.words)}`;
      out.push({
        t: rng.float(win.t0, win.t1),
        feature: s.id,
        desc: `new ${cat} item`,
        apply(w) {
          w.db.insert(`${s.id}:items`, { [s.nameField]: name, [s.catField]: cat }, `ext:${k}:${name}`, w.now());
        },
      });
    }
    return out;
  },
};
