// List with optimistic delete and an "Undo" toast. Deferred mode hides the item and sends DELETE only when its
// timer expires (undo cancels the timer); immediate mode sends DELETE at once and undo restores the item (POST
// <item>/restore on the soft-deleted row, or re-create it from its fields). Knobs: undo waits for the in-flight
// DELETE before restoring (else the restore can reach the server first → 409, and the item ends up deleted while
// shown), the toast hides on the first undo click (else a double click restores twice: a client duplicate, and a
// server duplicate when restoring re-creates), rollback on DELETE failure vs leaving the item hidden, in-flight
// deletions filtered out of a refresh (else a refresh racing the DELETE resurrects the item), count kept on undo.

import type { Item } from "../../net/server.js";
import { rel, type ExternalEvent, type FeatureDef, type Relation, type UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface UndoSpec {
  id: string;
  api: string;
  store: string;
  f: { list: string; count: string; toast: string; error: string };
  path: string;
  itemPath: string;
  restorePath: string;
  nameField: string;
  items: Item[];
  words: string[];
  mode: "deferred" | "immediate";
  toastMs: number;
  restoreVia: "endpoint" | "recreate";
  awaitDelete: boolean;
  hideToast: boolean;
  onFail: "rollback" | "ignore";
  filterPending: boolean;
  flushPrev: boolean;
  countField: boolean;
  countOnUndo: boolean;
  adds: number;
  labels: { del: string; undo: string; refresh: string };
}

type Obj = Record<string, unknown>;

const fieldsOf = (it: Item): Item => {
  const o: Item = {};
  for (const [k, v] of Object.entries(it)) if (k !== "id" && k !== "version" && k !== "deleted") o[k] = v;
  return o;
};

export const undo: FeatureDef<UndoSpec> = {
  kind: "undo",
  make({ rng, entity, naming, id, api, clean }) {
    const g = <T>(good: T, v: T): T => (clean ? good : v);
    const onFail = rng.weighted([["rollback", 3], ["ignore", 2]] as const);
    return {
      id,
      api: api.name,
      store: naming.store(entity.p, rng.pick(["list", "manager", "inbox", ""]) || "list"),
      f: { list: naming.field("list", id), count: naming.field("total", id), toast: naming.word(rng.pick(["toast", "snackbar", "undoBar", "notice"])), error: naming.field("error", id) },
      path: naming.route(entity.p),
      itemPath: naming.route(entity.p, ":id"),
      restorePath: naming.route(entity.p, ":id", rng.pick(["restore", "undelete", "recover"])),
      nameField: entity.name,
      items: seedItems(rng, entity, rng.int(5, 12)),
      words: entity.words,
      mode: rng.weighted([["deferred", 3], ["immediate", 3]] as const),
      toastMs: rng.pick([3000, 4000, 5000, 6000, 8000]),
      restoreVia: rng.weighted([["endpoint", 3], ["recreate", 2]] as const),
      awaitDelete: g(true, rng.bool(0.45)),
      hideToast: g(true, rng.bool(0.55)),
      onFail: g("rollback", onFail),
      filterPending: g(true, rng.bool(0.5)),
      flushPrev: rng.bool(0.4),
      countField: rng.bool(0.6),
      countOnUndo: g(true, rng.bool(0.55)),
      adds: rng.weighted([[0, 3], [1, 2], [2, 1]] as const),
      labels: { del: rng.pick(["Delete", "Remove", "Archive", "🗑"]), undo: rng.pick(["Undo", "UNDO", "Restore"]), refresh: `button "${rng.pick(["Refresh", "Reload", "↻"])}"` },
    };
  },
  pattern(s) {
    const p = [`mode:${s.mode}`, `fail:${s.onFail}`, s.countField ? (s.countOnUndo ? "count" : "count-partial") : "nocount"];
    if (s.mode === "immediate") p.push(`restore:${s.restoreVia}`, s.awaitDelete ? "await-delete" : "race-delete", s.hideToast ? "toast-once" : "toast-stays", s.filterPending ? "filter-pending" : "nofilter");
    else p.push(s.flushPrev ? "flush-prev" : "per-item-timers");
    return p;
  },
  relations(s): Relation[] {
    if (!s.countField) return [];
    const c = `${s.store}.${s.f.count}`;
    const l = `${s.store}.${s.f.list}`;
    return [{ fields: [c, l], desc: "count equals number of items", check: (st) => Number(rel.field(st, c)) === ((rel.field(st, l) as unknown[]) ?? []).length }];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:items`;
    for (const it of s.items) db.insert(coll, it, `seed:${String(it[s.nameField])}`);
    srv.route("GET", s.path, () => ({ status: 200, body: api.list(db.list(coll).filter((x) => x.deleted !== true)) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
    srv.route(
      "DELETE",
      s.itemPath,
      (req) => {
        const it = db.get(coll, req.params.id!);
        if (!it || it.deleted === true) return { status: 404, body: api.error("not_found", "no such item") };
        db.update(coll, req.params.id!, { deleted: true }, req.t);
        return { status: 204 };
      },
      { feature: s.id, kind: "write", idempotent: true, resource: `c:${coll}` },
    );
    srv.route(
      "POST",
      s.restorePath,
      (req) => {
        const it = db.get(coll, req.params.id!);
        if (!it) return { status: 404, body: api.error("not_found", "no such item") };
        if (it.deleted !== true) return { status: 409, body: api.error("not_deleted", "item is not deleted") };
        return { status: 200, body: api.one(db.update(coll, req.params.id!, { deleted: false }, req.t)!) };
      },
      { feature: s.id, kind: "write", idempotent: true, resource: `c:${coll}` },
    );
    srv.route(
      "POST",
      s.path,
      (req) => {
        const b = (req.body ?? {}) as Item;
        if (!String(b[s.nameField] ?? "").trim()) return { status: 422, body: api.error("invalid", `${s.nameField} is required`) };
        const it = db.insert(coll, fieldsOf(b), String(b[s.nameField]), req.t);
        return { status: 201, body: api.one(it) };
      },
      { feature: s.id, kind: "write", idempotent: false, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const init: Obj = { [F.list]: [] as Item[], [F.toast]: null, [F.error]: null };
    if (s.countField) init[F.count] = 0;
    const listKey = `${s.id}.list`;
    const listOf = (p: Obj) => (p[F.list] as Item[]) ?? [];
    const withList = (p: Obj, list: Item[], count = true): Obj => ({ ...p, [F.list]: list, ...(s.countField && count ? { [F.count]: list.length } : {}) });
    /** Deferred deletions waiting for their timer. */
    const pending = new Map<string, { item: Item; timer: unknown; intent: number }>();
    /** Immediate deletions in flight: resolve to whether the server deleted the item. */
    const deleting = new Map<string, Promise<boolean>>();
    let toast: { item: Item; index: number } | null = null;
    let toastTimer: unknown = null;
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.list, 1], [F.count, 0.5], [F.toast, 0.2], [F.error, 0]]),
      resync: () => refresh(undefined, true),
    });
    async function refresh(intent: number | undefined, bg: boolean): Promise<void> {
      const op = kit.op({ role: bg ? "load" : "refetch", method: "GET", url: s.path, intent, key: listKey, background: bg });
      const r = await kit.call(op, { timeoutMs: 8000 });
      if (!r.ok) return;
      const skip = new Set<string>(pending.keys());
      if (s.filterPending) for (const id of deleting.keys()) skip.add(id);
      const items = kit.api.unlist(r.body).items.filter((x) => !skip.has(String(x.id)));
      const classify = () => (items.some((x) => deleting.has(String(x.id))) ? "stale" : undefined);
      kit.write(S, (p) => withList(p, items), { role: bg ? "load" : "refetch", op, intent, key: listKey, classify });
    }
    function showToast(item: Item, index: number, intent: number): void {
      toast = { item, index };
      if (toastTimer) env.clearTimeout(toastTimer);
      const name = String(item[s.nameField]);
      kit.write(S, (p) => ({ ...p, [F.toast]: { text: `${name} deleted`, action: s.labels.undo } }), { role: "toast", intent, key: `${s.id}.toast` });
      toastTimer = env.setTimeout(() => {
        toastTimer = null;
        toast = null;
        kit.write(S, (p) => ({ ...p, [F.toast]: null }), { role: "toast", key: `${s.id}.toast` });
      }, s.toastMs);
    }
    function hideToast(intent: number): void {
      toast = null;
      if (toastTimer) env.clearTimeout(toastTimer);
      toastTimer = null;
      kit.write(S, (p) => ({ ...p, [F.toast]: null }), { role: "toast", intent, key: `${s.id}.toast` });
    }
    function sendDelete(item: Item, intent: number): Promise<boolean> {
      const id = String(item.id);
      const key = `${s.id}.item.${String(item[s.nameField])}`;
      const op = kit.op({ role: "delete", method: "DELETE", url: s.itemPath.replace(":id", encodeURIComponent(id)), intent, key });
      const done = (async (): Promise<boolean> => {
        const r = await kit.call(op, { timeoutMs: 8000 });
        deleting.delete(id);
        if (r.ok || r.status === 404) return true;
        if (s.onFail === "rollback") {
          kit.write(S, (p) => (listOf(p).some((x) => x.id === item.id) ? p : withList(p, [...listOf(p), item])), { role: "rollback", op, intent, key });
          kit.write(S, (p) => ({ ...p, [F.error]: `Couldn't delete: ${errMsg(r.status, r.outcome)}` }), { role: "error", op, intent, key });
          kit.shownError();
        }
        return false;
      })();
      deleting.set(id, done);
      return done;
    }
    function del(name: string, intent: number): void {
      const list = listOf(S.get());
      const index = list.findIndex((x) => String(x[s.nameField]) === name);
      if (index < 0) return;
      const item = list[index]!;
      const id = String(item.id);
      if (s.mode === "deferred" && s.flushPrev) {
        // A new deletion commits the previous pending one right away.
        for (const [pid, p] of [...pending]) {
          env.clearTimeout(p.timer);
          pending.delete(pid);
          void sendDelete(p.item, p.intent);
        }
      }
      kit.write(S, (p) => withList(p, listOf(p).filter((x) => x.id !== item.id)), { role: "optimistic", intent, key: `${s.id}.item.${name}` });
      showToast(item, index, intent);
      if (s.mode === "deferred") {
        const timer = env.setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          void sendDelete(item, intent);
        }, s.toastMs);
        pending.set(id, { item, timer, intent });
      } else void sendDelete(item, intent);
    }
    function undoLast(intent: number): void {
      const t = toast;
      if (!t) return;
      const item = t.item;
      const id = String(item.id);
      const key = `${s.id}.item.${String(item[s.nameField])}`;
      if (s.hideToast) hideToast(intent);
      if (s.mode === "deferred") {
        const p = pending.get(id);
        if (!p) return;
        env.clearTimeout(p.timer);
        pending.delete(id);
      }
      const full = s.countOnUndo;
      kit.write(S, (p) => {
        const list = listOf(p).slice();
        list.splice(Math.min(t.index, list.length), 0, item);
        return withList(p, list, full);
      }, { role: "undo", intent, key, ...(s.countField && !full ? { anomaly: "partial" } : {}) });
      if (s.mode === "deferred") return;
      const it = env.know.getIntent(intent);
      kit.spawn(
        async () => {
          if (s.awaitDelete) {
            const d = deleting.get(id);
            // The DELETE failed: the item was never deleted, nothing to restore.
            if (d && !(await d)) return;
          }
          const op =
            s.restoreVia === "endpoint"
              ? kit.op({ role: "restore", method: "POST", url: s.restorePath.replace(":id", encodeURIComponent(id)), body: {}, intent, key, idempotent: true, ...(it?.accidental ? { dupOf: -1 } : {}) })
              : kit.op({ role: "restore", method: "POST", url: s.path, body: fieldsOf(item), intent, key, idempotent: false, ...(it?.accidental ? { dupOf: -1 } : {}) });
          const r = await kit.call(op, { timeoutMs: 8000 });
          if (r.ok) {
            const back = kit.api.unone(r.body);
            kit.write(S, (p) => ({ ...p, [F.list]: listOf(p).map((x) => (x.id === item.id ? { ...x, ...back } : x)) }), { role: "restored", op, intent, key });
            return;
          }
          kit.write(S, (p) => ({ ...p, [F.error]: `Couldn't undo: ${errMsg(r.status, r.outcome)}` }), { role: "error", op, intent, key });
          kit.shownError();
        },
        "uncaught",
        { cause: "restore-failed", diagnosis: "failing" },
      );
    }
    return {
      init() {
        kit.spawn(() => refresh(undefined, true), "swallow");
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "delete") del(String(step.args?.name ?? ""), intent);
        else if (step.action === "undo") undoLast(intent);
        else kit.spawn(() => refresh(intent, false), "uncaught", { cause: "refresh-failed", diagnosis: "failing" });
      },
      cond() {
        return toast !== null;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    const names = s.items.map((it) => String(it[s.nameField]));
    let t = win.t0 + user.think(0.8);
    while (t < win.t1 - 1000 && names.length > 1) {
      if (user.rng.bool(0.82)) {
        const i = user.rng.int(0, names.length - 1);
        const name = names[i]!;
        steps.push(...user.click(t, `button "${s.labels.del} ${name}"`, "delete", { kind: "delete", key: `${s.id}.item.${name}`, mode: "replace" }, { args: { name }, doubleP: 0 }).steps);
        if (user.rng.bool(0.35)) {
          // "Oops": undo, sometimes too late (the toast is already gone).
          const tu = t + user.rng.float(400, s.toastMs * 1.15);
          steps.push(...user.click(tu, `button "${s.labels.undo}"`, "undo", { kind: "undo", key: `${s.id}.item.${name}`, mode: "replace" }, { args: { name } }).steps);
          if (tu >= t + s.toastMs) names.splice(i, 1);
          t = tu;
        } else names.splice(i, 1);
      } else {
        steps.push(...user.click(t, s.labels.refresh, "refresh", { kind: "refresh", key: `${s.id}.refresh`, mode: "replace" }).steps);
      }
      t += user.think(1.2);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    for (let i = 0; i < s.adds; i++) {
      const name = `${rng.pick(s.words)} ${rng.pick(s.words)}`;
      out.push({
        t: rng.float(win.t0 + 1000, Math.max(win.t0 + 1100, win.t1)),
        feature: s.id,
        desc: `another user adds ${title(name)}`,
        apply(w) {
          w.db.insert(`${s.id}:items`, { [s.nameField]: name }, `ext:${i}:${name}`, w.now());
        },
      });
    }
    return out;
  },
};
