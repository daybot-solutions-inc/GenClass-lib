// Multi-step flow with compensation (a client-side saga): reserve → charge → confirm, with domain-flavoured step
// names, each one request. A failure at step k compensates the completed steps in reverse (release the hold,
// refund the payment) or leaves the server half-done (held stock never released, a payment without an order).
// The charge is non-idempotent: retried with the same idempotency key (guard) or without one after a timeout
// (double charge). Cancelling mid-saga aborts the in-flight step and compensates, or only sets a flag the saga
// checks between steps (the step in flight still lands, nothing is undone). Client: per-step statuses and a derived
// completed-steps count (relation), kept on every path or skipped on the compensation path (partial update).

import type { Item } from "../../net/server.js";
import type { SimOp } from "../../oracle/knowledge.js";
import { u01, type Rng } from "../../rng.js";
import { rel, round2, type ExternalEvent, type FeatureDef, type UserStep } from "../feature.js";
import type { CallResult, OpInit } from "../kit.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

const VOCAB: [string, string, string, string, string][] = [
  ["reserve", "charge", "confirm", "release", "refund"],
  ["hold", "pay", "book", "unhold", "refund"],
  ["lock", "authorize", "commit", "unlock", "void"],
  ["allocate", "bill", "finalize", "deallocate", "credit"],
];

export interface SagaSpec {
  id: string;
  api: string;
  store: string;
  coll: string;
  f: { list: string; steps: string; done: string; running: string; error: string; result: string };
  names: [string, string, string];
  undoNames: [string, string];
  paths: { products: string; hold: string; release: string; pay: string; refund: string; confirm: string };
  nameField: string;
  priceField: string;
  products: Item[];
  salt: string;
  declineP: number;
  compensate: boolean;
  deriveOnUndo: boolean;
  charge: { idem: boolean; retry: "none" | "same-key" | "no-key"; timeoutMs: number };
  disable: boolean;
  cancel: "abort" | "flag";
  labels: { start: string; cancel: string };
  externalBuys: number;
}

function knob<T>(rng: Rng, clean: boolean | undefined, good: T, opts: readonly (readonly [T, number])[]): T {
  const v = rng.weighted(opts);
  return clean ? good : v;
}

export const saga: FeatureDef<SagaSpec> = {
  kind: "saga",
  make({ rng, clean, entity, naming, id, api }) {
    const v = rng.pick(VOCAB);
    const holds = rng.pick(["reservations", "holds", "allocations"]);
    const pays = rng.pick(["payments", "charges", "transactions"]);
    const priceField = entity.nums.find((n) => /price|amount|fare|cost|rate|fee|total|premium|value|bid/.test(n[0]))?.[0] ?? "price";
    const retry = knob(rng, clean, "same-key", [["none", 3], ["same-key", 2], ["no-key", 3]] as const);
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["checkout", "booking", "flow", "purchase"]), rng.pick(["", "state", "saga"])),
      coll: entity.p,
      f: { list: naming.field("list", id), steps: rng.pick(["steps", "stages", "progress"]), done: rng.pick(["completed", "doneCount", "stepsDone"]), running: naming.field("submitting", id), error: naming.field("error", id), result: rng.pick(["orderId", "confirmation", "receipt", "bookingRef"]) },
      names: [v[0], v[1], v[2]],
      undoNames: [v[3], v[4]],
      paths: {
        products: naming.route(entity.p),
        hold: naming.route(entity.p, ":id", v[0]),
        release: naming.route(holds, ":id"),
        pay: naming.route(pays),
        refund: naming.route(pays, ":id", v[4]),
        confirm: naming.route(holds, ":id", v[2]),
      },
      nameField: entity.name,
      priceField,
      products: seedItems(rng, entity, rng.int(3, 8), (it) => {
        if (!(priceField in it)) it[priceField] = round2(rng.float(5, 300));
        it.available = rng.weighted([[0, 1], [1, 2], [rng.int(2, 9), 5]] as const);
      }),
      salt: rng.token(8),
      declineP: rng.weighted([[0, 2], [0.08, 3], [0.2, 1]] as const),
      compensate: knob(rng, clean, true, [[true, 3], [false, 2]] as const),
      deriveOnUndo: knob(rng, clean, true, [[true, 3], [false, 2]] as const),
      charge: { idem: retry === "same-key" || (!clean && rng.bool(0.3)) || !!clean, retry, timeoutMs: rng.int(2000, 6000) },
      disable: knob(rng, clean, true, [[true, 1], [false, 1]] as const),
      cancel: knob(rng, clean, "abort", [["abort", 1], ["flag", 1]] as const),
      labels: { start: `button "${title(entity.create)} ${entity.s}"`, cancel: `button "${rng.pick(["Cancel", "Stop", "Abort"])}"` },
      externalBuys: rng.int(0, 4),
    };
  },
  pattern(s) {
    return [s.compensate ? "compensate" : "nocompensate", s.deriveOnUndo ? "derive" : "derive-partial", s.charge.idem ? "idem" : "noidem", `retry:${s.charge.retry}`, s.disable ? "disable" : "nodisable", `cancel:${s.cancel}`];
  },
  relations(s) {
    const D = `${s.store}.${s.f.done}`;
    const St = `${s.store}.${s.f.steps}`;
    return [{ fields: [D, St], desc: "completed equals number of done steps", check: (st) => Number(rel.field(st, D)) === Object.values((rel.field(st, St) as Record<string, string>) ?? {}).filter((x) => x === "done").length }];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const pc = `${s.id}:${s.coll}`;
    const hc = `${s.id}:holds`;
    const payc = `${s.id}:payments`;
    for (const p of s.products) db.insert(pc, p, `seed:${p[s.nameField]}`);
    const W = { feature: s.id, kind: "write" as const };
    srv.route("GET", s.paths.products, () => ({ status: 200, body: api.list(db.list(pc)) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${pc}` });
    srv.route("POST", s.paths.hold, (req) => {
      const prod = db.get(pc, req.params.id!);
      if (!prod) return { status: 404, body: api.error("not_found", "no such item") };
      const qty = Number((req.body as Record<string, unknown>)?.qty ?? 1);
      if (Number(prod.available ?? 0) < qty) return { status: 409, body: api.error("sold_out", "not enough left") };
      db.update(pc, String(prod.id), { available: Number(prod.available) - qty }, req.t);
      return { status: 201, body: api.one(db.insert(hc, { product: prod.id!, qty, status: "held" }, undefined, req.t)) };
    }, { ...W, idempotent: false, resource: `c:${hc}` });
    srv.route("DELETE", s.paths.release, (req) => {
      const h = db.get(hc, req.params.id!);
      if (!h) return { status: 200, body: api.one({ id: req.params.id!, released: false }) };
      if (h.status !== "held") return { status: 409, body: api.error("confirmed", "already confirmed") };
      const prod = db.get(pc, String(h.product));
      if (prod) db.update(pc, String(prod.id), { available: Number(prod.available) + Number(h.qty) }, req.t);
      db.remove(hc, String(h.id), req.t);
      return { status: 200, body: api.one({ id: h.id!, released: true }) };
    }, { ...W, idempotent: true, resource: `c:${hc}` });
    srv.route("POST", s.paths.pay, (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const h = db.get(hc, String(b.hold));
      if (!h || h.status !== "held") return { status: 409, body: api.error("hold_expired", "reservation is gone") };
      if (u01(s.salt, String(h.id)) < s.declineP) return { status: 402, body: api.error("card_declined", "payment declined") };
      return { status: 201, body: api.one(db.insert(payc, { hold: h.id!, amount: Number(b.amount ?? 0), status: "captured" }, undefined, req.t)) };
    }, { ...W, idempotent: false, resource: `c:${payc}` });
    srv.route("POST", s.paths.refund, (req) => {
      const p = db.get(payc, req.params.id!);
      if (!p) return { status: 404, body: api.error("not_found", "no such payment") };
      if (p.status !== "refunded") db.update(payc, String(p.id), { status: "refunded" }, req.t);
      return { status: 200, body: api.one(db.get(payc, String(p.id))) };
    }, { ...W, idempotent: true, resource: `c:${payc}` });
    srv.route("POST", s.paths.confirm, (req) => {
      const h = db.get(hc, req.params.id!);
      if (!h || h.status !== "held") return { status: 409, body: api.error("hold_expired", "reservation is gone") };
      db.update(hc, String(h.id), { status: "confirmed" }, req.t);
      return { status: 201, body: api.one(db.insert(`${s.id}:orders`, { hold: h.id!, payment: String((req.body as Record<string, unknown>)?.payment ?? "") }, undefined, req.t)) };
    }, { ...W, idempotent: false, resource: `c:${s.id}:orders` });
  },
  client(s, env, kit) {
    const F = s.f;
    const [n0, n1, n2] = s.names;
    const key = `${s.id}.saga`;
    const idle = (): Record<string, string> => ({ [n0]: "idle", [n1]: "idle", [n2]: "idle" });
    const doneOf = (st: Record<string, string>) => Object.values(st).filter((x) => x === "done").length;
    const S = env.store(s.store, s.id, { [F.list]: [] as Item[], [F.steps]: idle(), [F.done]: 0, [F.running]: false, [F.error]: null, [F.result]: null } as Record<string, unknown>, {
      weights: weightsOf([[F.list, 1], [F.steps, 0.6], [F.done, 0.5], [F.running, 0.1], [F.error, 0], [F.result, 1]]),
      resync: () => load(true),
    });
    let running = 0;
    let cur: { ctl: AbortController; cancelled: boolean } | null = null;
    async function load(bg: boolean): Promise<void> {
      const op = kit.op({ role: "load", method: "GET", url: s.paths.products, key: `${s.id}.list`, background: bg });
      const r = await kit.call(op);
      if (r.ok) kit.write(S, (p) => ({ ...p, [F.list]: kit.api.unlist(r.body).items }), { role: "load", op, key: `${s.id}.list` });
    }
    const setStep = (name: string, status: string, intent: number, op?: SimOp, derive = true) =>
      kit.write(S, (p) => {
        const st = { ...(p[F.steps] as Record<string, string>), [name]: status };
        return { ...p, [F.steps]: st, ...(derive ? { [F.done]: doneOf(st) } : {}) };
      }, { role: "step", intent, key, ...(op ? { op } : {}), ...(derive ? {} : { anomaly: "partial" }) });
    function start(intent: number, idx: number): void {
      if (s.disable && running > 0) return;
      const prods = (S.get()[F.list] as Item[]) ?? [];
      const prod = prods[idx % Math.max(1, prods.length)];
      if (!prod) return;
      const it = env.know.getIntent(intent);
      const dup = it?.accidental ? { dupOf: it.repeatOf } : {};
      const ref = it?.accidental && it.repeatOf !== undefined ? it.repeatOf : intent;
      const idem = s.charge.idem ? `pay_${env.rng.fork("saga", ref).token(12)}` : undefined;
      const run = { ctl: new AbortController(), cancelled: false };
      cur = run;
      running++;
      kit.write(S, (p) => ({ ...p, [F.steps]: idle(), [F.done]: 0, [F.running]: true, [F.error]: null, [F.result]: null }), { role: "start", intent, key });
      const undo: { name: string; method: string; url: string }[] = [];
      const step = (name: string, method: string, url: string, body: unknown, idempotent: boolean, extra: Partial<OpInit> = {}) =>
        kit.op({ role: name, method, url, body, intent, key, idempotent, ...dup, ...extra });
      const finish = (patch: Record<string, unknown>, op?: SimOp) => {
        running--;
        kit.write(S, (p) => ({ ...p, ...patch, [F.running]: running > 0 }), { role: "finish", intent, key, ...(op ? { op } : {}) });
        kit.spawn(() => load(true), "swallow");
      };
      async function unwind(k: number, r: CallResult | null, op?: SimOp): Promise<void> {
        const cancelled = r === null || r.outcome === "aborted";
        setStep(s.names[k]!, cancelled ? "cancelled" : "failed", intent, op);
        if (cancelled ? s.cancel === "abort" : s.compensate) {
          for (const u of undo.reverse()) {
            const cop = kit.op({ role: "compensate", method: u.method, url: u.url, intent, key, idempotent: true, handled: true });
            const cr = await kit.call(cop, { timeoutMs: 8000 });
            setStep(u.name, cr.ok ? "undone" : "stuck", intent, cop, s.deriveOnUndo);
          }
        }
        if (!cancelled && r) kit.shownError();
        finish({ [F.error]: cancelled ? null : r?.status === 402 ? "Payment declined" : r?.status === 409 ? "No longer available" : errMsg(r?.status ?? 0, r?.outcome ?? "neterr") }, op);
      }
      kit.spawn(async () => {
        const signal = run.ctl.signal;
        const pid = String(prod.id);
        setStep(n0, "pending", intent);
        const op1 = step(n0, "POST", s.paths.hold.replace(":id", pid), { qty: 1 }, false);
        const r1 = await kit.call(op1, { signal, timeoutMs: 8000 });
        if (!r1.ok) return unwind(0, r1, op1);
        const holdId = String(kit.api.unone(r1.body).id);
        undo.push({ name: n0, method: "DELETE", url: s.paths.release.replace(":id", holdId) });
        setStep(n0, "done", intent, op1);
        if (run.cancelled) return unwind(1, null);
        setStep(n1, "pending", intent);
        let attempt = 1;
        let prev: SimOp | undefined;
        let op2: SimOp;
        let r2: CallResult;
        for (;;) {
          const headers: Record<string, string> = idem && (attempt === 1 || s.charge.retry === "same-key") ? { "idempotency-key": idem } : {};
          op2 = step(n1, "POST", s.paths.pay, { hold: holdId, amount: Number(prod[s.priceField] ?? 0) }, false, { attempt, handled: s.charge.retry !== "none", ...(prev ? { retryOf: prev.id, dupOf: undefined } : {}) });
          r2 = await kit.call(op2, { signal, headers, timeoutMs: s.charge.timeoutMs });
          const retriable = r2.outcome === "timeout" || r2.outcome === "neterr" || r2.status >= 500;
          if (r2.ok || !retriable || s.charge.retry === "none" || attempt >= 3 || signal.aborted) break;
          await env.sleep(400 * attempt);
          attempt++;
          prev = op2;
        }
        if (!r2.ok) return unwind(1, r2, op2);
        const payId = String(kit.api.unone(r2.body).id);
        undo.push({ name: n1, method: "POST", url: s.paths.refund.replace(":id", payId) });
        setStep(n1, "done", intent, op2);
        if (run.cancelled) return unwind(2, null);
        setStep(n2, "pending", intent);
        const op3 = step(n2, "POST", s.paths.confirm.replace(":id", holdId), { payment: payId }, false);
        const r3 = await kit.call(op3, { signal, timeoutMs: 8000 });
        if (!r3.ok) return unwind(2, r3, op3);
        setStep(n2, "done", intent, op3);
        finish({ [F.result]: String(kit.api.unone(r3.body).id ?? "") }, op3);
      }, "uncaught", { cause: "saga-failed", diagnosis: "failing" });
    }
    return {
      init() {
        kit.spawn(() => load(true), "swallow");
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "cancel") {
          if (!cur || running === 0) return;
          cur.cancelled = true;
          if (s.cancel === "abort") cur.ctl.abort();
          return;
        }
        start(intent, Number(step.args?.product ?? 0));
      },
      cond() {
        return running > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(1.2);
    let n = 0;
    while (t < win.t1 - 2500 && n < 5) {
      n++;
      const idx = user.rng.int(0, s.products.length - 1);
      const label = `${s.labels.start.slice(0, -1)} ${String(s.products[idx]![s.nameField])}"`;
      steps.push(...user.click(t, label, "start", { kind: "checkout", key: `${s.id}.saga` }, { args: { product: idx }, pendingCond: "running", kind: "submit" }).steps);
      // Second thoughts while the flow is still running (only happens if it is: skipped in the ideal run).
      if (user.rng.bool(0.18)) steps.push({ t: t + user.rng.float(300, 2500), feature: s.id, action: "cancel", ui: { kind: "click", target: s.labels.cancel }, intent: { kind: "cancel", key: `${s.id}.cancel`, mode: "replace", accidental: false }, when: "running" });
      t += user.think(3);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    for (let i = 0; i < s.externalBuys; i++) {
      const idx = rng.int(0, s.products.length - 1);
      out.push({
        t: rng.float(win.t0 + 1000, win.t1),
        feature: s.id,
        desc: `another customer buys ${String(s.products[idx]![s.nameField])}`,
        apply(w) {
          const coll = `${s.id}:${s.coll}`;
          const pid = w.db.collection(coll).order[idx];
          const p = pid ? w.db.get(coll, pid) : undefined;
          if (p && Number(p.available) > 0) w.db.update(coll, pid!, { available: Number(p.available) - 1 }, w.now());
        },
      });
    }
    return out;
  },
};
