// Time-limited auctions / flash offers. The server holds lots with an absolute end time (server clock = EPOCH +
// virtual time, sent as `x-server-time` / `date`) and rejects bids or claims at or after the end with 409 "ended"
// (bids not above the current price: 409 "outbid"; offers already taken: 409 "claimed"). The client renders a
// per-lot countdown that ticks every second from the device clock, which may be off by seconds to minutes. Rivals
// bid (more often in the last seconds) and new lots are listed during the session. Knobs: clock source (device
// clock: closed too early / still open after the end under skew; server-time offset estimated from response
// timestamps = guard), failure policy (one delayed retry, none, or a tight re-send loop in the last seconds = bid
// storm), 409 handling (apply the server's current lot vs ignore it = optimistic bid kept), live pushes vs polling.

import type { Item } from "../../net/server.js";
import type { SimOp } from "../../oracle/knowledge.js";
import { AppEnv } from "../env.js";
import { itemName, round2, type ExternalEvent, type FeatureDef, type UserStep } from "../feature.js";
import type { CallResult } from "../kit.js";
import { apiOf, errMsg, weightsOf } from "./common.js";

interface Lot {
  name: string;
  start: number;
  dur: number;
  price: number;
}

export interface CountdownSpec {
  id: string;
  api: string;
  store: string;
  f: { lots: string; left: string; open: string; error: string; busy: string };
  mode: "auction" | "offer";
  nameField: string;
  priceField: string;
  lots: Lot[];
  step: number;
  listPath: string;
  actPath: string;
  topic: string;
  clock: "device" | "offset";
  on409: "apply" | "ignore";
  retry: "once" | "none" | "storm";
  live: boolean;
  pollMs: number;
  skew: boolean;
  actLabel: string;
  refreshLabel: string;
  rivals: number;
}

function lotItem(s: CountdownSpec, l: Lot): Item {
  const it: Item = { [s.nameField]: l.name, [s.priceField]: l.price, endsAt: AppEnv.EPOCH + l.start + l.dur };
  if (s.mode === "auction") {
    it.leader = null;
    it.bids = 0;
  } else it.claimed = false;
  return it;
}
const upsert = (list: Item[], it: Item): Item[] => (list.some((x) => x.id === it.id) ? list.map((x) => (x.id === it.id ? it : x)) : [...list, it]);
const strip = (it: Item): Item => {
  const o: Item = { ...it };
  delete o.serverTime;
  return o;
};

export const countdown: FeatureDef<CountdownSpec> = {
  kind: "countdown",
  make({ rng, entity, naming, id, api, clean }) {
    const num: [string, number, number, number] = entity.nums.find((n) => /price|amount|bid|fare|fee|cost|rate|value|premium/.test(n[0])) ?? ["price", 5, 500, 2];
    const mode = rng.weighted([["auction", 3], ["offer", 2]] as const);
    const lots: Lot[] = [];
    const n = rng.int(2, 4);
    for (let i = 0; i < n; i++) lots.push({ name: itemName(rng, entity, i), start: 0, dur: rng.int(12000, 70000), price: round2(rng.float(num[1], num[2])) });
    // Lots listed later (external events create them at `start`).
    for (let i = n, t = rng.int(8000, 30000); i < n + 10; i++, t += rng.int(10000, 40000)) lots.push({ name: itemName(rng, entity, i), start: t, dur: rng.int(10000, 45000), price: round2(rng.float(num[1], num[2])) });
    const seg = rng.pick(mode === "auction" ? ["auctions", "lots", "live"] : ["deals", "offers", "flash"]);
    return {
      id,
      api: api.name,
      store: naming.store(seg, rng.pick(["board", "room", "now", "live"])),
      f: { lots: naming.field("list", id), left: naming.word(rng.pick(["remaining", "secondsLeft", "timeLeft", "countdown"])), open: naming.word(rng.pick(["open", "isOpen", "biddable", "live"])), error: naming.field("error", id), busy: naming.field("submitting", id) },
      mode,
      nameField: entity.name,
      priceField: num[0],
      lots,
      step: round2(Math.max(0.5, (num[2] - num[1]) / 50)),
      listPath: naming.route(seg),
      actPath: naming.route(seg, ":id", mode === "auction" ? "bids" : "claim"),
      topic: `${seg}-${rng.pick(["live", "feed", "updates"])}`,
      clock: clean ? "offset" : rng.weighted([["device", 3], ["offset", 2]] as const),
      on409: clean ? "apply" : rng.weighted([["apply", 3], ["ignore", 2]] as const),
      retry: clean ? rng.pick(["once", "none"] as const) : rng.weighted([["once", 3], ["none", 2], ["storm", 2]] as const),
      live: rng.bool(0.5),
      pollMs: rng.int(2000, 6000),
      skew: rng.bool(0.55),
      actLabel: `button "${mode === "auction" ? rng.pick(["Place bid", "Bid", "Raise bid"]) : rng.pick(["Claim", "Grab deal", "Redeem", "Buy now"])}"`,
      refreshLabel: `button "${rng.pick(["Refresh", "Reload", "↻"])}"`,
      rivals: mode === "auction" ? rng.int(2, 8) : 0,
    };
  },
  pattern(s) {
    return [`mode:${s.mode}`, `clock:${s.clock}`, `on409:${s.on409}`, `retry:${s.retry}`, s.live ? "live" : "poll", s.skew ? "skew" : "noskew"];
  },
  env(s, rng) {
    if (!s.skew) return {};
    const mag = rng.weighted([[rng.float(2000, 15000), 2], [rng.float(30000, 300000), 3]] as const);
    return { skewMs: Math.round((rng.bool(0.5) ? 1 : -1) * mag) };
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:lots`;
    for (const l of s.lots) if (l.start === 0) db.insert(coll, lotItem(s, l), `lot:${l.name}`);
    const clock = (t: number) => AppEnv.EPOCH + t;
    const hdr = (t: number) => ({ date: new Date(clock(t)).toUTCString(), "x-server-time": String(clock(t)) });
    srv.route("GET", s.listPath, (req) => ({ status: 200, body: api.list(db.list(coll), { serverTime: clock(req.t) }), headers: hdr(req.t) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
    srv.route(
      "POST",
      s.actPath,
      (req) => {
        const lot = db.get(coll, String(req.params.id));
        if (!lot) return { status: 404, body: api.error("not_found", "no such lot"), headers: hdr(req.t) };
        const current: Item = { ...lot, serverTime: clock(req.t) };
        if (clock(req.t) >= Number(lot.endsAt)) return { status: 409, body: { error: "ended", message: "this has ended", current }, headers: hdr(req.t) };
        let it: Item | undefined;
        if (s.mode === "auction") {
          const amount = Number(((req.body ?? {}) as Record<string, unknown>).amount);
          if (!(amount > Number(lot[s.priceField]))) return { status: 409, body: { error: "outbid", message: "bid must be above the current price", current }, headers: hdr(req.t) };
          it = db.update(coll, String(lot.id), { [s.priceField]: amount, leader: "you", bids: Number(lot.bids ?? 0) + 1 }, req.t);
        } else {
          if (lot.claimed === true) return { status: 409, body: { error: "claimed", message: "already claimed", current }, headers: hdr(req.t) };
          it = db.update(coll, String(lot.id), { claimed: true }, req.t);
        }
        if (it && s.live) srv.publish(s.topic, it);
        return { status: 201, body: api.one({ ...it, serverTime: clock(req.t) }), headers: hdr(req.t) };
      },
      { feature: s.id, kind: "write", idempotent: false, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const S = env.store(s.store, s.id, { [F.lots]: [] as Item[], [F.left]: {}, [F.open]: {}, [F.error]: null, [F.busy]: false } as Record<string, unknown>, {
      weights: weightsOf([[F.lots, 1], [F.left, 0.3], [F.open, 0.5], [F.error, 0], [F.busy, 0.1]]),
      resync: () => load(true),
    });
    let offset = 0; // estimated server clock - device clock ("offset" clock only)
    let busy = 0;
    const pending = new Set<string>();
    const lotsOf = () => (S.get()[F.lots] as Item[]) ?? [];
    const now = () => env.clientNow() + (s.clock === "offset" ? offset : 0);
    const sync = (r: CallResult, op: SimOp, body?: Record<string, unknown>) => {
      if (s.clock !== "offset") return;
      const st = Number(r.headers?.get("x-server-time") ?? body?.serverTime);
      // NTP-style: the server stamped the response about half a round trip ago.
      if (Number.isFinite(st) && st > 0) offset = st + (env.now() - op.t0) / 2 - env.clientNow();
    };
    const tick = (): void => {
      const left: Record<string, number> = {};
      const open: Record<string, boolean> = {};
      for (const l of lotsOf()) {
        const name = String(l[s.nameField]);
        left[name] = Math.max(0, Math.ceil((Number(l.endsAt) - now()) / 1000));
        open[name] = left[name]! > 0 && l.claimed !== true;
      }
      const cur = S.get();
      if (JSON.stringify(cur[F.left]) === JSON.stringify(left) && JSON.stringify(cur[F.open]) === JSON.stringify(open)) return;
      kit.write(S, (p) => ({ ...p, [F.left]: left, [F.open]: open }), { role: "tick", key: `${s.id}.clock` });
    };
    async function load(bg: boolean, intent?: number): Promise<void> {
      const op = kit.op({ role: "load", method: "GET", url: s.listPath, key: `${s.id}.lots`, background: bg, ...(intent !== undefined ? { intent } : {}) });
      const r = await kit.call(op, { timeoutMs: 8000 });
      if (!r.ok) return;
      const { items, extra } = kit.api.unlist(r.body);
      sync(r, op, extra);
      const classify = () => {
        const shown = new Map(lotsOf().map((l) => [String(l.id), Number(l.version)]));
        return items.some((l) => Number(l.version) < (shown.get(String(l.id)) ?? 0)) ? "stale" : undefined;
      };
      // Lots with a bid/claim in flight keep their optimistic state until it settles.
      kit.write(S, (p) => ({ ...p, [F.lots]: items.map((l) => (pending.has(String(l.id)) ? ((p[F.lots] as Item[]) ?? []).find((x) => x.id === l.id) ?? l : l)) }), { role: "poll-result", op, key: `${s.id}.lots`, classify });
      tick();
    }
    function act(intent: number, idx: number): void {
      const name = s.lots[idx]?.name;
      const lot = lotsOf().find((l) => l[s.nameField] === name);
      if (!lot || name === undefined) return;
      const shownOpen = (S.get()[F.open] as Record<string, boolean>)[name];
      if (!(shownOpen ?? Number(lot.endsAt) > now())) return; // the button reads "Ended" (disabled)
      const it = env.know.getIntent(intent);
      const key = `${s.id}.lot.${idx}`;
      const id = String(lot.id);
      const before = { ...lot };
      const amount = round2(Number(lot[s.priceField]) + s.step);
      const optimistic: Item = s.mode === "auction" ? { ...lot, [s.priceField]: amount, leader: "you" } : { ...lot, claimed: true };
      busy++;
      pending.add(id);
      kit.write(S, (p) => ({ ...p, [F.lots]: upsert((p[F.lots] as Item[]) ?? [], optimistic), [F.busy]: true, [F.error]: null }), { role: "optimistic", intent, key });
      const send = async (attempt: number, retryOf?: number, storm = false): Promise<void> => {
        const op = kit.op({ role: s.mode === "auction" ? "bid" : "claim", method: "POST", url: s.actPath.replace(":id", encodeURIComponent(id)), body: s.mode === "auction" ? { amount } : {}, intent, key, idempotent: false, attempt, handled: s.retry !== "none", ...(retryOf !== undefined ? { retryOf } : {}), ...(it?.accidental && attempt === 1 ? { dupOf: it.repeatOf ?? -1 } : {}) });
        if (storm) op.anomaly = "storm";
        const r = await kit.call(op, { timeoutMs: 6000 });
        const settle = () => {
          busy--;
          pending.delete(id);
          return busy > 0;
        };
        if (r.ok || (r.status === 409 && s.on409 === "ignore")) {
          const b = settle();
          if (!r.ok) {
            // Defect: a 409 is treated like success; the optimistic bid/claim stays on screen.
            kit.write(S, (p) => ({ ...p, [F.busy]: b }), { role: "confirm", op, intent, key });
            return;
          }
          const srv = kit.api.unone(r.body);
          sync(r, op, srv);
          const classify = () => (Number(srv[s.priceField]) < Number(lotsOf().find((l) => l.id === srv.id)?.[s.priceField]) ? "stale" : undefined);
          kit.write(S, (p) => ({ ...p, [F.lots]: upsert((p[F.lots] as Item[]) ?? [], strip(srv)), [F.busy]: b }), { role: "confirm", op, intent, key, classify });
          return tick();
        }
        if (r.status === 409) {
          const b = settle();
          const body = (r.body ?? {}) as Record<string, unknown>;
          const cur = (body.current ?? before) as Item;
          sync(r, op, cur);
          const msg = body.error === "ended" ? "This has ended" : body.error === "outbid" ? "You were outbid" : "Already claimed";
          kit.write(S, (p) => ({ ...p, [F.lots]: upsert((p[F.lots] as Item[]) ?? [], strip(cur)), [F.busy]: b, [F.error]: msg }), { role: "conflict-refetch", op, intent, key });
          kit.shownError();
          return tick();
        }
        if (r.outcome === "aborted") {
          settle();
          return;
        }
        const leftMs = Number(lot.endsAt) - now();
        if (s.retry === "storm" && leftMs > 0 && leftMs < 6000 && attempt < 20) {
          // Last seconds: re-send at once until it goes through.
          await env.sleep(env.rng.fork("cd-storm", s.id, intent, attempt).float(30, 120));
          return send(attempt + 1, op.id, true);
        }
        if (s.retry !== "none" && attempt === 1 && leftMs > 1500) {
          await env.sleep(1000);
          return send(2, op.id);
        }
        const b = settle();
        kit.write(S, (p) => ({ ...p, [F.lots]: upsert((p[F.lots] as Item[]) ?? [], before), [F.busy]: b, [F.error]: errMsg(r.status, r.outcome) }), { role: "rollback", op, intent, key });
        kit.shownError();
      };
      kit.spawn(() => send(1), "uncaught", { cause: `${s.mode}-failed`, diagnosis: "failing" });
    }
    return {
      init() {
        kit.spawn(() => load(true), "swallow");
        env.setInterval(tick, 1000);
        env.setInterval(() => kit.spawn(() => load(true), "swallow"), s.live ? s.pollMs * 4 : s.pollMs);
        if (s.live) {
          env.socket(s.topic, (msg) => {
            const m = strip(msg as Item);
            const name = String(m[s.nameField]);
            const idx = s.lots.findIndex((l) => l.name === name);
            const classify = () => (Number(m.version) < Number(lotsOf().find((l) => l.id === m.id)?.version ?? 0) ? "stale" : undefined);
            kit.write(S, (p) => ({ ...p, [F.lots]: upsert((p[F.lots] as Item[]) ?? [], m) }), { role: "push", key: `${s.id}.lot.${idx}`, classify });
            tick();
          });
        }
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "refresh") return kit.spawn(() => load(false, intent), "swallow");
        act(intent, Number(step.args?.lot ?? 0));
      },
      cond() {
        return busy > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.8);
    while (t < win.t1 - 600) {
      const open = s.lots.map((l, i) => ({ l, i })).filter(({ l }) => l.start + 500 <= t && t < l.start + l.dur);
      if (!open.length) {
        t += user.think(1.5);
        continue;
      }
      const { l, i } = user.rng.pick(open);
      const end = l.start + l.dur;
      // Sniping: wait for the last seconds (sometimes just past the end while the countdown still shows a second).
      if (user.rng.bool(0.4) && end - t < 30000) t = Math.max(t, end - user.rng.float(-600, 3500));
      const label = `${s.actLabel.slice(0, -1)} ${l.name}"`;
      const intent = { kind: s.mode === "auction" ? "bid" : "claim", key: `${s.id}.lot.${i}` };
      steps.push(...user.click(t, label, "act", intent, { args: { lot: i }, pendingCond: "busy" }).steps);
      if (s.mode === "auction" && user.rng.bool(0.3)) {
        t += user.rng.float(500, 2500);
        steps.push(...user.click(t, label, "act", intent, { args: { lot: i }, doubleP: 0 }).steps);
      }
      if (user.rng.bool(0.15)) steps.push(...user.click(t + user.think(0.5), s.refreshLabel, "refresh", { kind: "refresh", key: `${s.id}.refresh`, mode: "replace" }).steps);
      t += user.think(1.2);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    const coll = `${s.id}:lots`;
    s.lots.forEach((l) => {
      if (l.start > 0 && l.start < win.t1) {
        out.push({
          t: l.start,
          feature: s.id,
          desc: `${l.name} listed`,
          apply(w) {
            const it = w.db.insert(coll, lotItem(s, l), `lot:${l.name}`, w.now());
            if (s.live) w.publish(s.topic, it);
          },
        });
      }
      const end = l.start + l.dur;
      for (let k = 0; k < s.rivals; k++) {
        // Rivals bid more often in the last seconds.
        const t = rng.bool(0.5) ? end - rng.float(0, 4000) : rng.float(l.start, end);
        if (t < l.start || t > win.t1) continue;
        out.push({
          t,
          feature: s.id,
          desc: `rival bids on ${l.name}`,
          apply(w) {
            const it = w.db.list(coll).find((x) => x[s.nameField] === l.name);
            if (!it || AppEnv.EPOCH + w.now() >= Number(it.endsAt)) return;
            const nx = w.db.update(coll, String(it.id), { [s.priceField]: round2(Number(it[s.priceField]) + s.step * (1 + (k % 3))), leader: "other", bids: Number(it.bids ?? 0) + 1 }, w.now());
            if (nx && s.live) w.publish(s.topic, nx);
          },
        });
      }
    });
    return out;
  },
};
