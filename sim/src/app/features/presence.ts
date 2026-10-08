// Collaborative presence: the local caret/selection moves at high frequency (arrow-key repeat, shift-select, clicks)
// and is published as POST /presence, either throttled (100-500 ms with a trailing send) or on every event (a
// request storm that runs into 429/503 under load). Other people's carets arrive on a live channel; peers whose tab
// died never say goodbye, so the app drops peers not heard from within a TTL (or keeps ghosts forever). A heartbeat
// keeps this tab listed. Knobs: throttle, backoff on 429/503 (honouring retry-after) or keep hammering, TTL
// cleanup, online count maintained on every path (or not on cleanup/leave: partial update).

import type { Rng } from "../../rng.js";
import { rel, type ExternalEvent, type FeatureDef, type UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, weightsOf } from "./common.js";

export interface PresenceSpec {
  id: string;
  api: string;
  store: string;
  f: { me: string; peers: string; online: string; status: string };
  path: string;
  hbPath: string;
  topic: string;
  throttleMs: number;
  backoff: boolean;
  ttlMs: number;
  countOnAll: boolean;
  hbMs: number;
  people: string[];
  docLabel: string;
  lines: number;
}

type Caret = { line: number; col: number; sel: number };

function knob<T>(rng: Rng, clean: boolean | undefined, good: T, opts: readonly (readonly [T, number])[]): T {
  const v = rng.weighted(opts);
  return clean ? good : v;
}

export const presence: FeatureDef<PresenceSpec> = {
  kind: "presence",
  make({ rng, clean, domain, naming, id, api }) {
    const noun = rng.pick(domain.docs)[0].split(" ").slice(-1)[0]!;
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["presence", "collab", "cursors", "awareness"])),
      f: { me: rng.pick(["me", "self", "local", "myCursor"]), peers: rng.pick(["peers", "others", "collaborators", "cursors"]), online: rng.pick(["online", "onlineCount", "viewers"]), status: naming.field("status", id) },
      path: naming.route(`${noun}s`, rng.pick(["presence", "awareness", "cursors"])),
      hbPath: naming.route(rng.pick(["presence", "session"]), rng.pick(["heartbeat", "ping", "keepalive"])),
      topic: `${noun}s/${rng.int(10, 9999)}/${rng.pick(["presence", "cursors", "awareness"])}`,
      throttleMs: knob(rng, clean, rng.int(100, 500), [[rng.int(100, 500), 3], [0, 2]] as const),
      backoff: knob(rng, clean, true, [[true, 1], [false, 1]] as const),
      ttlMs: knob(rng, clean, rng.int(3000, 8000), [[rng.int(3000, 8000), 3], [0, 2]] as const),
      countOnAll: knob(rng, clean, true, [[true, 3], [false, 2]] as const),
      hbMs: rng.pick([2000, 3000, 5000]),
      people: rng.sample(domain.people.concat(["sam", "lee", "ana", "kim", "raj"]), 4),
      docLabel: `textarea "${title(noun)}"`,
      lines: rng.int(20, 120),
    };
  },
  pattern(s) {
    return [s.throttleMs ? "throttle" : "every-event", s.backoff ? "backoff" : "hammer", s.ttlMs ? "ttl" : "no-ttl", s.countOnAll ? "count" : "count-partial"];
  },
  relations(s) {
    const O = `${s.store}.${s.f.online}`;
    const P = `${s.store}.${s.f.peers}`;
    return [{ fields: [O, P], desc: "online count equals number of peers shown", check: (st) => Number(rel.field(st, O)) === ((rel.field(st, P) as unknown[]) ?? []).length }];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const prefix = `${s.id}:peer:`;
    const active = () => [...db.kv.entries()].filter(([k, v]) => k.startsWith(prefix) && v !== null).map(([, v]) => v);
    srv.route("GET", s.path, () => ({ status: 200, body: api.list(active()) }), { feature: s.id, kind: "read", idempotent: true });
    srv.route("POST", s.path, () => ({ status: 200, body: api.one({ ok: true, peers: active().length }) }), { feature: s.id, kind: "write", idempotent: true });
    srv.route("POST", s.hbPath, () => ({ status: 204 }), { feature: s.id, kind: "write", idempotent: true });
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.cursor`;
    const pkey = `${s.id}.peers`;
    const S = env.store(s.store, s.id, { [F.me]: { line: 1, col: 0, sel: 0 }, [F.peers]: [] as Caret[], [F.online]: 0, [F.status]: "live" } as Record<string, unknown>, {
      weights: weightsOf([[F.me, 0.4], [F.peers, 0.6], [F.online, 0.3], [F.status, 0.1]]),
      resync: () => load(),
    });
    const seen = new Map<string, number>();
    let lastSent = -1e9;
    let trail: unknown = null;
    let pausedUntil = 0;
    const peersOf = (p: Record<string, unknown>) => (p[F.peers] as (Caret & { peer: string })[]) ?? [];
    async function load(): Promise<void> {
      const op = kit.op({ role: "load", method: "GET", url: s.path, key: pkey, background: true });
      const r = await kit.call(op);
      if (!r.ok) return;
      const list = kit.api.unlist(r.body).items as unknown as (Caret & { peer: string })[];
      for (const x of list) seen.set(String(x.peer), env.now());
      kit.write(S, (p) => ({ ...p, [F.peers]: list, [F.online]: list.length }), { role: "load", op, key: pkey });
    }
    function setStatus(v: string, op: ReturnType<typeof kit.op>): void {
      if (S.get()[F.status] !== v) kit.write(S, (p) => ({ ...p, [F.status]: v }), { role: "presence", op, key, classify: () => "expected" });
    }
    function sendNow(): void {
      const me = S.get()[F.me] as Caret;
      const gap = env.now() - lastSent;
      lastSent = env.now();
      const op = kit.op({ role: "presence", method: "POST", url: s.path, body: { line: me.line, col: me.col, sel: me.sel }, intent: env.know.latestIntent(key)?.id, key, idempotent: true, handled: true });
      if (!s.throttleMs && gap < 100) op.anomaly = "storm";
      kit.spawn(async () => {
        const r = await kit.call(op, { timeoutMs: 4000 });
        if (r.ok) return setStatus("live", op);
        if (r.outcome === "aborted") return;
        if (s.backoff && (r.status === 429 || r.status === 503)) {
          const ra = Number(r.headers?.get("retry-after") ?? "");
          pausedUntil = env.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000);
        }
        setStatus("reconnecting", op);
      }, "swallow");
    }
    function moved(): void {
      const now = env.now();
      const wait = Math.max(s.throttleMs - (now - lastSent), s.backoff ? pausedUntil - now : 0);
      if (wait <= 0) {
        if (trail) env.clearTimeout(trail);
        trail = null;
        return sendNow();
      }
      if (!trail) {
        trail = env.setTimeout(() => {
          trail = null;
          sendNow();
        }, wait);
      }
    }
    function drop(gone: string[], role: string): void {
      kit.write(S, (p) => {
        const peers = peersOf(p).filter((x) => !gone.includes(String(x.peer)));
        return { ...p, [F.peers]: peers, ...(s.countOnAll ? { [F.online]: peers.length } : {}) };
      }, { role, key: pkey, ...(s.countOnAll ? {} : { anomaly: "partial" }) });
    }
    return {
      init() {
        kit.spawn(load, "swallow");
        env.socket(s.topic, (msg) => {
          const m = msg as Record<string, unknown>;
          const peer = String(m.peer);
          if (m.left) {
            seen.delete(peer);
            if (peersOf(S.get()).some((x) => x.peer === peer)) drop([peer], "push");
            return;
          }
          seen.set(peer, env.now());
          const c = { peer, line: Number(m.line), col: Number(m.col), sel: Number(m.sel ?? 0) };
          kit.write(S, (p) => {
            const peers = [...peersOf(p).filter((x) => x.peer !== peer), c];
            return { ...p, [F.peers]: peers, [F.online]: peers.length };
          }, { role: "push", key: pkey });
        });
        if (s.ttlMs) {
          env.setInterval(() => {
            const now = env.now();
            const gone = [...seen].filter(([, t]) => now - t > s.ttlMs).map(([p]) => p);
            if (!gone.length) return;
            for (const g of gone) seen.delete(g);
            drop(gone, "expire");
          }, 1000);
        }
        env.setInterval(() => {
          if (env.now() - lastSent < s.hbMs * 0.8) return;
          const op = kit.op({ role: "heartbeat", method: "POST", url: s.hbPath, body: { status: "active" }, key: `${s.id}.beat`, idempotent: true, background: true, handled: true, classify: () => "expected" });
          kit.spawn(async () => void (await kit.call(op, { timeoutMs: 4000 })), "swallow");
        }, s.hbMs);
      },
      handle(step: UserStep, intent: number) {
        const c: Caret = { line: Number(step.args?.line ?? 1), col: Number(step.args?.col ?? 0), sel: Number(step.args?.sel ?? 0) };
        kit.write(S, (p) => ({ ...p, [F.me]: c }), { role: "input", intent, key });
        moved();
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.5);
    let line = 1;
    let col = 0;
    let sel = 0;
    while (t < win.t1 - 500) {
      const mode = user.rng.weighted([["arrows", 4], ["select", 2], ["click", 2], ["lines", 2]] as const);
      const n = mode === "click" ? 1 : user.rng.int(4, 22);
      const gap = user.rng.bool(0.5) ? user.rng.float(28, 45) : user.rng.float(70, 160);
      for (let i = 0; i < n; i++) {
        let value = "click";
        if (mode === "arrows") {
          col = Math.max(0, col + (user.rng.bool(0.8) ? 1 : -1));
          sel = 0;
          value = "ArrowRight";
        } else if (mode === "select") {
          sel += 1;
          value = "Shift+ArrowRight";
        } else if (mode === "lines") {
          line = Math.min(s.lines, line + 1);
          sel = 0;
          value = "ArrowDown";
        } else {
          line = user.rng.int(1, s.lines);
          col = user.rng.int(0, 60);
          sel = 0;
        }
        steps.push({ t, feature: s.id, action: "caret", ui: { kind: mode === "click" ? "click" : "key", target: s.docLabel, ...(mode === "click" ? {} : { value }) }, args: { line, col, sel }, intent: { kind: "cursor", key: `${s.id}.cursor`, mode: "replace", accidental: false } });
        t += gap * user.rng.float(0.8, 1.25);
      }
      t += user.think(1.3);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    for (const peer of s.people.slice(0, rng.int(1, s.people.length))) {
      let t = rng.float(win.t0, win.t1 * 0.7);
      const end = Math.min(win.t1, t + rng.float(4000, 40000));
      let line = rng.int(1, s.lines);
      let col = rng.int(0, 40);
      const k = `${s.id}:peer:${peer}`;
      while (t < end) {
        const c = { peer, line, col, sel: rng.bool(0.2) ? rng.int(1, 12) : 0 };
        out.push({ t, feature: s.id, desc: `${peer} moves their cursor`, apply(w) {
          w.db.kv.set(k, c);
          w.publish(s.topic, c);
        } });
        line = Math.max(1, Math.min(s.lines, line + rng.int(-2, 2)));
        col = Math.max(0, col + rng.int(-6, 9));
        t += rng.float(300, 1500);
      }
      // Closing the tab says goodbye; a crashed tab or a dropped laptop lid does not (only a TTL removes it).
      const graceful = rng.bool(0.6);
      out.push({ t: end, feature: s.id, desc: `${peer} ${graceful ? "leaves" : "goes silent"}`, apply(w) {
        w.db.kv.delete(k);
        if (graceful) w.publish(s.topic, { peer, left: true });
      } });
    }
    return out;
  },
};
