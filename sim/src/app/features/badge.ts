// Notifications list + unread badge (derived from the list; sometimes kept in a separate header store). New
// notifications arrive on a live channel; mark-read is an optimistic PATCH; mark-all-read is a POST that races with
// notifications pushed meanwhile; a periodic GET unread-count is served from a lagging read replica. Knobs:
// mark-all scope (up to the newest notification the user saw, or everything: unseen ones get marked read and the
// response clobbers them), badge recompute on every path (or skipped on the mark-read / rollback path: partial),
// poll handling (overwrite the badge with the lagging count; refetch the list when counts disagree; overwrite only
// when nothing local is pending), rollback on failure.

import type { Item } from "../../net/server.js";
import type { SimOp } from "../../oracle/knowledge.js";
import type { Rng } from "../../rng.js";
import { rel, type ExternalEvent, type FeatureDef, type UserStep } from "../feature.js";
import type { WriteMeta } from "../env.js";
import { title } from "../naming.js";
import { apiOf, errMsg, weightsOf } from "./common.js";

export interface BadgeSpec {
  id: string;
  api: string;
  store: string;
  badgeStore: string | null;
  f: { list: string; unread: string; open: string; error: string };
  paths: { list: string; item: string; readAll: string; count: string };
  topic: string;
  seed: Item[];
  lagMs: number;
  markAll: "upto" | "all";
  decrement: "recompute" | "skip-read" | "skip-rollback";
  pollApply: "refetch" | "skip-pending" | "overwrite";
  pollMs: number;
  rollback: boolean;
  labels: { bell: string; item: string; all: string };
  texts: string[];
  incoming: number;
}

function knob<T>(rng: Rng, clean: boolean | undefined, good: T, opts: readonly (readonly [T, number])[]): T {
  const v = rng.weighted(opts);
  return clean ? good : v;
}

const unreadOf = (list: Item[]) => list.filter((x) => !x.read).length;

export const badge: FeatureDef<BadgeSpec> = {
  kind: "badge",
  make({ rng, clean, domain, naming, id, api }) {
    const noun = rng.pick(["notifications", "alerts", "inbox", "activity"]);
    const texts: string[] = [];
    for (let i = 0; i < 24; i++) {
      const e = rng.pick(domain.entities);
      texts.push(`${rng.pick(domain.people)} ${rng.pick(["updated", "commented on", "assigned you", "mentioned you in", "closed"])} ${e.s} ${rng.pick(e.words)}`);
    }
    return {
      id,
      api: api.name,
      store: naming.store(noun, rng.pick(["", "panel", "feed"]) || "panel"),
      badgeStore: rng.bool(0.5) ? naming.store(rng.pick(["header", "navbar", "topbar"])) : null,
      f: { list: naming.field("list", id), unread: naming.field("unread", id), open: rng.pick(["open", "expanded", "showPanel"]), error: naming.field("error", id) },
      paths: { list: naming.route(noun), item: naming.route(noun, ":id"), readAll: naming.route(noun, rng.pick(["read-all", "mark-all-read", "ack-all"])), count: naming.route(noun, rng.pick(["unread-count", "count", "badge"])) },
      topic: `${noun}/${rng.pick(["live", "stream", "new"])}`,
      seed: texts.slice(0, rng.int(2, 6)).map((text, i) => ({ text, read: rng.bool(0.5), at: i })),
      lagMs: rng.int(800, 3500),
      markAll: knob(rng, clean, "upto", [["upto", 1], ["all", 1]] as const),
      decrement: knob(rng, clean, "recompute", [["recompute", 4], ["skip-read", 2], ["skip-rollback", 2]] as const),
      pollApply: knob(rng, clean, "refetch", [["refetch", 2], ["skip-pending", 2], ["overwrite", 3]] as const),
      pollMs: rng.int(2500, 7000),
      rollback: knob(rng, clean, true, [[true, 3], [false, 1]] as const),
      labels: { bell: `button "${title(noun)}"`, item: `listitem "${rng.pick(["Notification", "Alert", "Activity"])}"`, all: `button "${rng.pick(["Mark all as read", "Mark all read", "Clear all"])}"` },
      texts: texts.slice(6),
      incoming: rng.int(3, 10),
    };
  },
  pattern(s) {
    return [`all:${s.markAll}`, `dec:${s.decrement}`, `poll:${s.pollApply}`, s.rollback ? "rollback" : "norollback", s.badgeStore ? "badge-store" : "badge-inline"];
  },
  relations(s) {
    const B = `${s.badgeStore ?? s.store}.${s.f.unread}`;
    const L = `${s.store}.${s.f.list}`;
    return [{ fields: [B, L], desc: "badge equals number of unread notifications", check: (st) => Number(rel.field(st, B)) === unreadOf((rel.field(st, L) as Item[]) ?? []) }];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:notifications`;
    for (const n of s.seed) db.insert(coll, { text: n.text!, read: n.read!, updatedAt: 0 }, `seed:${String(n.at)}`);
    const R = { feature: s.id, resource: `c:${coll}` };
    srv.route("GET", s.paths.count, (req) => {
      // Served from a replica that lags by lagMs: reads committed after (now - lag) are not visible yet.
      const T = req.t - s.lagMs;
      const n = db.list(coll).filter((it) => (it.read ? Number(it.updatedAt) > T : Number(it.updatedAt) <= T)).length;
      return { status: 200, body: api.one({ unread: n }) };
    }, { ...R, kind: "read", idempotent: true });
    srv.route("GET", s.paths.list, () => ({ status: 200, body: api.list(db.list(coll)) }), { ...R, kind: "read", idempotent: true });
    srv.route("POST", s.paths.readAll, (req) => {
      const upTo = String(((req.body ?? {}) as Record<string, unknown>).upTo ?? "");
      const order = db.collection(coll).order;
      const last = upTo ? order.indexOf(upTo) : order.length - 1;
      let n = 0;
      for (const id of order.slice(0, (last < 0 ? order.length - 1 : last) + 1)) {
        if (db.get(coll, id)?.read) continue;
        db.update(coll, id, { read: true, updatedAt: req.t }, req.t);
        n++;
      }
      return { status: 200, body: api.one({ updated: n }) };
    }, { ...R, kind: "write", idempotent: true });
    srv.route("PATCH", s.paths.item, (req) => {
      if (!db.get(coll, req.params.id!)) return { status: 404, body: api.error("not_found", "gone") };
      return { status: 200, body: api.one(db.update(coll, req.params.id!, { read: Boolean((req.body as Record<string, unknown>)?.read), updatedAt: req.t }, req.t)) };
    }, { ...R, kind: "write", idempotent: true });
  },
  client(s, env, kit) {
    const F = s.f;
    const inlineBadge = !s.badgeStore;
    const init: Record<string, unknown> = { [F.list]: [] as Item[], [F.open]: false, [F.error]: null };
    if (inlineBadge) init[F.unread] = 0;
    const N = env.store(s.store, s.id, init, { weights: weightsOf([[F.list, 1], [F.unread, 0.5], [F.open, 0.1], [F.error, 0]]), resync: () => load(true) });
    const B = s.badgeStore ? env.store(s.badgeStore, s.id, { [F.unread]: 0 } as Record<string, unknown>, { weights: weightsOf([[F.unread, 0.5]]), resync: () => load(true) }) : null;
    let marks = 0;
    let localMarkAt = -1e9;
    const listNow = () => (N.get()[F.list] as Item[]) ?? [];
    type Meta = Omit<WriteMeta, "feature">;
    function setBadge(n: number, meta: Meta): void {
      kit.write(B ?? N, (p) => ({ ...p, [F.unread]: n }), meta);
    }
    function commit(list: Item[], meta: Meta, badgeMode: "recompute" | "skip" = "recompute"): void {
      const skip = badgeMode === "skip";
      const m: Meta = { ...meta, ...(skip ? { anomaly: "partial" } : {}) };
      kit.write(N, (p) => ({ ...p, [F.list]: list, ...(inlineBadge && !skip ? { [F.unread]: unreadOf(list) } : {}) }), m);
      if (B && !skip) setBadge(unreadOf(list), m);
    }
    async function load(bg: boolean, intent?: number): Promise<void> {
      const op = kit.op({ role: "load", method: "GET", url: s.paths.list, key: `${s.id}.feed`, background: bg, ...(intent !== undefined ? { intent } : {}) });
      const r = await kit.call(op);
      if (!r.ok) return;
      const items = kit.api.unlist(r.body).items;
      const verdict = localMarkAt > op.t0 ? "stale" : undefined;
      commit(items, { role: "refetch", op, key: `${s.id}.feed`, classify: () => verdict });
    }
    const setRead = (ids: Set<unknown>, read: boolean) => listNow().map((x) => (ids.has(x.id) ? { ...x, read } : x));
    function markOne(intent: number, idx: number): void {
      const list = listNow();
      const unread = list.filter((x) => !x.read);
      const target = (unread.length ? unread : list)[idx % Math.max(1, (unread.length ? unread : list).length)];
      if (!target || target.read) return;
      const key = `${s.id}.read.${String(target.id)}`;
      localMarkAt = env.now();
      marks++;
      commit(setRead(new Set([target.id]), true), { role: "optimistic", intent, key }, s.decrement === "skip-read" ? "skip" : "recompute");
      const op = kit.op({ role: "mark-read", method: "PATCH", url: s.paths.item.replace(":id", String(target.id)), body: { read: true }, intent, key, idempotent: true });
      kit.spawn(async () => {
        const r = await kit.call(op, { timeoutMs: 8000 });
        marks--;
        if (r.ok) return;
        if (s.rollback) commit(setRead(new Set([target.id]), false), { role: "rollback", op, intent, key }, s.decrement === "skip-rollback" ? "skip" : "recompute");
        kit.write(N, (p) => ({ ...p, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, key });
        kit.shownError();
      }, "uncaught", { cause: "mark-read-failed", diagnosis: "failing", op });
    }
    function markAll(intent: number): void {
      const seen = listNow();
      const ids = new Set(seen.filter((x) => !x.read).map((x) => x.id));
      if (!ids.size) return;
      const key = `${s.id}.read.all`;
      const it = env.know.getIntent(intent);
      localMarkAt = env.now();
      marks++;
      commit(setRead(ids, true), { role: "optimistic", intent, key });
      const body = s.markAll === "upto" ? { upTo: String(seen[seen.length - 1]!.id) } : {};
      const op = kit.op({ role: "mark-all", method: "POST", url: s.paths.readAll, body, intent, key, idempotent: true, ...(it?.accidental ? { dupOf: it.repeatOf } : {}) });
      kit.spawn(async () => {
        const r = await kit.call(op, { timeoutMs: 8000 });
        marks--;
        if (r.ok) {
          if (s.markAll === "all") {
            // The server marked everything, so the app marks everything too, including notifications pushed since.
            const clobbers = listNow().some((x) => !x.read && !ids.has(x.id));
            commit(listNow().map((x) => ({ ...x, read: true })), { role: "confirm", op, intent, key, classify: () => (clobbers ? "conflict" : undefined) });
          }
          return;
        }
        if (s.rollback) commit(setRead(ids, false), { role: "rollback", op, intent, key }, s.decrement === "skip-rollback" ? "skip" : "recompute");
        kit.write(N, (p) => ({ ...p, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, key });
        kit.shownError();
      }, "uncaught", { cause: "mark-all-failed", diagnosis: "failing", op });
    }
    async function poll(): Promise<void> {
      const op: SimOp = kit.op({ role: "poll", method: "GET", url: s.paths.count, key: `${s.id}.count`, background: true, handled: true });
      const r = await kit.call(op, { timeoutMs: 5000 });
      if (!r.ok) return;
      const n = Number((kit.api.unone(r.body) as Record<string, unknown>).unread ?? 0);
      const local = unreadOf(listNow());
      if (n === local) return;
      if (s.pollApply === "refetch") return load(true);
      if (s.pollApply === "skip-pending" && (marks > 0 || localMarkAt > op.t0)) return;
      const verdict = localMarkAt > op.t0 - s.lagMs ? "stale" : undefined;
      setBadge(n, { role: "poll-result", op, key: `${s.id}.count`, classify: () => verdict });
    }
    return {
      init() {
        kit.spawn(() => load(true), "swallow");
        env.socket(s.topic, (msg) => {
          const m = msg as Item;
          if (listNow().some((x) => x.id === m.id)) return;
          commit([...listNow(), m], { role: "push", key: `${s.id}.feed` });
        });
        env.setInterval(() => kit.spawn(poll, "swallow"), s.pollMs);
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "open") {
          const open = !N.get()[F.open];
          kit.write(N, (p) => ({ ...p, [F.open]: open }), { role: "input", intent, key: `${s.id}.open` });
          if (open) kit.spawn(() => load(false, intent), "uncaught", { cause: "load-failed", diagnosis: "failing" });
        } else if (step.action === "read") markOne(intent, Number(step.args?.idx ?? 0));
        else if (step.action === "all") markAll(intent);
      },
      cond() {
        return marks > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.8);
    while (t < win.t1 - 800) {
      const r = user.rng.next();
      if (r < 0.25) steps.push(...user.click(t, s.labels.bell, "open", { kind: "open", key: `${s.id}.open` }, { doubleP: 0 }).steps);
      else if (r < 0.7) {
        // Read a few in a row (each click marks one).
        let tt = t;
        for (let i = 0, n = user.rng.int(1, 3); i < n; i++) {
          steps.push(...user.click(tt, s.labels.item, "read", { kind: "read", key: `${s.id}.read.${i}` }, { args: { idx: user.rng.int(0, 4) } }).steps);
          tt += user.rng.float(300, 1400);
        }
        t = tt;
      } else if (r < 0.85) steps.push(...user.click(t, s.labels.all, "all", { kind: "read-all", key: `${s.id}.read.all` }, { pendingCond: "marking" }).steps);
      t += user.think(1.4);
    }
    return steps;
  },
  external(s, rng, win, steps) {
    const out: ExternalEvent[] = [];
    const times: number[] = [];
    for (let i = 0; i < s.incoming; i++) times.push(rng.float(win.t0 + 500, win.t1));
    // Notifications landing right around a mark-all click (the race the upTo bound exists for).
    for (const st of steps) if (st.action === "all" && !st.intent.accidental && rng.bool(0.5)) times.push(st.t + rng.float(10, 900));
    times.forEach((t, i) => {
      const text = s.texts[i % s.texts.length]!;
      out.push({ t, feature: s.id, desc: `notification: ${text}`, apply(w) {
        const it = w.db.insert(`${s.id}:notifications`, { text, read: false, updatedAt: w.now() }, `ext:${i}:${text}`, w.now());
        w.publish(s.topic, it);
      } });
    });
    return out;
  },
};
