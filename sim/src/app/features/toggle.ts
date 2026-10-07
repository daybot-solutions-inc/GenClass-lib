// Optimistic boolean flags on list items (star, pin, done, archive...). Knobs: absolute PATCH (idempotent) vs
// relative toggle endpoint (non-idempotent), rollback on failure, echo applied from the response (stale when the
// user toggles twice quickly), per-item pending guard, derived flagged-count.

import type { Item } from "../../net/server.js";
import { rel, type FeatureDef, type UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface ToggleSpec {
  id: string;
  api: string;
  store: string;
  f: { list: string; count: string; error: string };
  flag: string;
  nameField: string;
  items: Item[];
  listPath: string;
  itemPath: string;
  togglePath: string;
  endpoint: "absolute" | "relative";
  rollback: boolean;
  echo: boolean;
  pendingGuard: boolean;
  countField: boolean;
  countPartial: boolean;
  label: string;
}

const flagged = (list: Item[], flag: string) => list.filter((x) => x[flag] === true).length;

export const toggle: FeatureDef<ToggleSpec> = {
  kind: "toggle",
  make({ rng, entity, naming, id, api }) {
    const flag = entity.flags.length ? naming.word(rng.pick(entity.flags)) : naming.word(rng.pick(["starred", "pinned", "done", "archived", "liked"]));
    return {
      id,
      api: api.name,
      store: naming.store(entity.p, rng.pick(["list", "", "view", "board"]) || "list"),
      f: { list: naming.field("list", id), count: `${flag}${naming.fieldCase === "snake" ? "_count" : "Count"}`, error: naming.field("error", id) },
      flag,
      nameField: entity.name,
      items: seedItems(rng, entity, rng.int(4, 12), (it) => {
        it[flag] = rng.bool(0.3);
      }),
      listPath: naming.route(entity.p),
      itemPath: naming.route(entity.p, ":id"),
      togglePath: naming.route(entity.p, ":id", rng.pick(["toggle", `toggle-${flag}`, flag])),
      endpoint: rng.weighted([["absolute", 3], ["relative", 2]] as const),
      rollback: rng.bool(0.6),
      echo: rng.bool(0.5),
      pendingGuard: rng.bool(0.35),
      countField: rng.bool(0.5),
      countPartial: rng.bool(0.35),
      label: `button "${title(flag.replace(/ed$/, "").replace(/_/g, " "))}"`,
    };
  },
  pattern(s) {
    return [`ep:${s.endpoint}`, s.rollback ? "rollback" : "norollback", s.echo ? "echo" : "noecho", s.pendingGuard ? "pending-guard" : "noguard", s.countField ? (s.countPartial ? "count-partial" : "count") : "nocount"];
  },
  relations(s) {
    if (!s.countField) return [];
    const c = `${s.store}.${s.f.count}`;
    const l = `${s.store}.${s.f.list}`;
    return [{ fields: [c, l], desc: "count of flagged items", check: (st) => Number(rel.field(st, c)) === flagged(((rel.field(st, l) as Item[]) ?? []), s.flag) }];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:items`;
    for (const it of s.items) db.insert(coll, it, `seed:${it[s.nameField]}`);
    srv.route("GET", s.listPath, () => ({ status: 200, body: api.list(db.list(coll)) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
    srv.route(
      "PATCH",
      s.itemPath,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const it = db.update(coll, req.params.id!, { [s.flag]: b[s.flag] === true }, req.t);
        return it ? { status: 200, body: api.one(it) } : { status: 404, body: api.error("not_found", "gone") };
      },
      { feature: s.id, kind: "write", idempotent: true, resource: `c:${coll}` },
    );
    srv.route(
      "POST",
      s.togglePath,
      (req) => {
        const cur = db.get(coll, req.params.id!);
        if (!cur) return { status: 404, body: api.error("not_found", "gone") };
        const it = db.update(coll, req.params.id!, { [s.flag]: !(cur[s.flag] === true) }, req.t);
        return { status: 200, body: api.one(it!) };
      },
      { feature: s.id, kind: "write", idempotent: false, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const init: Record<string, unknown> = { [F.list]: [] as Item[], [F.error]: null };
    if (s.countField) init[F.count] = 0;
    const pending = new Map<string, number>();
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.list, 1], [F.count, 0.5], [F.error, 0]]),
      resync: () => load(true),
    });
    const setItem = (id: string, v: boolean, full = true) => (p: Record<string, unknown>) => {
      const list = ((p[F.list] as Item[]) ?? []).map((x) => (x.id === id ? { ...x, [s.flag]: v } : x));
      const o: Record<string, unknown> = { ...p, [F.list]: list };
      if (s.countField && full) o[F.count] = flagged(list, s.flag);
      return o;
    };
    async function load(bg: boolean): Promise<void> {
      const op = kit.op({ role: "load", method: "GET", url: s.listPath, key: `${s.id}.list`, background: bg });
      const r = await kit.call(op);
      if (!r.ok) return;
      const items = kit.api.unlist(r.body).items;
      const o: Record<string, unknown> = { [F.list]: items };
      if (s.countField) o[F.count] = flagged(items, s.flag);
      kit.write(S, (p) => ({ ...p, ...o }), { role: "load", op, key: `${s.id}.list` });
    }
    function flip(intent: number, idx: number): void {
      const list = (S.get()[F.list] as Item[]) ?? [];
      const item = list[idx % Math.max(1, list.length)];
      if (!item) return;
      const id = String(item.id);
      if (s.pendingGuard && (pending.get(id) ?? 0) > 0) return;
      const before = item[s.flag] === true;
      const want = !before;
      const key = `${s.id}.item.${id}`;
      kit.write(S, setItem(id, want), { role: "optimistic", intent, key });
      pending.set(id, (pending.get(id) ?? 0) + 1);
      const op =
        s.endpoint === "absolute"
          ? kit.op({ role: "set-flag", method: "PATCH", url: s.itemPath.replace(":id", id), body: { [s.flag]: want }, intent, key, idempotent: true })
          : kit.op({ role: "toggle", method: "POST", url: s.togglePath.replace(":id", id), body: {}, intent, key, idempotent: false });
      const it = env.know.getIntent(intent);
      if (it?.accidental) op.dupOf = it.repeatOf;
      kit.spawn(
        async () => {
          const r = await kit.call(op, { timeoutMs: 8000 });
          pending.set(id, (pending.get(id) ?? 1) - 1);
          if (r.ok) {
            if (s.echo) {
              const srvItem = kit.api.unone(r.body);
              const v = srvItem[s.flag] === true;
              const classify = () => (env.know.superseded(intent) && ((S.get()[F.list] as Item[]) ?? []).find((x) => x.id === id)?.[s.flag] !== v ? "stale" : undefined);
              kit.write(S, setItem(id, v, !s.countPartial), { role: "echo", op, intent, key, classify, ...(s.countPartial && s.countField ? { anomaly: "partial" } : {}) });
            }
            return;
          }
          if (s.rollback) kit.write(S, setItem(id, before, !s.countPartial), { role: "rollback", op, intent, key, ...(s.countPartial && s.countField ? { anomaly: "partial" } : {}) });
          kit.write(S, (p) => ({ ...p, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, intent, key });
          kit.shownError();
        },
        "uncaught",
        { cause: "toggle-failed", diagnosis: "failing", op },
      );
    }
    return {
      init() {
        kit.spawn(() => load(true), "swallow");
      },
      handle(step: UserStep, intent: number) {
        flip(intent, Number(step.args?.item ?? 0));
      },
      cond() {
        return [...pending.values()].some((n) => n > 0);
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.8);
    while (t < win.t1 - 800) {
      const idx = user.rng.int(0, s.items.length - 1);
      const label = `${s.label.slice(0, -1)} ${String(s.items[idx]![s.nameField])}"`;
      const c = user.click(t, label, "flip", { kind: "flip", key: `${s.id}.flip.${idx}`, mode: "accumulate" }, { args: { item: idx } });
      steps.push(...c.steps);
      // change of mind: flip the same item back quickly (a new intent)
      if (user.rng.bool(0.2)) {
        const c2 = user.click(t + user.rng.float(250, 1200), label, "flip", { kind: "flip", key: `${s.id}.flip.${idx}`, mode: "accumulate" }, { args: { item: idx }, doubleP: 0 });
        steps.push(...c2.steps);
      }
      t += user.think(0.8);
    }
    return steps;
  },
};
