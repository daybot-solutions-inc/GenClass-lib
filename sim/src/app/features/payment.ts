// Payment intent flow: create an intent (POST, optional Idempotency-Key), confirm it (POST /intents/:id/confirm:
// charges the card once; a second confirm of the same intent gets 409 or an idempotent replay, depending on the
// server), then poll the intent until it settles. Charges are recorded in a server collection, so a second intent
// confirmed by a double click or a whole-flow retry is real server damage (double charge). Knobs: pay button
// disabled while paying / idempotency keys (guards) vs none; retry after a confirm timeout: confirm the same intent
// again or restart the whole flow (defect without a create key); 409 already-confirmed treated as success (guard)
// or as a failure; status polling by overlapping interval vs chained timeouts, with a monotonic-status or sequence
// guard (defect: an older "processing" response lands over "succeeded").

import { hashAll } from "../../rng.js";
import { AppEnv } from "../env.js";
import type { FeatureDef, UserStep } from "../feature.js";
import { round2 } from "../feature.js";
import { apiOf, errMsg, weightsOf } from "./common.js";

export interface PaymentSpec {
  id: string;
  api: string;
  store: string;
  f: { status: string; amount: string; paying: string; receipt: string; history: string; error: string };
  currency: string;
  amount: number;
  createPath: string;
  confirmPath: string;
  intentPath: string;
  createIdem: boolean;
  confirmIdem: boolean;
  disable: boolean;
  confirmTimeoutMs: number;
  retry: "none" | "confirm" | "restart";
  on409: "success" | "error";
  serverAlready: "409" | "replay";
  poll: "interval" | "chain";
  statusGuard: "rank" | "seq" | "none";
  pollMs: number;
  settleMs: number;
  declinePct: number;
  payLabel: string;
  amountLabel: string;
}

const RANK: Record<string, number> = { requires_confirmation: 0, processing: 1, succeeded: 2, failed: 2 };
const FINAL = new Set(["succeeded", "failed"]);

export const payment: FeatureDef<PaymentSpec> = {
  kind: "payment",
  make({ rng, naming, id, api, clean }) {
    const amount = round2(rng.float(5, 400));
    const currency = rng.pick(["USD", "EUR", "CAD", "GBP"]);
    const createIdem = rng.bool(0.5);
    const retry = rng.weighted([["none", 3], ["confirm", 3], ["restart", 2]] as const);
    const on409 = rng.weighted([["success", 3], ["error", 2]] as const);
    const statusGuard = rng.weighted([["rank", 2], ["seq", 2], ["none", 3]] as const);
    const disable = rng.bool(0.5);
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["checkout", "payment", "billing", "pay"]), rng.pick(["", "flow", "state"])),
      f: { status: naming.field("status", id), amount: rng.pick(["amount", "total", "amountDue"]), paying: rng.pick(["paying", "processing", "isPaying", "submitting"]), receipt: rng.pick(["receipt", "paymentId", "confirmation", "intentId"]), history: rng.pick(["payments", "history", "charges"]), error: naming.field("error", id) },
      currency,
      amount,
      createPath: naming.route(rng.pick(["payment_intents", "payments", "intents"])),
      confirmPath: naming.route(rng.pick(["payment_intents", "payments", "intents"]), ":id", "confirm"),
      intentPath: naming.route(rng.pick(["payment_intents", "payments", "intents"]), ":id"),
      createIdem: clean || createIdem,
      confirmIdem: rng.bool(0.4),
      disable: clean || disable,
      confirmTimeoutMs: rng.weighted([[0, 2], [rng.int(2500, 8000), 3]] as const),
      retry: clean && retry === "restart" ? "confirm" : retry,
      on409: clean ? "success" : on409,
      serverAlready: rng.bool(0.6) ? "409" : "replay",
      poll: rng.weighted([["interval", 3], ["chain", 2]] as const),
      statusGuard: clean && statusGuard === "none" ? "rank" : statusGuard,
      pollMs: rng.int(400, 1500),
      settleMs: rng.int(800, 6000),
      declinePct: rng.weighted([[0, 3], [10, 1], [25, 1]] as const),
      payLabel: `button "${rng.pick(["Pay", "Pay now", "Confirm payment", "Complete purchase"])} ${currency} ${amount.toFixed(2)}"`,
      amountLabel: `input "${rng.pick(["Amount", "Tip", "Top-up amount"])}"`,
    };
  },
  pattern(s) {
    return [s.disable ? "disable" : "nodisable", s.createIdem ? "create-idem" : "create-noidem", s.confirmIdem ? "confirm-idem" : "confirm-noidem", `retry:${s.retry}`, `on409:${s.on409}`, `server:${s.serverAlready}`, `poll:${s.poll}`, `status:${s.statusGuard}`];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:intents`;
    const charges = `${s.id}:charges`;
    const view = (it: Record<string, unknown>, t: number) => {
      let status = String(it.status);
      if (status === "processing" && t - (Number(it.updatedAt) - AppEnv.EPOCH) >= s.settleMs) status = "succeeded";
      return { id: it.id, amount: it.amount, currency: it.currency, status };
    };
    srv.route(
      "POST",
      s.createPath,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const amount = Number(b.amount);
        if (!(amount > 0)) return { status: 422, body: api.error("invalid_amount", "amount must be positive") };
        const it = db.insert(coll, { amount, currency: String(b.currency ?? s.currency), status: "requires_confirmation" }, `${amount}:${String(b.currency)}`, req.t);
        return { status: 201, body: api.one(view(it, req.t)) };
      },
      { feature: s.id, kind: "write", idempotent: false, resource: `c:${coll}` },
    );
    srv.route(
      "POST",
      s.confirmPath,
      (req) => {
        const it = db.get(coll, req.params.id!);
        if (!it) return { status: 404, body: api.error("not_found", "no such payment") };
        if (it.status !== "requires_confirmation") {
          if (s.serverAlready === "409") return { status: 409, body: { ...(api.error("already_confirmed", "payment already confirmed") as object), payment: view(it, req.t) } };
          return { status: 200, body: api.one(view(it, req.t)), note: "already-confirmed" };
        }
        if (hashAll(s.id, "decline", String(it.id)) % 100 < s.declinePct) {
          db.update(coll, String(it.id), { status: "failed" }, req.t);
          return { status: 402, body: api.error("card_declined", "Your card was declined.") };
        }
        const next = db.update(coll, String(it.id), { status: "processing", updatedAt: AppEnv.EPOCH + req.t }, req.t)!;
        db.insert(charges, { payment: String(it.id), amount: it.amount!, currency: it.currency! }, `charge:${String(it.id)}`, req.t);
        return { status: 200, body: api.one(view(next, req.t)) };
      },
      { feature: s.id, kind: "write", idempotent: false, resource: `c:${charges}` },
    );
    srv.route("GET", s.intentPath, (req) => {
      const it = db.get(coll, req.params.id!);
      if (!it) return { status: 404, body: api.error("not_found", "no such payment") };
      return { status: 200, body: api.one(view(it, req.t)) };
    }, { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.pay`;
    const init: Record<string, unknown> = { [F.status]: "idle", [F.amount]: s.amount, [F.paying]: false, [F.receipt]: null, [F.history]: [], [F.error]: null };
    const S = env.store(s.store, s.id, init, { weights: weightsOf([[F.status, 1], [F.amount, 0.4], [F.paying, 0.2], [F.receipt, 1], [F.history, 1], [F.error, 0]]) });
    let paying = 0;
    let pollSeq = 0;
    const setStatus = (st: string, receipt: string | null, meta: Parameters<typeof kit.write>[2], my?: number) => {
      const classify = () => (S.get()[F.receipt] === receipt && (RANK[String(S.get()[F.status])] ?? 0) > (RANK[st] ?? 0) ? "stale" : undefined);
      kit.write(
        S,
        (p) => {
          if (s.statusGuard === "rank" && (RANK[String(p[F.status])] ?? 0) > (RANK[st] ?? 0) && p[F.receipt] === receipt) return p;
          if (s.statusGuard === "seq" && my !== undefined && my < pollSeq) return p;
          return { ...p, [F.status]: st, ...(receipt ? { [F.receipt]: receipt } : {}) };
        },
        { ...meta, classify },
      );
    };
    function settle(piId: string, intent: number): Promise<string> {
      const url = s.intentPath.replace(":id", encodeURIComponent(piId));
      return new Promise<string>((resolve) => {
        let n = 0;
        let stop = false;
        let h: unknown = null;
        const tick = () => {
          if (stop || n++ > 30) {
            if (h) env.clearInterval(h);
            return resolve("timeout");
          }
          const my = ++pollSeq;
          const op = kit.op({ role: "status", method: "GET", url, intent, key: `${s.id}.pi.${piId}`, background: true, handled: true });
          void kit.call(op, { timeoutMs: 8000 }).then((r) => {
            if (!r.ok) {
              if (s.poll === "chain" && !stop) env.setTimeout(tick, s.pollMs * 2);
              return;
            }
            const st = String(kit.api.unone(r.body).status);
            setStatus(st, piId, { role: "poll-result", op, intent, key }, my);
            if (FINAL.has(st) && !stop) {
              stop = true;
              if (h) env.clearInterval(h);
              resolve(st);
            } else if (s.poll === "chain" && !stop) env.setTimeout(tick, s.pollMs);
          });
        };
        if (s.poll === "interval") h = env.setInterval(tick, s.pollMs);
        else env.setTimeout(tick, s.pollMs);
      });
    }
    function pay(intent: number): void {
      if (s.disable && paying > 0) return;
      const it = env.know.getIntent(intent);
      const ref = it?.accidental && it.repeatOf !== undefined ? it.repeatOf : intent;
      const dup = it?.accidental ? [...env.know.ops].reverse().find((o) => o.intent === it.repeatOf && o.role === "create-intent")?.id ?? -1 : undefined;
      const amount = Number(S.get()[F.amount]) || s.amount;
      paying++;
      kit.write(S, (p) => ({ ...p, [F.paying]: true, [F.error]: null, [F.status]: "processing" }), { role: "busy", intent, key });
      const fail = (msg: string, op?: ReturnType<typeof kit.op>) => {
        paying--;
        kit.write(S, (p) => ({ ...p, [F.paying]: paying > 0, [F.status]: "failed", [F.error]: msg }), { role: "error", op, intent, key });
        kit.shownError();
      };
      const flow = async (round: number, prevOp?: number): Promise<void> => {
        const ck = `pi_${env.rng.fork("pay-create", s.id, ref).token(14)}`;
        const create = kit.op({ role: "create-intent", method: "POST", url: s.createPath, body: { amount, currency: s.currency }, intent, key, idempotent: false, attempt: round, handled: s.retry !== "none", ...(prevOp !== undefined ? { retryOf: prevOp } : {}), ...(dup !== undefined ? { dupOf: dup } : {}) });
        const cr = await kit.call(create, { headers: s.createIdem ? { "idempotency-key": ck } : {}, timeoutMs: 10000 });
        if (!cr.ok) return fail(errMsg(cr.status, cr.outcome), create);
        const piId = String(kit.api.unone(cr.body).id);
        const confirmKey = `cf_${env.rng.fork("pay-confirm", s.id, piId).token(14)}`;
        let last: number | undefined;
        for (let n = 1; n <= 3; n++) {
          const op = kit.op({ role: "confirm", method: "POST", url: s.confirmPath.replace(":id", encodeURIComponent(piId)), body: { payment_method: "pm_card" }, intent, key, idempotent: false, attempt: n, handled: s.retry !== "none", ...(last !== undefined ? { retryOf: last } : {}) });
          last = op.id;
          const r = await kit.call(op, { headers: s.confirmIdem ? { "idempotency-key": confirmKey } : {}, ...(s.confirmTimeoutMs ? { timeoutMs: s.confirmTimeoutMs } : {}) });
          const transient = r.outcome === "timeout" || r.outcome === "neterr" || r.status >= 500;
          if (transient && s.retry === "confirm" && n < 3) {
            await env.sleep(500 * n);
            continue;
          }
          if (transient && s.retry === "restart" && round < 3) {
            await env.sleep(500);
            return flow(round + 1, create.id);
          }
          if (r.status === 409) {
            if (s.on409 === "error") return fail("Payment failed", op);
            const pb = (r.body as Record<string, unknown>)?.payment as Record<string, unknown> | undefined;
            setStatus(String(pb?.status ?? "processing"), piId, { role: "confirm", op, intent, key });
          } else if (!r.ok) return fail(r.status === 402 ? "Your card was declined." : errMsg(r.status, r.outcome), op);
          else setStatus(String(kit.api.unone(r.body).status ?? "processing"), piId, { role: "confirm", op, intent, key });
          break;
        }
        const final = FINAL.has(String(S.get()[F.status])) ? String(S.get()[F.status]) : await settle(piId, intent);
        paying--;
        if (final === "succeeded") {
          kit.write(S, (p) => ({ ...p, [F.paying]: paying > 0, [F.history]: [...((p[F.history] as unknown[]) ?? []), { amount, currency: s.currency, status: "succeeded" }] }), { role: "placed", intent, key });
        } else {
          kit.write(S, (p) => ({ ...p, [F.paying]: paying > 0, [F.error]: final === "failed" ? "Payment failed" : "Still processing, check back later" }), { role: "error", intent, key });
          kit.shownError();
        }
      };
      kit.spawn(() => flow(1), "uncaught", { cause: "payment-failed", diagnosis: "failing" });
    }
    return {
      handle(step: UserStep, intent: number) {
        if (step.action === "amount") return kit.write(S, (p) => ({ ...p, [F.amount]: Number(step.ui.value) || 0 }), { role: "input", intent, key: `${s.id}.amount` });
        pay(intent);
      },
      cond() {
        return paying > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(1);
    let n = 0;
    while (t < win.t1 - 3000 && n < 3) {
      n++;
      if (user.rng.bool(0.4)) {
        const typed = user.type(t, "", String(round2(user.rng.float(5, 250))), s.amountLabel, "amount", `${s.id}.amount`);
        steps.push(...typed.steps);
        t = typed.t + user.rng.float(300, 1200);
      }
      const c = user.click(t, s.payLabel, "pay", { kind: "pay", key: `${s.id}.pay` }, { pendingCond: "paying", kind: "submit" });
      steps.push(...c.steps);
      // A second purchase later in the session is a new intent (same amount is fine: a legitimate repeat).
      t += s.settleMs + 3000 + user.think(5);
    }
    return steps;
  },
};
