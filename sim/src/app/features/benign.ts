// Background noise that looks salient but is harmless: presence heartbeats (identical requests repeated by design),
// analytics beacons whose failures the app ignores, prefetches, and benign uncaught errors (ResizeObserver,
// cross-origin "Script error.", cancelled media play). The right call is almost always the passive one.

import type { ExternalEvent, FeatureDef, UserStep } from "../feature.js";
import { apiOf, weightsOf } from "./common.js";

export interface BenignSpec {
  id: string;
  api: string;
  store: string;
  f: { online: string; lastSeen: string };
  heartbeatPath: string;
  heartbeatMs: number;
  beaconPath: string;
  prefetchPath: string;
  noiseErrors: { t: number; message: string; name: string }[];
  beaconOnTimer: number;
}

const NOISE = [
  { name: "Error", message: "ResizeObserver loop completed with undelivered notifications." },
  { name: "Error", message: "Script error." },
  { name: "AbortError", message: "The play() request was interrupted by a call to pause()." },
  { name: "TypeError", message: "Cannot read properties of null (reading 'postMessage') at analytics.js:1:2210" },
  { name: "Error", message: "Non-Error promise rejection captured with value: Timeout" },
];

export const benign: FeatureDef<BenignSpec> = {
  kind: "benign",
  make({ rng, naming, id, api }) {
    const errs: BenignSpec["noiseErrors"] = [];
    for (let i = 0; i < rng.int(0, 2); i++) {
      const e = rng.pick(NOISE);
      errs.push({ t: rng.float(500, 14000), ...e });
    }
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["presence", "connection", "session"]), rng.pick(["", "info"])),
      f: { online: rng.pick(["online", "connected", "live"]), lastSeen: rng.pick(["peers", "viewers", "othersOnline"]) },
      heartbeatPath: naming.route(rng.pick(["presence", "heartbeat", "ping", "session/keepalive"]).replace("/", "-")),
      heartbeatMs: rng.pick([2000, 3000, 5000]),
      beaconPath: naming.route(rng.pick(["events", "analytics", "track", "telemetry"])),
      prefetchPath: naming.route(rng.pick(["config", "flags", "features", "bootstrap"])),
      noiseErrors: errs,
      beaconOnTimer: rng.pick([0, 2500, 4000]),
    };
  },
  pattern(s) {
    return [s.beaconOnTimer ? "beacon-timer" : "beacon-user", `noise:${s.noiseErrors.length}`];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    db.counter(`${s.id}:beats`);
    srv.route("POST", s.heartbeatPath, (req) => {
      db.addCounter(`${s.id}:beats`, 1, req.t);
      return { status: 200, body: api.one({ ok: true, viewers: 3 }) };
    }, { feature: s.id, kind: "write", idempotent: false, resource: `n:${s.id}:beats` });
    srv.route("POST", s.beaconPath, () => ({ status: 204 }), { feature: s.id, kind: "write", idempotent: false });
    srv.route("GET", s.prefetchPath, () => ({ status: 200, body: api.one({ flags: { newNav: true, darkMode: false } }) }), { feature: s.id, kind: "read", idempotent: true });
  },
  client(s, env, kit) {
    const F = s.f;
    const S = env.store(s.store, s.id, { [F.online]: true, [F.lastSeen]: 0 } as Record<string, unknown>, { weights: weightsOf([[F.online, 0.1], [F.lastSeen, 0]]) });
    const beacon = (name: string) => {
      const op = kit.op({ role: "beacon", method: "POST", url: s.beaconPath, body: { event: name }, key: `${s.id}.beacon`, idempotent: false, background: true, handled: true, classify: () => "expected" });
      kit.spawn(async () => {
        await kit.call(op, { timeoutMs: 5000 });
      }, "swallow");
    };
    return {
      init() {
        env.setInterval(() => {
          const op = kit.op({ role: "heartbeat", method: "POST", url: s.heartbeatPath, body: { status: "active" }, key: `${s.id}.beat`, idempotent: false, background: true, handled: true, classify: () => "expected" });
          kit.spawn(async () => {
            const r = await kit.call(op, { timeoutMs: 4000 });
            if (r.ok) kit.write(S, (p) => ({ ...p, [F.online]: true, [F.lastSeen]: Number((kit.api.unone(r.body) as Record<string, unknown>).viewers ?? 0) }), { role: "presence", op, key: `${s.id}.beat`, classify: () => "expected" });
            else kit.write(S, (p) => ({ ...p, [F.online]: false }), { role: "presence", op, key: `${s.id}.beat`, classify: () => "expected" });
          }, "swallow");
        }, s.heartbeatMs);
        if (s.beaconOnTimer) env.setInterval(() => beacon("tick"), s.beaconOnTimer);
        for (const e of s.noiseErrors) {
          env.setTimeout(() => {
            const err = new Error(e.message);
            err.name = e.name;
            env.know.tagError(err, { cause: "noise", feature: s.id, diagnosis: "expected" });
            env.uncaught(err, "window.onerror");
          }, e.t);
        }
        const op = kit.op({ role: "prefetch", method: "GET", url: s.prefetchPath, key: `${s.id}.prefetch`, background: true, handled: true, classify: () => "expected" });
        kit.spawn(async () => {
          await kit.call(op);
        }, "swallow");
      },
      handle(step: UserStep) {
        beacon(String(step.ui.value ?? "click"));
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    if (s.beaconOnTimer) return steps;
    let t = win.t0 + user.think();
    while (t < win.t1 - 500) {
      steps.push({ t, feature: s.id, action: "track", ui: { kind: "click", target: `link "${user.rng.pick(["Help", "Docs", "What's new", "Pricing"])}"`, value: "view" }, intent: { kind: "track", key: `${s.id}.track`, mode: "accumulate", accidental: false } });
      t += user.think(3);
    }
    return steps;
  },
  external(): ExternalEvent[] {
    return [];
  },
};
