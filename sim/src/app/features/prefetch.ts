// Hover prefetch: hovering a link starts GET detail in the background; clicking it shows the prefetched result.
// Other users update items (external events), some right after this user hovered them. Knobs: prefetch at once on
// every hover (defect: fast mouse sweeps fire a storm) vs after a short hover-intent delay (guard); in-flight dedupe
// map (guard) vs a second identical request when the click lands while the prefetch is still in flight (defect:
// duplicate; the two responses race); cache TTL (guard) vs serving a prefetched copy forever; prefetch completions
// write the open detail (with or without a version check: an older copy can land over a newer one).

import type { Item } from "../../net/server.js";
import type { SimOp } from "../../oracle/knowledge.js";
import type { ExternalEvent, FeatureDef, UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface PrefetchSpec {
  id: string;
  api: string;
  store: string;
  f: { list: string; detail: string; open: string; loading: string; error: string };
  nameField: string;
  valueField: string;
  statuses: string[];
  items: Item[];
  listPath: string;
  itemPath: string;
  trigger: "immediate" | "intent";
  dwellMs: number;
  dedupe: boolean;
  ttlMs: number;
  versionGuard: boolean;
  refreshMs: number;
  backLabel: string;
  updates: number;
}

export const prefetch: FeatureDef<PrefetchSpec> = {
  kind: "prefetch",
  make({ rng, entity, naming, id, api, clean }) {
    const trigger = rng.weighted([["immediate", 3], ["intent", 2]] as const);
    const dedupe = rng.bool(0.5);
    const ttl = rng.weighted([[0, 2], [rng.int(2000, 10000), 3]] as const);
    const versionGuard = rng.bool(0.4);
    const valueField = entity.nums[0]?.[0] ?? "value";
    return {
      id,
      api: api.name,
      store: naming.store(entity.s, rng.pick(["detail", "viewer", "preview", "browser"])),
      f: { list: naming.field("list", id), detail: naming.field("selected", id), open: rng.pick(["openId", "activeId", "currentId", "routeId"]), loading: naming.field("loading", id), error: naming.field("error", id) },
      nameField: entity.name,
      valueField,
      statuses: entity.status.length ? entity.status : ["open", "closed"],
      items: seedItems(rng, entity, rng.int(6, 14), (it) => {
        it.description = `${title(String(it[entity.name]))} ${rng.pick(["details", "overview", "notes", "summary"])}`;
      }),
      listPath: naming.route(entity.p),
      itemPath: naming.route(entity.p, ":id"),
      trigger: clean ? "intent" : trigger,
      dwellMs: rng.int(60, 180),
      dedupe: clean || dedupe,
      ttlMs: clean && ttl === 0 ? 5000 : ttl,
      versionGuard: clean || versionGuard,
      refreshMs: rng.weighted([[0, 2], [rng.int(5000, 15000), 2]] as const),
      backLabel: `link "${rng.pick(["Back", "All " + entity.p, "← " + title(entity.p)])}"`,
      updates: rng.int(2, 6),
    };
  },
  pattern(s) {
    return [`trigger:${s.trigger}`, s.dedupe ? "dedupe" : "nodedupe", s.ttlMs ? "ttl" : "nottl", s.versionGuard ? "vguard" : "novguard"];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:items`;
    for (const it of s.items) db.insert(coll, it, `seed:${it[s.nameField]}`);
    srv.route("GET", s.listPath, () => ({ status: 200, body: api.list(db.list(coll).map((it) => ({ id: it.id!, [s.nameField]: it[s.nameField]!, version: it.version! }))) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
    srv.route("GET", s.itemPath, (req) => {
      const it = db.get(coll, req.params.id!);
      return it ? { status: 200, body: api.one(it) } : { status: 404, body: api.error("not_found", "gone") };
    }, { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.open`;
    const init: Record<string, unknown> = { [F.list]: [] as Item[], [F.detail]: null, [F.open]: null, [F.loading]: false, [F.error]: null };
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.list, 0.6], [F.detail, 1], [F.open, 0.4], [F.loading, 0.1], [F.error, 0]]),
      resync: () => loadList(true),
    });
    const cache = new Map<string, { data: Item; at: number }>();
    const inflight = new Map<string, { p: Promise<Item | null>; op: SimOp }>();
    const recent: number[] = [];
    let dwell: unknown = null;
    const listVersion = (id: string) => Number(((S.get()[F.list] as Item[]) ?? []).find((x) => x.id === id)?.version ?? 0);
    const shownVersion = () => Number((S.get()[F.detail] as Item | null)?.version ?? 0);
    const idAt = (idx: number) => String(((S.get()[F.list] as Item[]) ?? [])[idx]?.id ?? "");
    // Write a detail copy if that item is (still) open. Older copies over newer ones are stale.
    const show = (id: string, data: Item, role: string, meta: { op?: SimOp; intent?: number }) => {
      if (S.get()[F.open] !== id) return;
      if (s.versionGuard && shownVersion() > Number(data.version ?? 0) && (S.get()[F.detail] as Item | null)?.id === id) return;
      const classify = () => {
        const cur = S.get()[F.detail] as Item | null;
        if (cur?.id === id && Number(cur.version ?? 0) > Number(data.version ?? 0)) return "stale";
        return listVersion(id) > Number(data.version ?? 0) ? "stale" : undefined;
      };
      kit.write(S, (p) => ({ ...p, [F.detail]: data, [F.loading]: false, [F.error]: null }), { role, key, classify, ...meta });
    };
    async function loadList(bg: boolean, attempt = 0, retryOf?: number): Promise<void> {
      const op = kit.op({ role: "list", method: "GET", url: s.listPath, key: `${s.id}.list`, background: bg, handled: true, ...(attempt ? { attempt, retryOf } : {}) });
      const r = await kit.call(op, { timeoutMs: 10000 });
      if (r.ok) return kit.write(S, (p) => ({ ...p, [F.list]: kit.api.unlist(r.body).items }), { role: "load", op, key: `${s.id}.list` });
      // The first load retries until the list shows up (nothing can be hovered without it).
      if (attempt > 0 && attempt < 4 && ((S.get()[F.list] as Item[]) ?? []).length === 0) {
        await env.sleep(1500 * attempt);
        return loadList(bg, attempt + 1, op.id);
      }
    }
    function fetchItem(id: string, role: string, bg: boolean, intent?: number): { p: Promise<Item | null>; op: SimOp } {
      const prev = inflight.get(id);
      const now = env.now();
      while (recent.length && recent[0]! < now - 1000) recent.shift();
      if (role === "prefetch") recent.push(now);
      const op = kit.op({ role, method: "GET", url: s.itemPath.replace(":id", encodeURIComponent(id)), key: `${s.id}.item.${id}`, intent, background: bg, handled: bg, ...(prev ? { dupOf: prev.op.id } : {}), ...(role === "prefetch" && recent.length >= 4 ? { anomaly: "storm" } : {}) });
      const p = kit.call(op, { timeoutMs: 10000 }).then((r) => {
        if (inflight.get(id)?.op === op) inflight.delete(id);
        if (!r.ok) return null;
        const data = kit.api.unone(r.body);
        cache.set(id, { data, at: env.now() });
        return data;
      });
      const entry = { p, op };
      inflight.set(id, entry);
      return entry;
    }
    function prefetchItem(id: string, intent: number): void {
      if (!id) return;
      const c = cache.get(id);
      if (c && (s.ttlMs === 0 || env.now() - c.at < s.ttlMs)) return;
      if (s.dedupe && inflight.has(id)) return;
      const { p, op } = fetchItem(id, "prefetch", true, intent);
      void p.then((data) => {
        if (data) show(id, data, "data", { op });
      });
    }
    function open(intent: number, idx: number): void {
      const id = idAt(idx);
      if (!id) return;
      if (dwell) env.clearTimeout(dwell);
      kit.write(S, (p) => ({ ...p, [F.open]: id }), { role: "input", intent, key });
      const c = cache.get(id);
      if (c && (s.ttlMs === 0 || env.now() - c.at < s.ttlMs)) return show(id, c.data, "cache", { intent });
      kit.write(S, (p) => ({ ...p, [F.loading]: true }), { role: "loading", intent, key });
      const pending = inflight.get(id);
      kit.spawn(async () => {
        const { p, op } = s.dedupe && pending ? pending : fetchItem(id, "open", false, intent);
        const data = await p;
        if (data) return show(id, data, "results", { op, intent });
        if (S.get()[F.open] !== id) return;
        kit.write(S, (q) => ({ ...q, [F.loading]: false, [F.error]: errMsg(op.status ?? 0, op.outcome ?? "neterr") }), { role: "error", op, intent, key });
        kit.shownError();
      }, "swallow");
    }
    return {
      init() {
        kit.spawn(() => loadList(true, 1), "swallow");
        if (s.refreshMs) env.setInterval(() => kit.spawn(() => loadList(true), "swallow"), s.refreshMs);
      },
      handle(step: UserStep, intent: number) {
        const idx = Number(step.args?.idx ?? 0);
        if (step.action === "hover") {
          if (s.trigger === "immediate") return prefetchItem(idAt(idx), intent);
          if (dwell) env.clearTimeout(dwell);
          dwell = env.setTimeout(() => {
            dwell = null;
            prefetchItem(idAt(idx), intent);
          }, s.dwellMs);
          return;
        }
        if (step.action === "back") return kit.write(S, (p) => ({ ...p, [F.open]: null, [F.detail]: null, [F.loading]: false }), { role: "input", intent, key });
        open(intent, idx);
      },
      cond() {
        return S.get()[F.loading] === true;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    const n = s.items.length;
    const link = (i: number) => `link "${String(s.items[i]![s.nameField])}"`;
    const hover = (t: number, i: number) => steps.push({ t, feature: s.id, action: "hover", ui: { kind: "key", target: link(i), value: "hover" }, args: { idx: i }, intent: { kind: "hover", key: `${s.id}.hover`, mode: "replace", accidental: false } });
    let t = win.t0 + user.think(1);
    while (t < win.t1 - 1500) {
      // Sweep the pointer across the list (fast hovers), settle on one link.
      let i = user.rng.int(0, n - 1);
      for (let k = user.rng.int(1, 7); k > 0; k--) {
        hover(t, i);
        t += user.rng.float(40, 180);
        i = Math.max(0, Math.min(n - 1, i + user.rng.pick([-1, 1, 1, 2])));
      }
      hover(t, i);
      if (user.rng.bool(0.25)) {
        t += user.think(1.2);
        continue;
      }
      // Quick click (prefetch still in flight) or after reading the preview.
      t += user.rng.bool(0.45) ? user.rng.float(90, 350) : user.rng.float(500, 2200);
      steps.push(...user.click(t, link(i), "open", { kind: "open", key: `${s.id}.open`, mode: "replace" }, { args: { idx: i }, pendingCond: "loading" }).steps);
      t += user.think(1.8);
      steps.push({ t, feature: s.id, action: "back", ui: { kind: "click", target: s.backLabel }, intent: { kind: "back", key: `${s.id}.open`, mode: "replace", accidental: false } });
      t += user.think(0.8);
    }
    return steps;
  },
  external(s, rng, win, steps) {
    const out: ExternalEvent[] = [];
    const plan: { t: number; idx: number }[] = [];
    for (let i = 0; i < s.updates; i++) plan.push({ t: rng.float(win.t0, win.t1), idx: rng.int(0, s.items.length - 1) });
    // Someone edits the item this user is hovering (the prefetched copy goes stale before the click).
    for (const st of steps) if (st.action === "hover" && rng.bool(0.08)) plan.push({ t: st.t + rng.float(30, 900), idx: Number(st.args?.idx ?? 0) });
    for (const { t, idx } of plan) {
      out.push({
        t,
        feature: s.id,
        desc: `another user updates item ${idx}`,
        apply(w) {
          const coll = `${s.id}:items`;
          const id = w.db.collection(coll).order[idx];
          const it = id ? w.db.get(coll, id) : undefined;
          if (!it || !id) return;
          const k = (Number(it.version ?? 1) + idx) % s.statuses.length;
          w.db.update(coll, id, { status: s.statuses[k]!, [s.valueField]: Math.round(Number(it[s.valueField] ?? 1) * 1.07 * 100) / 100 }, w.now());
        },
      });
    }
    return out;
  },
};
