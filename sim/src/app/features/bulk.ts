// Bulk actions on a selection. The server applies the action per id and reports partial failures (locked items).
// Knobs: apply per-id results (guard) or assume everything succeeded (client diverges from server), keep derived
// per-status counts on every path or not, clear selection.

import type { Item } from "../../net/server.js";
import { rel, type FeatureDef, type UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface BulkSpec {
  id: string;
  api: string;
  store: string;
  f: { list: string; selection: string; counts: string; busy: string; error: string };
  verb: string;
  target: string;
  statuses: string[];
  nameField: string;
  items: Item[];
  listPath: string;
  bulkPath: string;
  applyAll: boolean;
  countsField: boolean;
  countsPartial: boolean;
  disable: boolean;
  label: string;
}

const countBy = (list: Item[], statuses: string[]) => {
  const o: Record<string, number> = {};
  for (const st of statuses) o[st] = 0;
  for (const it of list) o[String(it.status)] = (o[String(it.status)] ?? 0) + 1;
  return o;
};

export const bulk: FeatureDef<BulkSpec> = {
  kind: "bulk",
  make({ rng, domain, entity, naming, id, api }) {
    const statuses = entity.status.length >= 2 ? entity.status : ["open", "closed"];
    const verb = rng.pick(domain.bulk);
    return {
      id,
      api: api.name,
      store: naming.store(entity.p, rng.pick(["table", "manager", "admin", "list"])),
      f: { list: naming.field("list", id), selection: naming.field("selection", id), counts: rng.pick(["counts", "byStatus", "summary", "tally"]), busy: naming.field("loading", id), error: naming.field("error", id) },
      verb,
      target: statuses[statuses.length - 1]!,
      statuses,
      nameField: entity.name,
      items: seedItems(rng, entity, rng.int(6, 14), (it) => {
        it.status = statuses[0]!;
        it.locked = rng.bool(0.2);
      }),
      listPath: naming.route(entity.p),
      bulkPath: naming.route(entity.p, rng.pick(["bulk", "batch", `bulk-${verb}`])),
      applyAll: rng.bool(0.45),
      countsField: rng.bool(0.6),
      countsPartial: rng.bool(0.35),
      disable: rng.bool(0.5),
      label: `button "${title(verb)} selected"`,
    };
  },
  pattern(s) {
    return [s.applyAll ? "assume-all" : "per-result", s.countsField ? (s.countsPartial ? "counts-partial" : "counts") : "nocounts", s.disable ? "disable" : "nodisable"];
  },
  relations(s) {
    if (!s.countsField) return [];
    const c = `${s.store}.${s.f.counts}`;
    const l = `${s.store}.${s.f.list}`;
    return [{ fields: [c, l], desc: "per-status counts", check: (st) => JSON.stringify(rel.field(st, c)) === JSON.stringify(countBy(((rel.field(st, l) as Item[]) ?? []), s.statuses)) }];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:items`;
    for (const it of s.items) db.insert(coll, it, `seed:${it[s.nameField]}`);
    srv.route("GET", s.listPath, () => ({ status: 200, body: api.list(db.list(coll)) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
    srv.route(
      "POST",
      s.bulkPath,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const ids = Array.isArray(b.ids) ? (b.ids as string[]) : [];
        const results = ids.map((id) => {
          const it = db.get(coll, id);
          if (!it) return { id, ok: false, error: "not_found" };
          if (it.locked) return { id, ok: false, error: "locked" };
          db.update(coll, id, { status: s.target }, req.t);
          return { id, ok: true };
        });
        const failed = results.filter((r) => !r.ok).length;
        return { status: failed && failed === results.length ? 409 : failed ? 207 : 200, body: { results } };
      },
      { feature: s.id, kind: "bulk", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const init: Record<string, unknown> = { [F.list]: [] as Item[], [F.selection]: [] as string[], [F.busy]: false, [F.error]: null };
    if (s.countsField) init[F.counts] = countBy([], s.statuses);
    let busy = 0;
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.list, 1], [F.selection, 0.3], [F.counts, 0.6], [F.busy, 0.1], [F.error, 0]]),
      resync: () => load(true),
    });
    async function load(bg: boolean): Promise<void> {
      const op = kit.op({ role: "load", method: "GET", url: s.listPath, key: `${s.id}.list`, background: bg });
      const r = await kit.call(op);
      if (!r.ok) return;
      const items = kit.api.unlist(r.body).items;
      kit.write(S, (p) => ({ ...p, [F.list]: items, ...(s.countsField ? { [F.counts]: countBy(items, s.statuses) } : {}) }), { role: "load", op, key: `${s.id}.list` });
    }
    function run(intent: number): void {
      if (s.disable && busy > 0) return;
      const sel = [...((S.get()[F.selection] as string[]) ?? [])];
      if (sel.length === 0) return;
      busy++;
      const key = `${s.id}.bulk`;
      kit.write(S, (p) => ({ ...p, [F.busy]: true }), { role: "busy", intent, key });
      const it = env.know.getIntent(intent);
      const op = kit.op({ role: "bulk", method: "POST", url: s.bulkPath, body: { ids: sel, action: s.verb }, intent, key, idempotent: true, ...(it?.accidental ? { dupOf: it.repeatOf } : {}) });
      kit.spawn(
        async () => {
          const r = await kit.call(op, { timeoutMs: 10000 });
          busy--;
          const results = (((r.body ?? {}) as Record<string, unknown>).results ?? []) as { id: string; ok: boolean }[];
          if (!r.ok && r.status !== 207 && r.status !== 409) {
            kit.write(S, (p) => ({ ...p, [F.busy]: busy > 0, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, intent, key });
            kit.shownError();
            return;
          }
          const okIds = new Set(s.applyAll ? sel : results.filter((x) => x.ok).map((x) => x.id));
          const partial = s.countsField && s.countsPartial;
          const assumed = s.applyAll && results.some((x) => !x.ok);
          kit.write(
            S,
            (p) => {
              const list = ((p[F.list] as Item[]) ?? []).map((x) => (okIds.has(String(x.id)) ? { ...x, status: s.target } : x));
              const o: Record<string, unknown> = { ...p, [F.list]: list, [F.selection]: [], [F.busy]: busy > 0, [F.error]: results.some((x) => !x.ok) && !s.applyAll ? `${results.filter((x) => !x.ok).length} could not be updated` : null };
              if (s.countsField && !partial) o[F.counts] = countBy(list, s.statuses);
              return o;
            },
            { role: "bulk-result", op, intent, key, ...(partial ? { anomaly: "partial" } : assumed ? { anomaly: "shape" } : {}) },
          );
        },
        "uncaught",
        { cause: "bulk-failed", diagnosis: "failing", op },
      );
    }
    return {
      init() {
        kit.spawn(() => load(true), "swallow");
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "select") {
          const list = (S.get()[F.list] as Item[]) ?? [];
          const item = list[Number(step.args?.item ?? 0) % Math.max(1, list.length)];
          if (!item) return;
          const id = String(item.id);
          kit.write(S, (p) => {
            const sel = (p[F.selection] as string[]) ?? [];
            return { ...p, [F.selection]: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id] };
          }, { role: "input", intent, key: `${s.id}.select` });
          return;
        }
        run(intent);
      },
      cond() {
        return busy > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(1);
    while (t < win.t1 - 1500) {
      const k = user.rng.int(2, Math.min(5, s.items.length));
      const picks = user.rng.sample(Array.from({ length: s.items.length }, (_, i) => i), k);
      for (const i of picks) {
        steps.push({ t, feature: s.id, action: "select", ui: { kind: "click", target: `checkbox "${String(s.items[i]![s.nameField])}"` }, args: { item: i }, intent: { kind: "select", key: `${s.id}.select.${i}`, mode: "accumulate", accidental: false } });
        t += user.rng.float(200, 800);
      }
      const c = user.click(t, s.label, "bulk", { kind: "bulk", key: `${s.id}.bulk` }, { pendingCond: "busy" });
      steps.push(...c.steps);
      t += user.think(2);
    }
    return steps;
  },
};
