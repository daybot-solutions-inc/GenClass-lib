// Drag-and-drop (or ↑/↓ nudge) reordering with a server-side canonical order. The client reorders optimistically
// and either PUTs the full order (idempotent, last writer wins) or PATCHes one item's position by a relative delta
// (non-idempotent: a retry after a committed attempt moves it twice). The server echoes the canonical order and
// publishes order changes (other users', and our own) on a live channel. Knobs: echo applied always (an older echo
// reverts a newer local reorder), only for the latest local reorder, or never; saves serialized with coalescing;
// version check on PUT (409 → refetch); pushes applied blindly (conflict with a pending local reorder), skipped
// while local saves are pending (refetch afterwards), or version-checked; retry on failure; a derived "first item"
// field kept on every path or not.

import type { Item } from "../../net/server.js";
import { rel, type ExternalEvent, type FeatureDef, type Relation, type UserStep } from "../feature.js";
import type { CallResult } from "../kit.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface ReorderSpec {
  id: string;
  api: string;
  store: string;
  f: { list: string; head: string; saving: string; error: string; version: string };
  path: string;
  orderPath: string;
  movePath: string;
  topic: string | null;
  nameField: string;
  items: Item[];
  send: "put" | "patch";
  echo: "always" | "latest" | "none";
  serialize: boolean;
  push: "blind" | "skip-pending" | "version";
  versionCheck: boolean;
  retry: boolean;
  headField: boolean;
  headOnAllPaths: boolean;
  ui: "drag" | "arrows";
  externalMoves: number;
  labels: { up: string; down: string };
}

type Obj = Record<string, unknown>;
interface OrderMsg {
  ids: string[];
  version: number;
  by: string;
}

const idsOf = (list: Item[]): string[] => list.map((x) => String(x.id));
function applyOrder(list: Item[], ids: string[]): Item[] {
  const by = new Map(list.map((x) => [String(x.id), x] as const));
  const out: Item[] = [];
  for (const id of ids) {
    const x = by.get(id);
    if (x) out.push({ ...x, position: out.length });
  }
  for (const x of list) if (!ids.includes(String(x.id))) out.push({ ...x, position: out.length });
  return out;
}

export const reorder: FeatureDef<ReorderSpec> = {
  kind: "reorder",
  make({ rng, entity, naming, id, api, clean }) {
    const g = <T>(good: T, v: T): T => (clean ? good : v);
    const send = rng.weighted([["put", 3], ["patch", 2]] as const);
    const echo = rng.weighted([["always", 4], ["latest", 3], ["none", 2]] as const);
    const push = rng.weighted([["blind", 3], ["skip-pending", 2], ["version", 2]] as const);
    const retry = rng.bool(0.4);
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["queue", "playlist", "priorities", "ranking", "order"]), entity.p),
      f: {
        list: naming.field("list", id),
        head: naming.word(rng.pick(["upNext", "topPriority", "first", "current"])),
        saving: naming.field("saving", id),
        error: naming.field("error", id),
        version: naming.field("version", id),
      },
      path: naming.route(entity.p),
      orderPath: naming.route(entity.p, rng.pick(["order", "ordering", "positions"])),
      movePath: naming.route(entity.p, ":id", rng.pick(["position", "move"])),
      topic: rng.bool(0.6) ? `${entity.p.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}/${rng.pick(["order", "reorder", "positions"])}` : null,
      nameField: entity.name,
      items: seedItems(rng, entity, rng.int(4, 9)),
      send,
      echo: g(echo === "always" ? "latest" : echo, echo),
      serialize: g(true, rng.bool(0.4)),
      push: g(push === "blind" ? "version" : push, push),
      versionCheck: rng.bool(0.35),
      // A retried relative move duplicates it when the first attempt committed.
      retry: g(send === "put" ? retry : false, retry),
      headField: rng.bool(0.55),
      headOnAllPaths: g(true, rng.bool(0.5)),
      ui: rng.weighted([["drag", 3], ["arrows", 2]] as const),
      externalMoves: rng.weighted([[0, 2], [1, 2], [3, 2], [5, 1]] as const),
      labels: { up: rng.pick(["↑", "Move up", "▲"]), down: rng.pick(["↓", "Move down", "▼"]) },
    };
  },
  pattern(s) {
    return [`send:${s.send}`, `echo:${s.echo}`, s.serialize ? "serialize" : "parallel", s.topic ? `push:${s.push}` : "nopush", s.versionCheck ? "vcheck" : "novcheck", s.retry ? "retry" : "noretry", `ui:${s.ui}`, s.headField ? (s.headOnAllPaths ? "head" : "head-partial") : "nohead"];
  },
  relations(s): Relation[] {
    if (!s.headField) return [];
    const h = `${s.store}.${s.f.head}`;
    const l = `${s.store}.${s.f.list}`;
    return [{ fields: [h, l], desc: "first-item field names the item at position 0", check: (st) => (rel.field(st, h) ?? null) === ((((rel.field(st, l) as Item[]) ?? []).find((x) => x.position === 0)?.[s.nameField] as string | undefined) ?? null) }];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:items`;
    const doc = `${s.id}:order`;
    const ids0 = s.items.map((it) => String(db.insert(coll, it, `seed:${String(it[s.nameField])}`).id));
    db.doc(doc, { ids: ids0 });
    const body = () => {
      const d = db.doc(doc);
      const ids = (d.fields.ids as string[]) ?? [];
      const items: Item[] = [];
      for (const id of ids) {
        const it = db.get(coll, id);
        if (it) items.push({ ...it, position: items.length });
      }
      return { status: 200, body: api.list(items, { version: d.version }), headers: { etag: `"${d.version}"` } };
    };
    const commit = (ids: string[], t: number) => {
      const d = db.writeDoc(doc, { ids }, t);
      if (s.topic) srv.publish(s.topic, { ids, version: d.version, by: "you" });
      return body();
    };
    srv.route("GET", s.path, () => body(), { feature: s.id, kind: "read", idempotent: true, resource: `d:${doc}` });
    srv.route(
      "PUT",
      s.orderPath,
      (req) => {
        const b = (req.body ?? {}) as Obj;
        const d = db.doc(doc);
        const cur = (d.fields.ids as string[]) ?? [];
        const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
        if (ids.length !== cur.length || !cur.every((x) => ids.includes(x))) return { status: 422, body: api.error("invalid", "ids must be a permutation of the current items") };
        if (s.versionCheck && typeof b.version === "number" && b.version !== d.version) return { status: 409, body: { error: "version_conflict", current: { ids: cur, version: d.version } } };
        return commit(ids, req.t);
      },
      { feature: s.id, kind: "write", idempotent: true, resource: `d:${doc}` },
    );
    srv.route(
      "PATCH",
      s.movePath,
      (req) => {
        const b = (req.body ?? {}) as Obj;
        const ids = [...((db.doc(doc).fields.ids as string[]) ?? [])];
        const from = ids.indexOf(req.params.id!);
        if (from < 0) return { status: 404, body: api.error("not_found", "no such item") };
        const to = Math.max(0, Math.min(ids.length - 1, from + (Number(b.delta) || 0)));
        ids.splice(from, 1);
        ids.splice(to, 0, req.params.id!);
        return commit(ids, req.t);
      },
      { feature: s.id, kind: "write", idempotent: false, resource: `d:${doc}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.order`;
    const init: Obj = { [F.list]: [] as Item[], [F.saving]: false, [F.error]: null, [F.version]: 0 };
    if (s.headField) init[F.head] = null;
    let seq = 0;
    let inflight = 0;
    let queued: { ids: string[]; intent: number; my: number } | null = null;
    let known = 0;
    let remoteAt = -1;
    let needRefetch = false;
    const opOfIntent = new Map<number, number>();
    const listOf = (p: Obj) => (p[F.list] as Item[]) ?? [];
    const withOrder = (p: Obj, list: Item[], head = true): Obj => ({ ...p, [F.list]: list, ...(s.headField && head ? { [F.head]: (list[0]?.[s.nameField] as string | undefined) ?? null } : {}) });
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.list, 1], [F.head, 0.5], [F.saving, 0.1], [F.error, 0], [F.version, 0]]),
      resync: () => refetch("resync"),
    });
    const parse = (r: CallResult) => {
      const { items, extra } = kit.api.unlist(r.body);
      const v = Number(extra.version ?? String(r.headers?.get("etag") ?? "0").replace(/"/g, "")) || 0;
      return { items, version: v };
    };
    const pendingLocal = () => inflight > 0 || queued !== null;
    async function refetch(role: string, intent?: number): Promise<void> {
      const op = kit.op({ role, method: "GET", url: s.path, key, intent, background: intent === undefined });
      const r = await kit.call(op, { timeoutMs: 8000 });
      if (!r.ok) return;
      const { items, version } = parse(r);
      known = Math.max(known, version);
      kit.write(S, (p) => ({ ...withOrder(p, items), [F.version]: version }), { role, op, intent, key });
    }
    async function save(target: { ids?: string[]; id?: string; delta?: number }, intent: number, my: number): Promise<void> {
      inflight++;
      kit.write(S, (p) => ({ ...p, [F.saving]: true }), { role: "saving", intent, key });
      const it = env.know.getIntent(intent);
      const dup = it?.accidental && it.repeatOf !== undefined ? opOfIntent.get(it.repeatOf) ?? -1 : undefined;
      let r: CallResult | null = null;
      let op: ReturnType<typeof kit.op> | null = null;
      for (let attempt = 1; ; attempt++) {
        const put = target.ids !== undefined;
        const body: Obj = put ? { ids: target.ids, ...(s.versionCheck ? { version: known } : {}) } : { delta: target.delta };
        const prev: number | undefined = op?.id;
        op = kit.op({
          role: put ? "save-order" : "move",
          method: put ? "PUT" : "PATCH",
          url: put ? s.orderPath : s.movePath.replace(":id", encodeURIComponent(target.id ?? "")),
          body,
          intent,
          key,
          idempotent: put,
          attempt,
          handled: s.retry,
          ...(prev !== undefined ? { retryOf: prev } : {}),
          ...(dup !== undefined && attempt === 1 ? { dupOf: dup } : {}),
        });
        if (attempt === 1) opOfIntent.set(intent, op.id);
        r = await kit.call(op, { timeoutMs: 8000 });
        const retriable = r.outcome === "timeout" || r.outcome === "neterr" || r.status >= 500;
        if (r.ok || !s.retry || !retriable || attempt >= 3) break;
        await env.sleep(500 * attempt);
      }
      inflight--;
      const res = r!;
      const o = op!;
      const busy = pendingLocal();
      if (res.ok) {
        const { items, version } = parse(res);
        known = Math.max(known, version);
        const apply = s.echo === "always" || (s.echo === "latest" && my === seq && !queued);
        if (apply) {
          const classify = () => {
            if (idsOf(listOf(S.get())).join() === idsOf(items).join()) return "expected";
            if (remoteAt > o.t0) return "conflict";
            return my < seq ? "stale" : undefined;
          };
          kit.write(S, (p) => ({ ...withOrder(p, items), [F.saving]: busy, [F.version]: version }), { role: "echo", op: o, intent, key, classify });
        } else kit.write(S, (p) => ({ ...p, [F.saving]: busy, [F.version]: version }), { role: "saving", op: o, intent, key });
      } else if (res.status === 409) {
        kit.write(S, (p) => ({ ...p, [F.saving]: busy }), { role: "saving", op: o, intent, key });
        await refetch("conflict-refetch", intent);
      } else {
        kit.write(S, (p) => ({ ...p, [F.saving]: busy, [F.error]: `Couldn't save order: ${errMsg(res.status, res.outcome)}` }), { role: "error", op: o, intent, key });
        kit.shownError();
        if (!busy) await refetch("refetch");
      }
      if (queued) {
        const q = queued;
        queued = null;
        return save({ ids: q.ids }, q.intent, q.my);
      }
      if (needRefetch && !pendingLocal()) {
        needRefetch = false;
        await refetch("refetch");
      }
    }
    function move(intent: number, name: string, to: number | null, delta: number): void {
      const list = listOf(S.get());
      const from = list.findIndex((x) => String(x[s.nameField]) === name);
      if (from < 0) return;
      const target = Math.max(0, Math.min(list.length - 1, to ?? from + delta));
      if (target === from) return;
      const ids = idsOf(list);
      const [moved] = ids.splice(from, 1);
      ids.splice(target, 0, moved!);
      const my = ++seq;
      kit.write(S, (p) => withOrder(p, applyOrder(listOf(p), ids)), { role: "optimistic", intent, key });
      const run = (t: { ids?: string[]; id?: string; delta?: number }) => kit.spawn(() => save(t, intent, my), "uncaught", { cause: "reorder-failed", diagnosis: "failing" });
      if (s.send === "patch") return run({ id: moved!, delta: target - from });
      if (s.serialize && inflight > 0) {
        // Coalesce: only the newest full order is sent once the current save finishes.
        queued = { ids, intent, my };
        return;
      }
      run({ ids });
    }
    function onPush(m: OrderMsg): void {
      if (!Array.isArray(m.ids)) return;
      const fromOther = m.by !== "you";
      const pend = pendingLocal();
      if (fromOther) remoteAt = env.now();
      if (s.push === "skip-pending" && pend) {
        needRefetch = true;
        return;
      }
      if (s.push === "version" && m.version <= known) return;
      const older = m.version < known;
      known = Math.max(known, m.version);
      const full = s.headOnAllPaths;
      const breaks = s.headField && !full && (applyOrder(listOf(S.get()), m.ids)[0]?.[s.nameField] ?? null) !== (S.get()[F.head] ?? null);
      const classify = () => {
        if (idsOf(listOf(S.get())).join() === m.ids.join()) return "expected";
        if (older) return "stale";
        if (pend) return fromOther ? "conflict" : "stale";
        return undefined;
      };
      kit.write(S, (p) => ({ ...withOrder(p, applyOrder(listOf(p), m.ids), full), [F.version]: m.version }), { role: "push", key, classify, ...(breaks ? { anomaly: "partial" } : {}) });
    }
    return {
      init() {
        kit.spawn(() => refetch("load"), "swallow");
        if (s.topic) env.socket(s.topic, (msg) => onPush(msg as OrderMsg));
      },
      handle(step: UserStep, intent: number) {
        const name = String(step.args?.name ?? "");
        if (step.action === "move") move(intent, name, Number(step.args?.to ?? 0), 0);
        else move(intent, name, null, Number(step.args?.delta ?? 0));
      },
      cond() {
        return pendingLocal();
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    const order = s.items.map((it) => String(it[s.nameField]));
    let t = win.t0 + user.think(0.8);
    const drag = (tt: number) => {
      const i = user.rng.int(0, order.length - 1);
      const name = order[i]!;
      let to = user.rng.int(0, order.length - 1);
      if (to === i) to = (i + 1) % order.length;
      order.splice(i, 1);
      order.splice(to, 0, name);
      steps.push({ t: tt, feature: s.id, action: "move", ui: { kind: "change", target: `listitem "${name}"`, value: `position ${to + 1}` }, args: { name, to }, intent: { kind: "reorder", key: `${s.id}.order`, mode: "replace", accidental: false } });
    };
    while (t < win.t1 - 800) {
      if (s.ui === "drag") {
        drag(t);
        // Arranging several items in a row.
        if (user.rng.bool(0.3)) {
          t += user.rng.float(300, 1200);
          drag(t);
        }
      } else {
        const i = user.rng.int(0, order.length - 1);
        const name = order[i]!;
        const up = i > 0 && (i === order.length - 1 || user.rng.bool(0.6));
        const n = user.rng.weighted([[1, 4], [2, 3], [3, 2]] as const);
        let cur = i;
        for (let k = 0; k < n; k++) {
          const c = user.click(t, `button "${up ? s.labels.up : s.labels.down} ${name}"`, "nudge", { kind: "nudge", key: `${s.id}.nudge.${name}` }, { args: { name, delta: up ? -1 : 1 } });
          steps.push(...c.steps);
          const next = Math.max(0, Math.min(order.length - 1, cur + (up ? -1 : 1)));
          order.splice(cur, 1);
          order.splice(next, 0, name);
          cur = next;
          t += user.rng.float(200, 700);
        }
      }
      t += user.think(1.2);
    }
    return steps;
  },
  external(s, rng, win, steps) {
    const out: ExternalEvent[] = [];
    const plan: { t: number; from: number; to: number }[] = [];
    for (let i = 0; i < s.externalMoves; i++) plan.push({ t: rng.float(win.t0 + 800, Math.max(win.t0 + 900, win.t1)), from: rng.int(0, 99), to: rng.int(0, 99) });
    // Someone else rearranging the same list right after this user did (competing reorders).
    for (const st of steps) if (rng.bool(0.15)) plan.push({ t: st.t + rng.float(30, 700), from: rng.int(0, 99), to: rng.int(0, 99) });
    for (const p of plan) {
      out.push({
        t: p.t,
        feature: s.id,
        desc: `another user reorders ${title(s.store)}`,
        apply(w) {
          const doc = `${s.id}:order`;
          const ids = [...((w.db.doc(doc).fields.ids as string[]) ?? [])];
          if (ids.length < 2) return;
          const from = p.from % ids.length;
          const [x] = ids.splice(from, 1);
          ids.splice(p.to % (ids.length + 1), 0, x!);
          const d = w.db.writeDoc(doc, { ids }, w.now());
          if (s.topic) w.publish(s.topic, { ids, version: d.version, by: "other" });
        },
      });
    }
    return out;
  },
};
