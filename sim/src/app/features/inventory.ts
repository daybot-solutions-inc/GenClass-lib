// Stock-limited items: "Reserve" POSTs a reservation; the server decrements stock and answers 409 when it is gone.
// Other buyers (external events) take stock concurrently, so the stock list the client shows goes stale. Knobs:
// optimistic decrement with full rollback (guard), rollback of the lines only (defect: reserved count no longer
// equals the reservations), no rollback (defect: phantom reservation); refetch on 409 and periodic refresh
// (guards) vs keep showing stale stock (defect: users keep trying sold-out items → 409 storm); reserve button
// disabled while that item is pending; idempotency key on reservations; release (DELETE).

import type { Item } from "../../net/server.js";
import { rel, type ExternalEvent, type FeatureDef, type Relation, type UserStep } from "../feature.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface InventorySpec {
  id: string;
  api: string;
  store: string;
  f: { products: string; lines: string; count: string; busy: string; error: string };
  stockField: string;
  nameField: string;
  products: Item[];
  listPath: string;
  resPath: string;
  resItemPath: string;
  optimistic: boolean;
  rollback: "full" | "lines-only" | "none";
  on409: "refetch" | "show";
  refreshMs: number;
  addGuard: boolean;
  idem: boolean;
  buys: number;
  addLabel: string;
  removeLabel: string;
}

type Line = { id: string; productId: string; name: string; qty: number; pending?: boolean };
const sumQty = (lines: Line[]) => lines.reduce((a, l) => a + Number(l.qty ?? 0), 0);

export const inventory: FeatureDef<InventorySpec> = {
  kind: "inventory",
  make({ rng, entity, naming, id, api, clean }) {
    const stockField = rng.pick(["stock", "available", "inStock", "remaining", "qtyAvailable"]);
    const optimistic = rng.bool(0.6);
    const rollback = rng.weighted([["full", 3], ["lines-only", 2], ["none", 2]] as const);
    const on409 = rng.weighted([["refetch", 3], ["show", 3]] as const);
    const addGuard = rng.bool(0.45);
    const idem = rng.bool(0.35);
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["inventory", "stock", "shop", "reservations"]), rng.pick(["", "view", "panel"])),
      f: { products: naming.field("list", id), lines: rng.pick(["reserved", "reservations", "holds", "cartLines"]), count: rng.pick(["reservedCount", "heldCount", "badge", "itemCount"]), busy: naming.field("loading", id), error: naming.field("error", id) },
      stockField,
      nameField: entity.name,
      products: seedItems(rng, entity, rng.int(4, 9), (it) => {
        it[stockField] = rng.weighted([[0, 1], [1, 3], [2, 3], [rng.int(3, 6), 3]] as const);
      }),
      listPath: naming.route(entity.p),
      resPath: naming.route(rng.pick(["reservations", "holds", "cart-holds"])),
      resItemPath: naming.route(rng.pick(["reservations", "holds", "cart-holds"]), ":id"),
      optimistic,
      rollback: clean ? "full" : rollback,
      on409: clean ? "refetch" : on409,
      refreshMs: rng.weighted([[0, 3], [rng.int(4000, 15000), 2]] as const),
      addGuard: clean || addGuard,
      idem: clean || idem,
      buys: rng.int(2, 8),
      addLabel: `button "${rng.pick(["Reserve", "Add to cart", "Hold", "Claim"])}`,
      removeLabel: `button "${rng.pick(["Release", "Remove", "Cancel hold"])}`,
    };
  },
  pattern(s) {
    return [s.optimistic ? `optimistic:${s.rollback}` : "pessimistic", `on409:${s.on409}`, s.refreshMs ? "refresh" : "norefresh", s.addGuard ? "addguard" : "noaddguard", s.idem ? "idem" : "noidem"];
  },
  relations(s) {
    const L = `${s.store}.${s.f.lines}`;
    const C = `${s.store}.${s.f.count}`;
    const r: Relation[] = [{ fields: [C, L], desc: "reserved count equals the sum of reservation quantities", check: (st) => Number(rel.field(st, C)) === sumQty(((rel.field(st, L) as Line[]) ?? [])) }];
    return r;
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const pc = `${s.id}:products`;
    const rc = `${s.id}:reservations`;
    for (const p of s.products) db.insert(pc, p, `seed:${p[s.nameField]}`);
    srv.route("GET", s.listPath, () => ({ status: 200, body: api.list(db.list(pc)) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${pc}` });
    srv.route(
      "POST",
      s.resPath,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const prod = db.get(pc, String(b.productId));
        if (!prod) return { status: 404, body: api.error("not_found", "no such item") };
        const qty = Math.max(1, Number(b.qty ?? 1));
        const stock = Number(prod[s.stockField] ?? 0);
        if (stock < qty) return { status: 409, body: { ...(api.error("out_of_stock", "Not enough stock") as object), [s.stockField]: stock } };
        const next = db.update(pc, String(prod.id), { [s.stockField]: stock - qty }, req.t)!;
        const res = db.insert(rc, { productId: String(prod.id), qty }, `res:${String(prod.id)}`, req.t);
        return { status: 201, body: api.one({ id: res.id!, productId: String(prod.id), qty, [s.stockField]: next[s.stockField]! }) };
      },
      { feature: s.id, kind: "write", idempotent: false, resource: `c:${rc}` },
    );
    srv.route(
      "DELETE",
      s.resItemPath,
      (req) => {
        const res = db.get(rc, req.params.id!);
        if (!res) return { status: 404, body: api.error("not_found", "no such reservation") };
        const prod = db.get(pc, String(res.productId));
        db.remove(rc, String(res.id), req.t);
        const next = prod ? db.update(pc, String(prod.id), { [s.stockField]: Number(prod[s.stockField] ?? 0) + Number(res.qty ?? 1) }, req.t) : undefined;
        return { status: 200, body: api.one({ id: res.id!, [s.stockField]: next?.[s.stockField] ?? 0 }) };
      },
      { feature: s.id, kind: "write", idempotent: true, resource: `c:${rc}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const SF = s.stockField;
    const key = `${s.id}.reserve`;
    const init: Record<string, unknown> = { [F.products]: [] as Item[], [F.lines]: [] as Line[], [F.count]: 0, [F.busy]: false, [F.error]: null };
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.products, 1], [F.lines, 1], [F.count, 0.6], [F.busy, 0.1], [F.error, 0]]),
      resync: () => loadProducts(true, "resync"),
    });
    const pending = new Map<string, number>();
    const rejected = new Set<number>();
    let tmp = 0;
    let inflight = 0;
    const withStock = (pid: string, stock: number) => (p: Record<string, unknown>) => ({ ...p, [F.products]: ((p[F.products] as Item[]) ?? []).map((x) => (x.id === pid ? { ...x, [SF]: stock } : x)) });
    async function loadProducts(bg: boolean, role: string, intent?: number, attempt = 1, retryOf?: number): Promise<void> {
      const op = kit.op({ role, method: "GET", url: s.listPath, key: `${s.id}.products`, background: bg, intent, attempt, handled: true, ...(retryOf !== undefined ? { retryOf } : {}) });
      const r = await kit.call(op, { timeoutMs: 10000 });
      if (r.ok) return kit.write(S, (p) => ({ ...p, [F.products]: kit.api.unlist(r.body).items, [F.error]: null }), { role: role === "initial" ? "load" : "refetch", op, key: `${s.id}.products` });
      if (role !== "initial") return;
      // Nothing to show without the list: show the error and retry with a growing delay.
      kit.write(S, (p) => ({ ...p, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, key: `${s.id}.products` });
      if (attempt < 4) {
        await env.sleep(1500 * attempt);
        return loadProducts(bg, role, intent, attempt + 1, op.id);
      }
    }
    function reserve(intent: number, idx: number): void {
      const products = (S.get()[F.products] as Item[]) ?? [];
      const prod = products[idx % Math.max(1, products.length)];
      if (!prod) return;
      const pid = String(prod.id);
      const shown = Number(prod[SF] ?? 0);
      if (shown <= 0) return; // button disabled: sold out as far as the client knows
      if (s.addGuard && (pending.get(pid) ?? 0) > 0) return;
      const it = env.know.getIntent(intent);
      const ref = it?.accidental && it.repeatOf !== undefined ? it.repeatOf : intent;
      const dup = it?.accidental ? [...env.know.ops].reverse().find((o) => o.intent === it.repeatOf && o.role === "reserve")?.id ?? -1 : undefined;
      const tmpId = `tmp-${++tmp}`;
      const name = String(prod[s.nameField] ?? "");
      pending.set(pid, (pending.get(pid) ?? 0) + 1);
      inflight++;
      if (s.optimistic) {
        kit.write(S, (p) => {
          const lines = [...((p[F.lines] as Line[]) ?? []), { id: tmpId, productId: pid, name, qty: 1, pending: true }];
          return { ...withStock(pid, Math.max(0, shown - 1))(p), [F.lines]: lines, [F.count]: sumQty(lines), [F.busy]: true };
        }, { role: "optimistic", intent, key });
      } else kit.write(S, (p) => ({ ...p, [F.busy]: true }), { role: "busy", intent, key });
      const headers: Record<string, string> = s.idem ? { "idempotency-key": `rsv_${env.rng.fork("rsv", s.id, ref).token(12)}` } : {};
      const op = kit.op({ role: "reserve", method: "POST", url: s.resPath, body: { productId: pid, qty: 1 }, intent, key, idempotent: false, ...(dup !== undefined ? { dupOf: dup } : {}) });
      kit.spawn(async () => {
        const r = await kit.call(op, { headers, timeoutMs: 8000 });
        pending.set(pid, (pending.get(pid) ?? 1) - 1);
        inflight--;
        if (r.ok) {
          rejected.delete(idx);
          const b = kit.api.unone(r.body);
          const line: Line = { id: String(b.id), productId: pid, name, qty: Number(b.qty ?? 1) };
          kit.write(S, (p) => {
            const lines = [...((p[F.lines] as Line[]) ?? []).filter((l) => l.id !== tmpId && l.id !== line.id), line];
            return { ...withStock(pid, Number(b[SF] ?? 0))(p), [F.lines]: lines, [F.count]: sumQty(lines), [F.busy]: inflight > 0 };
          }, { role: s.optimistic ? "confirm" : "created", op, intent, key });
          return;
        }
        if (r.status === 409) rejected.add(idx);
        const stockNow = r.status === 409 ? Number((r.body as Record<string, unknown>)?.[SF] ?? 0) : shown;
        if (s.optimistic && s.rollback !== "none") {
          const full = s.rollback === "full";
          kit.write(S, (p) => {
            const lines = ((p[F.lines] as Line[]) ?? []).filter((l) => l.id !== tmpId);
            return { ...withStock(pid, stockNow)(p), [F.lines]: lines, ...(full ? { [F.count]: sumQty(lines) } : {}), [F.busy]: inflight > 0 };
          }, { role: "rollback", op, intent, key, ...(full ? {} : { anomaly: "partial" }) });
        } else kit.write(S, (p) => ({ ...p, [F.busy]: inflight > 0 }), { role: "busy", op, intent, key });
        kit.write(S, (p) => ({ ...p, [F.error]: r.status === 409 ? `${name} is sold out` : errMsg(r.status, r.outcome) }), { role: "error", op, intent, key });
        kit.shownError();
        if (r.status === 409 && s.on409 === "refetch") await loadProducts(true, "conflict-refetch", intent);
      }, "uncaught", { cause: "reserve-failed", diagnosis: "failing", op });
    }
    function release(intent: number, idx: number): void {
      const ready = ((S.get()[F.lines] as Line[]) ?? []).filter((l) => !l.pending);
      const line = ready[idx % Math.max(1, ready.length)];
      if (!line) return;
      const op = kit.op({ role: "release", method: "DELETE", url: s.resItemPath.replace(":id", encodeURIComponent(line.id)), intent, key: `${s.id}.release`, idempotent: true });
      kit.spawn(async () => {
        const r = await kit.call(op, { timeoutMs: 8000 });
        if (!r.ok && r.status !== 404) {
          kit.write(S, (p) => ({ ...p, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, intent });
          return kit.shownError();
        }
        const stock = Number(kit.api.unone(r.body)[SF] ?? NaN);
        kit.write(S, (p) => {
          const rest = ((p[F.lines] as Line[]) ?? []).filter((l) => l.id !== line.id);
          const base = Number.isFinite(stock) ? withStock(line.productId, stock)(p) : p;
          return { ...base, [F.lines]: rest, [F.count]: sumQty(rest) };
        }, { role: "confirm", op, intent, key: `${s.id}.release` });
      }, "swallow");
    }
    return {
      init() {
        kit.spawn(() => loadProducts(true, "initial"), "swallow");
        if (s.refreshMs) env.setInterval(() => kit.spawn(() => loadProducts(true, "refresh"), "swallow"), s.refreshMs);
      },
      handle(step: UserStep, intent: number) {
        const idx = Number(step.args?.product ?? 0);
        if (step.action === "release") return release(intent, idx);
        reserve(intent, idx);
      },
      cond(name) {
        if (name.startsWith("rejected:")) {
          const idx = Number(name.slice(9));
          const prod = ((S.get()[F.products] as Item[]) ?? [])[idx];
          return rejected.has(idx) && Number(prod?.[SF] ?? 0) > 0;
        }
        return inflight > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(1);
    let held = 0;
    while (t < win.t1 - 1000) {
      const idx = user.rng.int(0, s.products.length - 1);
      const target = `${s.addLabel} ${String(s.products[idx]![s.nameField])}"`;
      if (held > 0 && user.rng.bool(0.2)) {
        steps.push({ t, feature: s.id, action: "release", ui: { kind: "click", target: `${s.removeLabel}"` }, args: { product: user.rng.int(0, held - 1) }, intent: { kind: "release", key: `${s.id}.release`, mode: "accumulate", accidental: false } });
        held--;
      } else {
        const c = user.click(t, target, "reserve", { kind: "reserve", key: `${s.id}.reserve.${idx}` }, { args: { product: idx }, pendingCond: "pending" });
        steps.push(...c.steps);
        held++;
        // Intentionally take a second one.
        if (user.rng.bool(0.2)) steps.push(...user.click(t + user.rng.float(500, 2000), target, "reserve", { kind: "reserve", key: `${s.id}.reserve.${idx}` }, { args: { product: idx }, doubleP: 0 }).steps);
        // "It still shows stock, try again": only delivered if the reservation was rejected but stock is still shown.
        if (user.rng.bool(0.5)) {
          let tt = t + user.rng.float(700, 1800);
          for (let i = user.rng.int(1, 3); i > 0; i--) {
            steps.push({ ...c.steps[0]!, t: tt, intent: { ...c.steps[0]!.intent, accidental: true }, when: `rejected:${idx}`, repeatOf: -1 });
            tt += user.rng.float(400, 1200);
          }
        }
      }
      t += user.think(1.4);
    }
    return steps;
  },
  external(s, rng, win, steps) {
    const out: ExternalEvent[] = [];
    const plan: { t: number; idx: number; delta: number }[] = [];
    for (let i = 0; i < s.buys; i++) plan.push({ t: rng.float(win.t0 + 500, win.t1), idx: rng.int(0, s.products.length - 1), delta: -rng.int(1, 2) });
    // Another buyer grabs the same item just before this user clicks (the shown stock is stale).
    for (const st of steps) if (st.action === "reserve" && !st.intent.accidental && rng.bool(0.25)) plan.push({ t: Math.max(0, st.t - rng.float(150, 2500)), idx: Number(st.args?.product ?? 0), delta: -rng.int(1, 3) });
    if (rng.bool(0.3)) plan.push({ t: rng.float(win.t0, win.t1), idx: rng.int(0, s.products.length - 1), delta: rng.int(2, 5) });
    for (const { t, idx, delta } of plan) {
      out.push({
        t,
        feature: s.id,
        desc: delta < 0 ? `another buyer takes ${-delta} of item ${idx}` : `item ${idx} restocked`,
        apply(w) {
          const coll = `${s.id}:products`;
          const id = w.db.collection(coll).order[idx];
          const it = id ? w.db.get(coll, id) : undefined;
          if (!it || !id) return;
          w.db.update(coll, id, { [s.stockField]: Math.max(0, Number(it[s.stockField] ?? 0) + delta) }, w.now());
        },
      });
    }
    return out;
  },
};
