// Kanban-style board with optimistic moves and a live update channel. Other users move cards (server-side) and
// the server pushes events {card, column, version, seq}. Knobs: push application (blind = conflicts with pending
// local moves and out-of-order events; version check; seq check), echo of the moved card, rollback on failure,
// per-column counts maintained by the app.

import type { Item } from "../../net/server.js";
import { rel, type ExternalEvent, type FeatureDef, type UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface BoardSpec {
  id: string;
  api: string;
  store: string;
  f: { cards: string; counts: string; error: string };
  col: string;
  columns: string[];
  nameField: string;
  cards: Item[];
  listPath: string;
  cardPath: string;
  topic: string;
  push: "blind" | "version" | "skip-pending";
  echo: boolean;
  rollback: boolean;
  countsField: boolean;
  countsOnPush: boolean;
  versionInBody: boolean;
  label: string;
  externalMoves: number;
}

const countsOf = (cards: Item[], col: string, columns: string[]) => {
  const o: Record<string, number> = {};
  for (const c of columns) o[c] = 0;
  for (const c of cards) o[String(c[col])] = (o[String(c[col])] ?? 0) + 1;
  return o;
};

export const board: FeatureDef<BoardSpec> = {
  kind: "board",
  make({ rng, entity, naming, id, api }) {
    const columns = entity.status.length >= 3 ? entity.status.slice(0, 4) : ["todo", "doing", "done"];
    const col = naming.word(rng.pick(["column", "status", "stage", "lane"]));
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["board", "pipeline", "kanban", "lanes"])),
      f: { cards: naming.field("list", id), counts: rng.pick(["counts", "columnCounts", "tally", "perColumn"]), error: naming.field("error", id) },
      col,
      columns,
      nameField: entity.name,
      cards: seedItems(rng, entity, rng.int(5, 12), (it) => {
        it[col] = rng.pick(columns);
        delete it.status;
      }),
      listPath: naming.route(entity.p),
      cardPath: naming.route(entity.p, ":id"),
      topic: `${id}:board`,
      push: rng.weighted([["blind", 4], ["version", 3], ["skip-pending", 2]] as const),
      echo: rng.bool(0.5),
      rollback: rng.bool(0.6),
      countsField: rng.bool(0.6),
      countsOnPush: rng.bool(0.55),
      versionInBody: rng.bool(0.3),
      label: `${rng.pick(["card", "tile", "item", "row", "ticket"])} "${title(entity.s)}"`,
      externalMoves: rng.int(1, 5),
    };
  },
  pattern(s) {
    return [`push:${s.push}`, s.echo ? "echo" : "noecho", s.rollback ? "rollback" : "norollback", s.countsField ? (s.countsOnPush ? "counts" : "counts-partial") : "nocounts", s.versionInBody ? "vcheck" : "novcheck"];
  },
  relations(s) {
    if (!s.countsField) return [];
    const c = `${s.store}.${s.f.counts}`;
    const l = `${s.store}.${s.f.cards}`;
    return [{ fields: [c, l], desc: "per-column counts", check: (st) => JSON.stringify(rel.field(st, c)) === JSON.stringify(countsOf(((rel.field(st, l) as Item[]) ?? []), s.col, s.columns)) }];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:cards`;
    for (const c of s.cards) db.insert(coll, c, `seed:${c[s.nameField]}`);
    srv.route("GET", s.listPath, () => ({ status: 200, body: api.list(db.list(coll)) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
    srv.route(
      "PATCH",
      s.cardPath,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const cur = db.get(coll, req.params.id!);
        if (!cur) return { status: 404, body: api.error("not_found", "gone") };
        if (s.versionInBody && typeof b.version === "number" && b.version !== cur.version) return { status: 409, body: { error: "conflict", current: cur } };
        const it = db.update(coll, req.params.id!, { [s.col]: String(b[s.col]) }, req.t)!;
        srv.publish(s.topic, { id: it.id, [s.col]: it[s.col], version: it.version, by: "you" });
        return { status: 200, body: api.one(it) };
      },
      { feature: s.id, kind: "write", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const init: Record<string, unknown> = { [F.cards]: [] as Item[], [F.error]: null };
    if (s.countsField) init[F.counts] = countsOf([], s.col, s.columns);
    const pending = new Map<string, number>();
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.cards, 1], [F.counts, 0.5], [F.error, 0]]),
      resync: () => load(true),
    });
    const setCard = (id: string, column: string, version: number | undefined, counts: boolean) => (p: Record<string, unknown>) => {
      const cards = ((p[F.cards] as Item[]) ?? []).map((c) => (c.id === id ? { ...c, [s.col]: column, ...(version !== undefined ? { version } : {}) } : c));
      const o: Record<string, unknown> = { ...p, [F.cards]: cards };
      if (s.countsField && counts) o[F.counts] = countsOf(cards, s.col, s.columns);
      return o;
    };
    async function load(bg: boolean): Promise<void> {
      const op = kit.op({ role: "load", method: "GET", url: s.listPath, key: `${s.id}.cards`, background: bg });
      const r = await kit.call(op);
      if (!r.ok) return;
      const cards = kit.api.unlist(r.body).items;
      const o: Record<string, unknown> = { [F.cards]: cards };
      if (s.countsField) o[F.counts] = countsOf(cards, s.col, s.columns);
      kit.write(S, (p) => ({ ...p, ...o }), { role: "load", op, key: `${s.id}.cards` });
    }
    function move(intent: number, idx: number, column: string): void {
      const cards = (S.get()[F.cards] as Item[]) ?? [];
      const card = cards[idx % Math.max(1, cards.length)];
      if (!card) return;
      const id = String(card.id);
      const from = String(card[s.col]);
      if (from === column) return;
      const key = `${s.id}.card.${id}`;
      kit.write(S, setCard(id, column, undefined, true), { role: "optimistic", intent, key });
      pending.set(id, (pending.get(id) ?? 0) + 1);
      const body: Record<string, unknown> = { [s.col]: column };
      if (s.versionInBody) body.version = card.version;
      const op = kit.op({ role: "move", method: "PATCH", url: s.cardPath.replace(":id", id), body, intent, key, idempotent: true });
      kit.spawn(
        async () => {
          const r = await kit.call(op, { timeoutMs: 8000 });
          pending.set(id, (pending.get(id) ?? 1) - 1);
          if (r.ok) {
            if (s.echo) {
              const it = kit.api.unone(r.body);
              const classify = () => (env.know.superseded(intent) && String(((S.get()[F.cards] as Item[]) ?? []).find((c) => c.id === id)?.[s.col]) !== String(it[s.col]) ? "stale" : undefined);
              kit.write(S, setCard(id, String(it[s.col]), Number(it.version), true), { role: "echo", op, intent, key, classify });
            }
            return;
          }
          if (r.status === 409) {
            const cur = ((r.body as Record<string, unknown>)?.current ?? {}) as Item;
            kit.write(S, setCard(id, String(cur[s.col] ?? from), Number(cur.version), true), { role: "conflict-refetch", op, intent, key });
            return;
          }
          if (s.rollback) kit.write(S, setCard(id, from, undefined, true), { role: "rollback", op, intent, key });
          kit.write(S, (p) => ({ ...p, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, intent, key });
          kit.shownError();
        },
        "uncaught",
        { cause: "move-failed", diagnosis: "failing", op },
      );
    }
    return {
      init() {
        kit.spawn(() => load(true), "swallow");
        env.subscribe(s.topic, (msg) => {
          const m = msg as Record<string, unknown>;
          const id = String(m.id);
          const key = `${s.id}.card.${id}`;
          const local = ((S.get()[F.cards] as Item[]) ?? []).find((c) => c.id === id);
          if (!local) return;
          const hasPending = (pending.get(id) ?? 0) > 0;
          if (s.push === "skip-pending" && hasPending) return;
          if (s.push === "version" && typeof local.version === "number" && Number(m.version) <= local.version) return;
          const fromOther = m.by !== "you";
          const latestLocal = env.know.latestIntent(key);
          const classify = () => {
            const cur = ((S.get()[F.cards] as Item[]) ?? []).find((c) => c.id === id);
            if (cur && typeof cur.version === "number" && Number(m.version) < cur.version) return "stale";
            if (fromOther && hasPending) return "conflict";
            if (!fromOther && latestLocal && String(m[s.col]) !== String(cur?.[s.col])) return "stale";
            return undefined;
          };
          kit.write(S, setCard(id, String(m[s.col]), Number(m.version), s.countsOnPush), { role: "push", key, classify, ...(s.countsField && !s.countsOnPush ? { anomaly: "partial" } : {}) });
        });
      },
      handle(step: UserStep, intent: number) {
        move(intent, Number(step.args?.card ?? 0), String(step.args?.to ?? s.columns[0]));
      },
      cond() {
        return [...pending.values()].some((n) => n > 0);
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.8);
    const cols = s.cards.map((c) => String(c[s.col]));
    while (t < win.t1 - 800) {
      const idx = user.rng.int(0, s.cards.length - 1);
      const to = user.rng.pick(s.columns.filter((c) => c !== cols[idx]));
      cols[idx] = to;
      const label = `${s.label.slice(0, -1)} ${String(s.cards[idx]![s.nameField])}"`;
      steps.push({ t, feature: s.id, action: "move", ui: { kind: "change", target: label, value: to }, args: { card: idx, to }, intent: { kind: "move", key: `${s.id}.move.${idx}`, mode: "replace", accidental: false } });
      if (user.rng.bool(0.2)) {
        // quick correction: move it again
        const to2 = user.rng.pick(s.columns.filter((c) => c !== to));
        cols[idx] = to2;
        steps.push({ t: t + user.rng.float(300, 1500), feature: s.id, action: "move", ui: { kind: "change", target: label, value: to2 }, args: { card: idx, to: to2 }, intent: { kind: "move", key: `${s.id}.move.${idx}`, mode: "replace", accidental: false } });
      }
      t += user.think();
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    for (let i = 0; i < s.externalMoves; i++) {
      const t = rng.float(win.t0 + 500, win.t1);
      const idx = rng.int(0, s.cards.length - 1);
      const to = rng.pick(s.columns);
      out.push({
        t,
        feature: s.id,
        desc: `another user moves card ${idx}`,
        apply(w) {
          const coll = `${s.id}:cards`;
          const ids = w.db.collection(coll).order;
          const id = ids[idx % Math.max(1, ids.length)];
          if (!id) return;
          const it = w.db.update(coll, id, { [s.col]: to }, w.now());
          if (it) w.publish(s.topic, { id, [s.col]: to, version: it.version, by: "other" });
        },
      });
    }
    return out;
  },
};
