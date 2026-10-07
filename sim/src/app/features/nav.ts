// Multi-view navigation. Each view loads several resources in parallel (Promise.all / allSettled) or as a
// dependent chain (load A, then B using A's id). Knobs: route guard before writing (else a slow load for the
// previous view overwrites the current one), abort on navigation, error handling (unhandled rejection / error
// banner / partial render), stale-while-revalidate cache per view.

import type { Item } from "../../net/server.js";
import type { Store } from "../env.js";
import type { FeatureDef, UserStep } from "../feature.js";
import { errorFor, type CallResult } from "../kit.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

interface View {
  route: string;
  resources: { name: string; path: string; items: Item[]; dependsOn?: string }[];
}

export interface NavSpec {
  id: string;
  api: string;
  store: string;
  f: { view: string; data: string; loading: string; error: string };
  views: View[];
  mode: "all" | "allSettled" | "chain";
  routeGuard: boolean;
  abortOnNav: boolean;
  onError: "throw" | "banner" | "partial";
  swr: boolean;
  nameField: string;
}

export const nav: FeatureDef<NavSpec> = {
  kind: "nav",
  make({ rng, domain, naming, id, api }) {
    const n = rng.int(2, 4);
    const views: View[] = [];
    const usedRoutes = new Set<string>();
    for (let i = 0; i < n; i++) {
      const ent = rng.pick(domain.entities);
      let route = rng.pick(["/" + ent.p, "/" + rng.pick(["home", "overview", "activity", "insights", "workspace", "inbox", "team"]), "/" + ent.p + "/" + rng.pick(["recent", "mine", "all"])]);
      while (usedRoutes.has(route)) route += "-" + i;
      usedRoutes.add(route);
      const k = rng.int(2, 3);
      const resources: View["resources"] = [];
      for (let j = 0; j < k; j++) {
        const e2 = rng.pick(domain.entities);
        const rname = naming.word(j === 0 ? e2.p : rng.pick([e2.p, "summary", "stats", "recent", "owners", "activity"]));
        const r: View["resources"][number] = { name: rname + (resources.some((x) => x.name === rname) ? String(j) : ""), path: naming.route(route.slice(1).replace(/\//g, "-"), rname), items: seedItems(rng, e2, rng.int(1, 6)) };
        if (j > 0 && rng.bool(0.3)) r.dependsOn = resources[0]!.name;
        resources.push(r);
      }
      views.push({ route, resources });
    }
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["page", "view", "screen", "route"]), rng.pick(["data", "state", ""]) || "data"),
      f: { view: rng.pick(["route", "view", "screen", "path"]), data: naming.field("list", id + "nav") === "data" ? "content" : rng.pick(["data", "content", "payload", "model"]), loading: naming.field("loading", id), error: naming.field("error", id) },
      views,
      mode: rng.weighted([["all", 4], ["allSettled", 2], ["chain", 2]] as const),
      routeGuard: rng.bool(0.45),
      abortOnNav: rng.bool(0.3),
      onError: rng.weighted([["throw", 2], ["banner", 3], ["partial", 2]] as const),
      swr: rng.bool(0.3),
      nameField: domain.entities[0]!.name,
    };
  },
  pattern(s) {
    return [`mode:${s.mode}`, s.routeGuard ? "route-guard" : "noguard", s.abortOnNav ? "abort" : "noabort", `err:${s.onError}`, s.swr ? "swr" : "noswr"];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    for (const v of s.views) {
      for (const r of v.resources) {
        const coll = `${s.id}:${v.route}:${r.name}`;
        for (const it of r.items) db.insert(coll, it, `seed:${JSON.stringify(it)}`);
        srv.route("GET", r.path, () => ({ status: 200, body: api.list(db.list(coll)) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
      }
    }
  },
  client(s, env, kit) {
    const F = s.f;
    const S: Store<Record<string, unknown>> = env.store(s.store, s.id, { [F.view]: s.views[0]!.route, [F.data]: {} as Record<string, unknown>, [F.loading]: false, [F.error]: null } as Record<string, unknown>, {
      weights: weightsOf([[F.view, 0.5], [F.data, 1], [F.loading, 0.1], [F.error, 0]]),
      resync: (): Promise<void> => load(String(S.get()[F.view]), env.know.latestIntent(`${s.id}.route`)?.id ?? 0, true),
    });
    const key = `${s.id}.route`;
    const cache = new Map<string, Record<string, unknown>>();
    let ctl: AbortController | null = null;
    let token = 0;
    async function load(route: string, intent: number, bg: boolean): Promise<void> {
      const v = s.views.find((x) => x.route === route);
      if (!v) return;
      const my = ++token;
      if (s.abortOnNav && ctl) ctl.abort();
      const myCtl = s.abortOnNav ? new AbortController() : null;
      ctl = myCtl;
      const cached = s.swr ? cache.get(route) : undefined;
      kit.write(S, (p) => ({ ...p, [F.loading]: true, ...(cached ? { [F.data]: cached } : {}) }), { role: cached ? "swr-cache" : "loading", intent, key });
      const guardOk = () => !s.routeGuard || (my === token && S.get()[F.view] === route);
      const staleIf = () => (env.know.superseded(intent) && S.get()[F.view] !== route ? "stale" : undefined);
      const fetchRes = (r: View["resources"][number], depId?: string): Promise<CallResult> => {
        const url = depId ? `${r.path}?${r.dependsOn}=${encodeURIComponent(depId)}` : r.path;
        const op = kit.op({ role: `load:${r.name}`, method: "GET", url, intent, key, background: bg, handled: s.onError !== "throw" });
        const opts: { signal?: AbortSignal; timeoutMs?: number } = { timeoutMs: 10000 };
        if (myCtl) opts.signal = myCtl.signal;
        return kit.call(op, opts).then((res) => {
          (res as CallResult & { op?: unknown }).op = op;
          return res;
        });
      };
      const results: Record<string, unknown> = {};
      let failed: CallResult | null = null;
      if (s.mode === "chain") {
        for (const r of v.resources) {
          const dep = r.dependsOn ? (results[r.dependsOn] as Item[] | undefined)?.[0]?.id : undefined;
          const res = await fetchRes(r, dep !== undefined ? String(dep) : undefined);
          if (res.outcome === "aborted") return;
          if (!res.ok) {
            failed = res;
            break;
          }
          results[r.name] = kit.api.unlist(res.body).items;
        }
      } else if (s.mode === "all") {
        const all = await Promise.all(v.resources.map((r) => fetchRes(r)));
        if (all.some((x) => x.outcome === "aborted")) return;
        const bad = all.find((x) => !x.ok);
        if (bad) failed = bad;
        else v.resources.forEach((r, i) => (results[r.name] = kit.api.unlist(all[i]!.body).items));
      } else {
        const all = await Promise.all(v.resources.map((r) => fetchRes(r)));
        if (all.some((x) => x.outcome === "aborted")) return;
        v.resources.forEach((r, i) => {
          if (all[i]!.ok) results[r.name] = kit.api.unlist(all[i]!.body).items;
          else failed = failed ?? all[i]!;
        });
      }
      if (!guardOk()) return;
      if (failed) {
        const f = failed as CallResult;
        if (s.onError === "throw") {
          kit.write(S, (p) => ({ ...p, [F.loading]: false }), { role: "loading", intent, key });
          throw errorFor(f, `load ${route}`);
        }
        if (s.onError === "banner" || Object.keys(results).length === 0) {
          kit.write(S, (p) => ({ ...p, [F.loading]: false, [F.error]: errMsg(f.status, f.outcome) }), { role: "error", intent, key, classify: staleIf });
          kit.shownError();
          return;
        }
      }
      cache.set(route, results);
      kit.write(S, (p) => ({ ...p, [F.data]: results, [F.loading]: false, [F.error]: failed ? "Some sections failed to load" : null }), { role: "view-data", intent, key, classify: staleIf, ...(failed ? { anomaly: "benign-change" } : {}) });
      if (failed) kit.shownError();
    }
    return {
      init() {
        env.setRoute(s.views[0]!.route);
        kit.spawn(() => load(s.views[0]!.route, 0, true), "uncaught", { cause: "load-failed", diagnosis: "failing" });
      },
      handle(step: UserStep, intent: number) {
        const route = String(step.ui.value);
        env.setRoute(route);
        kit.write(S, (p) => ({ ...p, [F.view]: route }), { role: "input", intent, key });
        kit.spawn(() => load(route, intent, false), "uncaught", { cause: "load-failed", diagnosis: "failing" });
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(1.2);
    let cur = s.views[0]!.route;
    while (t < win.t1 - 1000) {
      const next = user.rng.pick(s.views.filter((v) => v.route !== cur)).route;
      cur = next;
      steps.push({ t, feature: s.id, action: "nav", ui: { kind: "nav", target: `link "${title(next.split("/").filter(Boolean).join(" "))}"`, value: next }, intent: { kind: "nav", key: `${s.id}.route`, mode: "replace", accidental: false } });
      // Sometimes the user changes their mind quickly.
      t += user.rng.bool(0.25) ? user.rng.float(150, 700) : user.think(1.6);
    }
    return steps;
  },
};
