// Counters: votes / likes / quantity steppers. Increment endpoint (non-idempotent POST) or absolute PUT of the
// new value. Optimistic local count with server echo (stale echo jumps back while later clicks are in flight),
// optional echo guard (ignore echoes older than the latest local change), app retries.

import type { Item } from "../../net/server.js";
import type { FeatureDef, UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface CounterSpec {
  id: string;
  api: string;
  store: string;
  f: { list: string; error: string };
  field: string;
  nameField: string;
  items: Item[];
  listPath: string;
  incPath: string;
  itemPath: string;
  endpoint: "increment" | "absolute";
  echo: "always" | "latest-only" | "none";
  retry: "none" | "retry";
  label: string;
}

export const counter: FeatureDef<CounterSpec> = {
  kind: "counter",
  make({ rng, entity, naming, id, api }) {
    const field = naming.word(rng.pick(["votes", "likes", "upvotes", "claps", "count", "points", "rsvps", "hearts"]));
    return {
      id,
      api: api.name,
      store: naming.store(entity.p, rng.pick(["votes", "feed", "ranking", "list"])),
      f: { list: naming.field("list", id), error: naming.field("error", id) },
      field,
      nameField: entity.name,
      items: seedItems(rng, entity, rng.int(3, 8), (it) => {
        it[field] = rng.int(0, 40);
      }),
      listPath: naming.route(entity.p),
      incPath: naming.route(entity.p, ":id", rng.pick(["vote", "like", "increment", "upvote", "bump"])),
      itemPath: naming.route(entity.p, ":id"),
      endpoint: rng.weighted([["increment", 3], ["absolute", 2]] as const),
      echo: rng.weighted([["always", 3], ["latest-only", 2], ["none", 1]] as const),
      retry: rng.weighted([["none", 3], ["retry", 2]] as const),
      label: `button "${title(rng.pick(["upvote", "like", "+1", "vote", "add one"]))}"`,
    };
  },
  pattern(s) {
    return [`ep:${s.endpoint}`, `echo:${s.echo}`, `retry:${s.retry}`];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:items`;
    for (const it of s.items) db.insert(coll, it, `seed:${it[s.nameField]}`);
    srv.route("GET", s.listPath, () => ({ status: 200, body: api.list(db.list(coll)) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
    srv.route(
      "POST",
      s.incPath,
      (req) => {
        const cur = db.get(coll, req.params.id!);
        if (!cur) return { status: 404, body: api.error("not_found", "gone") };
        const it = db.update(coll, req.params.id!, { [s.field]: Number(cur[s.field] ?? 0) + 1 }, req.t);
        return { status: 200, body: api.one(it!) };
      },
      { feature: s.id, kind: "write", idempotent: false, resource: `c:${coll}` },
    );
    srv.route(
      "PUT",
      s.itemPath,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const it = db.update(coll, req.params.id!, { [s.field]: Number(b[s.field] ?? 0) }, req.t);
        return it ? { status: 200, body: api.one(it) } : { status: 404, body: api.error("not_found", "gone") };
      },
      { feature: s.id, kind: "write", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const S = env.store(s.store, s.id, { [F.list]: [] as Item[], [F.error]: null } as Record<string, unknown>, {
      weights: weightsOf([[F.list, 1], [F.error, 0]]),
      resync: () => load(true),
    });
    const localSeq = new Map<string, number>();
    const inflight = new Map<string, number>();
    const setCount = (id: string, v: number) => (p: Record<string, unknown>) => ({
      ...p,
      [F.list]: ((p[F.list] as Item[]) ?? []).map((x) => (x.id === id ? { ...x, [s.field]: v } : x)),
    });
    async function load(bg: boolean): Promise<void> {
      const op = kit.op({ role: "load", method: "GET", url: s.listPath, key: `${s.id}.list`, background: bg });
      const r = await kit.call(op);
      if (r.ok) kit.write(S, (p) => ({ ...p, [F.list]: kit.api.unlist(r.body).items }), { role: "load", op, key: `${s.id}.list` });
    }
    function bump(intent: number, idx: number): void {
      const list = (S.get()[F.list] as Item[]) ?? [];
      const item = list[idx % Math.max(1, list.length)];
      if (!item) return;
      const id = String(item.id);
      const key = `${s.id}.count.${id}`;
      const next = Number(item[s.field] ?? 0) + 1;
      const seq = (localSeq.get(id) ?? 0) + 1;
      localSeq.set(id, seq);
      kit.write(S, setCount(id, next), { role: "optimistic", intent, key });
      inflight.set(id, (inflight.get(id) ?? 0) + 1);
      const it = env.know.getIntent(intent);
      const send = async (attempt: number, retryOf?: number): Promise<void> => {
        const op =
          s.endpoint === "increment"
            ? kit.op({ role: "increment", method: "POST", url: s.incPath.replace(":id", id), body: {}, intent, key, idempotent: false, attempt, handled: s.retry === "retry", ...(retryOf !== undefined ? { retryOf } : {}) })
            : kit.op({ role: "set-count", method: "PUT", url: s.itemPath.replace(":id", id), body: { [s.field]: next }, intent, key, idempotent: true, attempt, handled: s.retry === "retry", ...(retryOf !== undefined ? { retryOf } : {}) });
        if (it?.accidental) op.dupOf = it.repeatOf;
        const r = await kit.call(op, { timeoutMs: 6000 });
        if (!r.ok && s.retry === "retry" && attempt < 3 && (r.outcome === "timeout" || r.outcome === "neterr" || r.status >= 500)) {
          await env.sleep(300 * attempt);
          return send(attempt + 1, op.id);
        }
        inflight.set(id, (inflight.get(id) ?? 1) - 1);
        if (r.ok) {
          const v = Number(kit.api.unone(r.body)[s.field] ?? next);
          if (s.echo === "always" || (s.echo === "latest-only" && localSeq.get(id) === seq)) {
            const classify = () => {
              const shown = Number(((S.get()[F.list] as Item[]) ?? []).find((x) => x.id === id)?.[s.field] ?? 0);
              return (localSeq.get(id) ?? 0) > seq && shown > v ? "stale" : undefined;
            };
            kit.write(S, setCount(id, v), { role: "echo", op, intent, key, classify });
          }
          return;
        }
        kit.write(S, (p) => ({ ...setCount(id, Number(((p[F.list] as Item[]) ?? []).find((x) => x.id === id)?.[s.field] ?? 1) - 1)(p), [F.error]: errMsg(r.status, r.outcome) }), { role: "rollback", op, intent, key });
        kit.shownError();
      };
      kit.spawn(() => send(1), "uncaught", { cause: "count-failed", diagnosis: "failing" });
    }
    return {
      init() {
        kit.spawn(() => load(true), "swallow");
      },
      handle(step: UserStep, intent: number) {
        bump(intent, Number(step.args?.item ?? 0));
      },
      cond() {
        return [...inflight.values()].some((n) => n > 0);
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.8);
    while (t < win.t1 - 800) {
      const idx = user.rng.int(0, s.items.length - 1);
      const label = `${s.label.slice(0, -1)} ${String(s.items[idx]![s.nameField])}"`;
      // Rapid intentional clicks (each a new intent), with possible accidental doubles.
      const n = user.rng.weighted([[1, 4], [2, 2], [3, 2], [5, 1]] as const);
      let tt = t;
      for (let i = 0; i < n; i++) {
        const c = user.click(tt, label, "bump", { kind: "bump", key: `${s.id}.bump.${idx}`, mode: "accumulate" }, { args: { item: idx } });
        steps.push(...c.steps);
        tt += user.rng.float(160, 650);
      }
      t = tt + user.think();
    }
    return steps;
  },
};
