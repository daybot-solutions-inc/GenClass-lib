// Offline-first list with an outbox. Mutations (create, toggle, delete) apply optimistically and go through an
// outbox; while navigator.onLine is false they wait there and are replayed when the "online" event fires (plus a
// periodic retry after network errors). When the connection drops, requests in flight fail with a network error
// even if they already reached the server. Knobs: sequential replay with temp-id remapping vs parallel replay (a
// toggle of an item created offline hits its temp id → 404, two toggles of one item race), idempotency keys on
// creates (else replaying a create that committed just before the drop duplicates it), refetch after the outbox
// drains (reconcile optimistic state) or not, network errors queued vs dropped, outbox persisted in localStorage,
// a derived done-count kept on every path or not.

import type { Item } from "../../net/server.js";
import { rel, type FeatureDef, type Relation, type UserStep } from "../feature.js";
import type { CallOpts } from "../kit.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface OfflineSpec {
  id: string;
  api: string;
  store: string;
  f: { list: string; draft: string; pending: string; offline: string; syncing: string; error: string; done: string };
  path: string;
  itemPath: string;
  nameField: string;
  flag: string;
  items: Item[];
  words: string[];
  replay: "sequential" | "parallel";
  idem: boolean;
  refetchAfter: boolean;
  queueOnNeterr: boolean;
  persist: boolean;
  storageKey: string;
  timeoutMs: number;
  retryMs: number;
  doneField: boolean;
  doneOnRefetch: boolean;
  labels: { input: string; add: string };
}

type Obj = Record<string, unknown>;
interface Mut {
  kind: "create" | "toggle" | "delete";
  target: string;
  name?: string;
  value?: boolean;
  intent: number;
  idem: string;
  tries: number;
  lastOp?: number;
  sending: boolean;
  queuedOffline: boolean;
}

export const offline: FeatureDef<OfflineSpec> = {
  kind: "offline",
  make({ rng, entity, naming, id, api, clean }) {
    const g = <T>(good: T, v: T): T => (clean ? good : v);
    const flag = naming.word(entity.flags[0] ?? rng.pick(["done", "pinned", "starred"]));
    const replay = rng.weighted([["sequential", 3], ["parallel", 3]] as const);
    return {
      id,
      api: api.name,
      store: naming.store(entity.p, rng.pick(["local", "offline", "sync", ""]) || "store"),
      f: {
        list: naming.field("list", id),
        draft: naming.field("draft", id),
        pending: naming.word(rng.pick(["pendingChanges", "unsynced", "outboxSize", "queued"])),
        offline: naming.word(rng.pick(["offline", "isOffline", "noConnection"])),
        syncing: naming.field("saving", id),
        error: naming.field("error", id),
        done: naming.word(`${flag} count`),
      },
      path: naming.route(entity.p),
      itemPath: naming.route(entity.p, ":id"),
      nameField: entity.name,
      flag,
      items: seedItems(rng, entity, rng.int(3, 8), (it) => {
        for (const fl of entity.flags) delete it[fl];
        it[flag] = rng.bool(0.3);
      }),
      words: entity.words,
      replay: g("sequential", replay),
      idem: g(true, rng.bool(0.45)),
      refetchAfter: g(true, rng.bool(0.55)),
      queueOnNeterr: g(true, rng.bool(0.6)),
      persist: rng.bool(0.5),
      storageKey: rng.pick(["outbox", "pending-mutations", "offline-queue", `${entity.p}:queue`]),
      timeoutMs: rng.weighted([[0, 2], [rng.int(4000, 10000), 2]] as const),
      retryMs: rng.int(2000, 6000),
      doneField: rng.bool(0.5),
      doneOnRefetch: g(true, rng.bool(0.5)),
      labels: { input: `input "${rng.pick(["New", "Add", "Quick add"])} ${entity.s}"`, add: `button "${rng.pick(["Add", "Save", "+"])}"` },
    };
  },
  pattern(s) {
    return [`replay:${s.replay}`, s.idem ? "idem" : "noidem", s.refetchAfter ? "reconcile" : "noreconcile", s.queueOnNeterr ? "queue:neterr" : "queue:offline-only", s.persist ? "persist" : "memory", s.doneField ? (s.doneOnRefetch ? "done" : "done-partial") : "nodone"];
  },
  relations(s): Relation[] {
    if (!s.doneField) return [];
    const c = `${s.store}.${s.f.done}`;
    const l = `${s.store}.${s.f.list}`;
    return [{ fields: [c, l], desc: `count equals items with ${s.flag} set`, check: (st) => Number(rel.field(st, c)) === ((rel.field(st, l) as Item[]) ?? []).filter((x) => x[s.flag] === true).length }];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:items`;
    for (const it of s.items) db.insert(coll, it, `seed:${String(it[s.nameField])}`);
    srv.route("GET", s.path, () => ({ status: 200, body: api.list(db.list(coll)) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
    srv.route(
      "POST",
      s.path,
      (req) => {
        const b = (req.body ?? {}) as Obj;
        const name = String(b[s.nameField] ?? "").trim();
        if (!name) return { status: 422, body: api.error("invalid", `${s.nameField} is required`) };
        const it = db.insert(coll, { [s.nameField]: name, [s.flag]: b[s.flag] === true }, name, req.t);
        return { status: 201, body: api.one(it) };
      },
      { feature: s.id, kind: "write", idempotent: false, resource: `c:${coll}` },
    );
    srv.route(
      "PATCH",
      s.itemPath,
      (req) => {
        const b = (req.body ?? {}) as Obj;
        if (!db.get(coll, req.params.id!)) return { status: 404, body: api.error("not_found", "no such item") };
        return { status: 200, body: api.one(db.update(coll, req.params.id!, { [s.flag]: b[s.flag] === true }, req.t)!) };
      },
      { feature: s.id, kind: "write", idempotent: true, resource: `c:${coll}` },
    );
    srv.route(
      "DELETE",
      s.itemPath,
      (req) => (db.remove(coll, req.params.id!, req.t) ? { status: 204 } : { status: 404, body: api.error("not_found", "no such item") }),
      { feature: s.id, kind: "write", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const init: Obj = { [F.list]: [] as Item[], [F.draft]: "", [F.pending]: 0, [F.offline]: false, [F.syncing]: false, [F.error]: null };
    if (s.doneField) init[F.done] = 0;
    const key = `${s.id}.items`;
    const outbox: Mut[] = [];
    const idMap = new Map<string, string>();
    const inflight = new Map<Mut, AbortController>();
    let tmpN = 0;
    let mutN = 0;
    let draining = false;
    let retryTimer: unknown = null;
    let reconcile = false;
    const listOf = (p: Obj) => (p[F.list] as Item[]) ?? [];
    const doneOf = (list: Item[]): Obj => (s.doneField ? { [F.done]: list.filter((x) => x[s.flag] === true).length } : {});
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.list, 1], [F.draft, 0.3], [F.pending, 0.3], [F.offline, 0.2], [F.syncing, 0.1], [F.error, 0], [F.done, 0.5]]),
      resync: () => refetch(true),
    });
    function persist(): void {
      if (!s.persist) return;
      try {
        env.G.localStorage.setItem(s.storageKey, JSON.stringify(outbox.map((m) => ({ kind: m.kind, target: m.target, name: m.name, value: m.value, idem: m.idem }))));
      } catch {
        /* quota / private mode */
      }
    }
    async function refetch(bg: boolean): Promise<void> {
      const op = kit.op({ role: "refetch", method: "GET", url: s.path, key, background: bg });
      const r = await kit.call(op, { timeoutMs: 8000 });
      // Never clobber local changes still waiting in the outbox.
      if (!r.ok || outbox.length) return;
      const items = kit.api.unlist(r.body).items;
      const full = s.doneOnRefetch;
      const breaks = s.doneField && !full && Number(S.get()[F.done] ?? 0) !== items.filter((x) => x[s.flag] === true).length;
      kit.write(S, (p) => ({ ...p, [F.list]: items, ...(full ? doneOf(items) : {}) }), { role: "refetch", op, key, ...(breaks ? { anomaly: "partial" } : {}) });
    }
    function scheduleRetry(): void {
      if (retryTimer || !outbox.length || !env.online) return;
      retryTimer = env.setTimeout(() => {
        retryTimer = null;
        kick();
      }, s.retryMs);
    }
    function settled(): void {
      if (outbox.length || draining || outbox.some((m) => m.sending)) return;
      kit.write(S, (p) => ({ ...p, [F.syncing]: false, [F.pending]: 0 }), { role: "synced", key });
      if (s.refetchAfter && reconcile) {
        reconcile = false;
        kit.spawn(() => refetch(true), "swallow");
      }
    }
    function kick(): void {
      if (!env.online || !outbox.length) return;
      if (s.replay === "sequential") {
        if (!draining) kit.spawn(drain, "swallow");
        return;
      }
      // Defect: every queued change is sent at once (no ordering, temp ids not yet remapped).
      for (const m of outbox) if (!m.sending) kit.spawn(() => sendOne(m).then(settled), "swallow");
    }
    async function drain(): Promise<void> {
      draining = true;
      kit.write(S, (p) => ({ ...p, [F.syncing]: true }), { role: "syncing", key });
      while (outbox.length && env.online) {
        const res = await sendOne(outbox[0]!);
        if (res === "retry") break;
      }
      draining = false;
      settled();
    }
    async function sendOne(m: Mut): Promise<"done" | "retry"> {
      m.sending = true;
      const target = idMap.get(m.target) ?? m.target;
      const replay = m.queuedOffline || m.tries > 0;
      if (replay) reconcile = true;
      const url = m.kind === "create" ? s.path : s.itemPath.replace(":id", encodeURIComponent(target));
      const method = m.kind === "create" ? "POST" : m.kind === "toggle" ? "PATCH" : "DELETE";
      const body = m.kind === "create" ? { [s.nameField]: m.name, [s.flag]: false } : m.kind === "toggle" ? { [s.flag]: m.value } : undefined;
      const op = kit.op({
        role: replay ? "replay" : m.kind,
        method,
        url,
        ...(body ? { body } : {}),
        intent: m.intent,
        key,
        idempotent: m.kind !== "create",
        attempt: m.tries + 1,
        handled: true,
        ...(m.lastOp !== undefined ? { retryOf: m.lastOp } : {}),
      });
      m.lastOp = op.id;
      m.tries++;
      const ctl = new AbortController();
      inflight.set(m, ctl);
      const opts: CallOpts = { signal: ctl.signal };
      if (m.kind === "create" && s.idem) opts.headers = { "idempotency-key": m.idem };
      if (s.timeoutMs) opts.timeoutMs = s.timeoutMs;
      const r = await kit.call(op, opts);
      inflight.delete(m);
      m.sending = false;
      const netFail = r.outcome === "neterr" || r.outcome === "timeout" || r.outcome === "aborted";
      const serverBusy = r.status >= 500 || r.status === 429;
      if ((netFail && (!env.online || s.queueOnNeterr)) || (serverBusy && m.tries < 4)) {
        if (!env.online) m.queuedOffline = true;
        scheduleRetry();
        return "retry";
      }
      const i = outbox.indexOf(m);
      if (i >= 0) outbox.splice(i, 1);
      persist();
      const n = outbox.length;
      if (r.ok && m.kind === "create") {
        const it = kit.api.unone(r.body);
        const real = String(it.id ?? "");
        idMap.set(m.target, real);
        kit.write(S, (p) => ({ ...p, [F.list]: listOf(p).map((x) => (x.id === m.target ? { ...it, ...x, id: real, pending: false } : x)), [F.pending]: n }), { role: "created", op, intent: m.intent, key });
        return "done";
      }
      if (r.ok || (m.kind === "delete" && r.status === 404)) {
        kit.write(S, (p) => ({ ...p, [F.list]: listOf(p).map((x) => (x.id === m.target || x.id === target ? { ...x, pending: false } : x)), [F.pending]: n }), { role: "synced", op, intent: m.intent, key });
        return "done";
      }
      // Rejected for good (or a network error this variant does not queue): the optimistic change stays on screen.
      kit.write(S, (p) => ({ ...p, [F.pending]: n, [F.error]: `Couldn't sync: ${errMsg(r.status, r.outcome)}` }), { role: "error", op, intent: m.intent, key });
      kit.shownError();
      reconcile = true;
      return "done";
    }
    function enqueue(m: Mut, optimistic: (p: Obj) => Obj): void {
      outbox.push(m);
      persist();
      const n = outbox.length;
      kit.write(S, (p) => ({ ...optimistic(p), [F.pending]: n }), { role: "optimistic", intent: m.intent, key });
      kick();
    }
    return {
      init() {
        kit.spawn(async () => {
          try {
            env.G.localStorage.getItem(s.storageKey);
          } catch {
            /* ignore */
          }
          const op = kit.op({ role: "load", method: "GET", url: s.path, key, background: true });
          const r = await kit.call(op, { timeoutMs: 8000 });
          if (!r.ok) return;
          const items = kit.api.unlist(r.body).items;
          kit.write(S, (p) => ({ ...p, [F.list]: items, ...doneOf(items) }), { role: "load", op, key });
        }, "swallow");
        env.on("offline", () => {
          kit.write(S, (p) => ({ ...p, [F.offline]: true }), { role: "connectivity", key: `${s.id}.net` });
          // The connection dropped: requests in flight fail like a browser fetch would.
          for (const ctl of inflight.values()) ctl.abort(new TypeError("Failed to fetch"));
        });
        env.on("online", () => {
          kit.write(S, (p) => ({ ...p, [F.offline]: false }), { role: "connectivity", key: `${s.id}.net` });
          kick();
        });
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "type") {
          const v = String(step.ui.value ?? "");
          kit.write(S, (p) => ({ ...p, [F.draft]: v }), { role: "input", intent, key: `${s.id}.draft` });
          return;
        }
        const base = { intent, idem: `k${env.rng.fork("idem", s.id, ++mutN).token(10)}`, tries: 0, sending: false, queuedOffline: !env.online };
        if (step.action === "add") {
          const name = String(S.get()[F.draft] ?? "").trim();
          if (!name) return;
          const tmp = `tmp-${++tmpN}`;
          const row: Item = { id: tmp, [s.nameField]: name, [s.flag]: false, pending: true };
          enqueue({ ...base, kind: "create", target: tmp, name }, (p) => ({ ...p, [F.list]: [...listOf(p), row], [F.draft]: "" }));
          return;
        }
        const name = String(step.args?.name ?? "");
        const item = listOf(S.get()).find((x) => String(x[s.nameField]) === name);
        if (!item) return;
        const id = String(item.id);
        if (step.action === "toggle") {
          const value = item[s.flag] !== true;
          enqueue({ ...base, kind: "toggle", target: id, value }, (p) => {
            const list = listOf(p).map((x) => (x.id === id ? { ...x, [s.flag]: value, pending: true } : x));
            return { ...p, [F.list]: list, ...doneOf(list) };
          });
        } else if (step.action === "delete") {
          enqueue({ ...base, kind: "delete", target: id }, (p) => {
            const list = listOf(p).filter((x) => x.id !== id);
            return { ...p, [F.list]: list, ...doneOf(list) };
          });
        }
      },
      cond() {
        return outbox.length > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    const names = s.items.map((it) => String(it[s.nameField]));
    let t = win.t0 + user.think(0.6);
    while (t < win.t1 - 1000) {
      const r = user.rng.next();
      if (r < 0.35 || names.length < 2) {
        const text = `${user.rng.pick(s.words)}${user.rng.bool(0.4) ? " " + user.rng.pick(s.words) : ""}`;
        const typed = user.type(t, "", text, s.labels.input, "type", `${s.id}.draft`);
        steps.push(...typed.steps);
        t = typed.t + user.rng.float(100, 500);
        const viaEnter = user.rng.bool(0.6);
        const c = user.click(t, viaEnter ? s.labels.input : s.labels.add, "add", { kind: "create", key: `${s.id}.create` }, viaEnter ? { kind: "key", value: "Enter", doubleP: Math.min(0.05, user.p.doubleClickP) } : {});
        steps.push(...c.steps);
        names.push(text);
      } else if (r < 0.82) {
        const name = user.rng.pick(names);
        const c = user.click(t, `checkbox "${name}"`, "toggle", { kind: "toggle", key: `${s.id}.item.${name}`, mode: "replace" }, { args: { name } });
        steps.push(...c.steps);
        // Quick correction: flip it back.
        if (user.rng.bool(0.15)) steps.push({ ...c.steps[0]!, t: t + user.rng.float(300, 1200) });
      } else {
        const i = user.rng.int(0, names.length - 1);
        const name = names[i]!;
        names.splice(i, 1);
        steps.push(...user.click(t, `button "Delete ${name}"`, "delete", { kind: "delete", key: `${s.id}.item.${name}`, mode: "replace" }, { args: { name }, doubleP: 0 }).steps);
      }
      t += user.think(0.8);
    }
    return steps;
  },
  env(_s, rng, win) {
    const out: { start: number; end: number }[] = [];
    const n = rng.weighted([[1, 3], [2, 2]] as const);
    let lo = win.t0;
    for (let i = 0; i < n; i++) {
      const len = Math.min(rng.float(2000, 10000), Math.max(2000, (win.t1 - win.t0) * 0.6));
      const room = win.t1 - lo - len;
      if (room <= 0) break;
      const start = lo + rng.float(0, n > 1 && i === 0 ? room * 0.5 : room);
      out.push({ start, end: start + len });
      lo = start + len + 1500;
    }
    return { offline: out };
  },
};
