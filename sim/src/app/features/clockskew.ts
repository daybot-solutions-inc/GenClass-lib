// Server timestamps vs a skewed device clock. The list endpoint returns items with `updatedAt` and a freshness
// deadline (`expiresAt` = server time + TTL, epoch ms; also as Date/Expires headers for bare envelopes); an access
// token carries its own `expiresAt`. The client judges freshness with its own clock (env.clientNow(), off by the
// scenario's skew; the ideal run has no skew). Knobs: naive comparison of server deadlines with the local clock
// (defect: clock ahead → fresh data always looks stale → refetch loop / premature token refreshes; clock behind →
// expired data looks fresh → stale values shown, expired token sent → 401), server-offset correction from the
// response's serverTime/Date (guard), relative max-age measured on the local clock (guard); check interval.

import type { Item } from "../../net/server.js";
import { hashAll } from "../../rng.js";
import { AppEnv } from "../env.js";
import type { ExternalEvent, FeatureDef, UserStep } from "../feature.js";
import type { CallResult } from "../kit.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

type Fresh = "naive" | "offset" | "relative";

export interface ClockskewSpec {
  id: string;
  api: string;
  store: string;
  f: { list: string; asOf: string; selected: string; loading: string; error: string };
  nameField: string;
  valueField: string;
  items: Item[];
  path: string;
  tokenPath: string;
  token: boolean;
  ttlMs: number;
  tokenTtlMs: number;
  marginMs: number;
  checkMs: number;
  fresh: Fresh;
  tokenFresh: Fresh;
  label: string;
  refreshLabel: string;
  changes: number;
}

interface Stamp {
  exp: number;
  srv: number;
  recv: number;
}

export const clockskew: FeatureDef<ClockskewSpec> = {
  kind: "clockskew",
  make({ rng, entity, naming, id, api, clean }) {
    const valueField = entity.nums[0]?.[0] ?? "value";
    const fresh = rng.weighted([["naive", 4], ["offset", 2], ["relative", 3]] as const);
    const tokenFresh = rng.weighted([["naive", 3], ["offset", 2], ["relative", 2]] as const);
    const items = seedItems(rng, entity, rng.int(4, 10), (it) => {
      it.updatedAt = AppEnv.EPOCH - rng.int(60000, 3600000);
    });
    return {
      id,
      api: api.name,
      store: naming.store(entity.p, rng.pick(["feed", "rates", "board", "snapshot", "cache"])),
      f: { list: naming.field("list", id), asOf: naming.field("updated", id), selected: naming.field("selected", id), loading: naming.field("loading", id), error: naming.field("error", id) },
      nameField: entity.name,
      valueField,
      items,
      path: naming.route(entity.p, rng.pick(["latest", "live", "current", ""]).trim() || "latest"),
      tokenPath: naming.route(rng.pick(["auth/token", "oauth/token", "session/refresh"]).replace("/", "-")),
      token: rng.bool(0.5),
      ttlMs: rng.pick([5000, 10000, 15000, 30000, 60000]),
      tokenTtlMs: rng.pick([15000, 30000, 60000, 120000]),
      marginMs: rng.pick([2000, 5000]),
      checkMs: rng.weighted([[250, 1], [500, 2], [1000, 3], [2000, 2], [5000, 1]] as const),
      fresh: clean && fresh === "naive" ? "offset" : fresh,
      tokenFresh: clean && tokenFresh === "naive" ? "relative" : tokenFresh,
      label: `row "${title(entity.s)}"`,
      refreshLabel: `button "${rng.pick(["Refresh", "Reload", "Update", "↻"])}"`,
      changes: rng.int(3, 10),
    };
  },
  pattern(s) {
    return [`fresh:${s.fresh}`, s.token ? `token:${s.tokenFresh}` : "notoken", s.checkMs <= 500 ? "check:tight" : "check:normal"];
  },
  env(_s, rng) {
    const mag = rng.weighted([[0, 3], [rng.float(20000, 60000), 3], [rng.float(60000, 180000), 2], [rng.float(180000, 600000), 1]] as const);
    return { skewMs: mag === 0 ? 0 : Math.round(rng.bool(0.5) ? mag : -mag) };
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:items`;
    for (const it of s.items) db.insert(coll, it, `seed:${it[s.nameField]}`);
    let issued = 0;
    srv.route(
      "GET",
      s.path,
      (req) => {
        if (s.token) {
          const tok = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
          const exp = srv.sessions.get(tok);
          if (exp === undefined || req.t > exp) return { status: 401, body: api.error("token_expired", "access token expired") };
        }
        const now = AppEnv.EPOCH + req.t;
        const exp = now + s.ttlMs;
        return {
          status: 200,
          body: api.list(db.list(coll), { serverTime: now, expiresAt: exp }),
          headers: { date: new Date(now).toUTCString(), expires: new Date(exp).toUTCString(), "cache-control": `max-age=${Math.round(s.ttlMs / 1000)}` },
        };
      },
      { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` },
    );
    if (s.token) {
      srv.route(
        "POST",
        s.tokenPath,
        (req) => {
          issued++;
          const value = `at_${hashAll(s.id, "tok", issued).toString(36)}${hashAll(issued, s.id).toString(36)}`;
          srv.sessions.set(value, req.t + s.tokenTtlMs);
          const now = AppEnv.EPOCH + req.t;
          return { status: 200, body: api.one({ token: value, issuedAt: now, expiresAt: now + s.tokenTtlMs }), headers: { date: new Date(now).toUTCString() } };
        },
        { feature: s.id, kind: "auth", idempotent: false },
      );
    }
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.data`;
    const init: Record<string, unknown> = { [F.list]: [] as Item[], [F.asOf]: null, [F.selected]: null, [F.loading]: false, [F.error]: null };
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.list, 1], [F.asOf, 0.3], [F.selected, 0.6], [F.loading, 0.1], [F.error, 0]]),
      resync: () => load(true, "resync"),
    });
    let data: Stamp | null = null;
    let tok: (Stamp & { value: string }) | null = null;
    let offset = 0;
    let inflight = 0;
    let refreshing: Promise<boolean> | null = null;
    let premData = 0;
    let premTok = 0;
    let lastTokAt = -1e9;
    // Sim knowledge only: the true wall clock (server time), to tell skew-caused decisions from genuine ones.
    const realNow = () => AppEnv.EPOCH + env.now();
    const isFresh = (st: Stamp | null, mode: Fresh, margin = 0): boolean => {
      if (!st) return false;
      const c = env.clientNow();
      if (mode === "naive") return c + margin < st.exp;
      if (mode === "offset") return c + offset + margin < st.exp;
      return c - st.recv + margin < st.exp - st.srv;
    };
    const stampOf = (r: CallResult, body: Record<string, unknown>): Stamp => {
      const recv = env.clientNow();
      const srv = Number(body.serverTime) || Date.parse(r.headers?.get("date") ?? "") || recv;
      const exp = Number(body.expiresAt) || Date.parse(r.headers?.get("expires") ?? "") || srv;
      offset = srv - recv;
      return { exp, srv, recv };
    };
    function ensureToken(intent?: number): Promise<boolean> {
      if (tok && isFresh(tok, s.tokenFresh, s.marginMs)) return Promise.resolve(true);
      if (!refreshing) refreshing = refreshToken(intent).finally(() => (refreshing = null));
      return refreshing;
    }
    async function refreshToken(intent?: number): Promise<boolean> {
      const premature = tok !== null && realNow() + s.marginMs < tok.exp;
      premTok = premature ? premTok + 1 : 0;
      const n = premTok;
      const tight = premature && env.now() - lastTokAt < 1500;
      lastTokAt = env.now();
      const op = kit.op({ role: "token", method: "POST", url: s.tokenPath, body: { grant_type: "refresh_token" }, key: `${s.id}.token`, intent, idempotent: false, background: true, handled: true, ...(tight ? { anomaly: "storm" } : {}), classify: () => (premature && n >= 2 ? "overload" : undefined) });
      const r = await kit.call(op, { timeoutMs: 8000 });
      if (!r.ok) return false;
      const b = kit.api.unone(r.body);
      tok = { value: String(b.token), ...stampOf(r, { serverTime: b.issuedAt, expiresAt: b.expiresAt }) };
      return true;
    }
    async function load(bg: boolean, why: string, intent?: number): Promise<Item[] | null> {
      // A refetch while the data is still fresh by the server's clock happens only because of the skewed clock.
      const premature = why === "refetch" && data !== null && realNow() < data.exp;
      if (why === "refetch") premData = premature ? premData + 1 : 0;
      const n = premData;
      inflight++;
      if (!bg) kit.write(S, (p) => ({ ...p, [F.loading]: true }), { role: "loading", intent, key });
      try {
        const noToken = (): null => {
          kit.write(S, (p) => ({ ...p, [F.loading]: inflight > 1, [F.error]: "Could not refresh your session" }), { role: "error", intent, key });
          if (!bg) kit.shownError();
          return null;
        };
        if (s.token && !(await ensureToken(intent))) return noToken();
        for (let attempt = 1; attempt <= 2; attempt++) {
          const storm = premature && s.checkMs <= 600 ? { anomaly: "storm" } : {};
          const op = kit.op({ role: why, method: "GET", url: s.path, key, intent, background: bg, handled: true, attempt, ...storm, classify: () => (premature && n >= 2 ? "overload" : undefined) });
          const headers: Record<string, string> = {};
          if (tok) headers.authorization = `Bearer ${tok.value}`;
          const r = await kit.call(op, { headers, timeoutMs: 10000 });
          if (r.status === 401 && s.token && attempt === 1) {
            tok = null;
            if (!(await ensureToken(intent))) return noToken();
            continue;
          }
          if (!r.ok) {
            kit.write(S, (p) => ({ ...p, [F.loading]: inflight > 1, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, intent, key });
            if (!bg) kit.shownError();
            return null;
          }
          const { items, extra } = kit.api.unlist(r.body);
          data = stampOf(r, extra);
          const asOf = items.reduce((m, it) => Math.max(m, Number(it.updatedAt) || 0), 0);
          kit.write(S, (p) => ({ ...p, [F.list]: items, [F.asOf]: asOf, [F.loading]: inflight > 1, [F.error]: null }), { role: why === "refetch" ? "refetch" : "load", op, intent, key });
          return items;
        }
        return null;
      } finally {
        inflight--;
      }
    }
    function view(intent: number, idx: number): void {
      const pick = (list: Item[]) => list[idx % Math.max(1, list.length)] ?? null;
      if (isFresh(data, s.fresh)) {
        // Served from memory: wrong when the skewed clock hides that the data already expired.
        const expired = data !== null && realNow() >= data.exp;
        const it = pick((S.get()[F.list] as Item[]) ?? []);
        kit.write(S, (p) => ({ ...p, [F.selected]: it }), { role: "cache", intent, key: `${s.id}.view`, classify: () => (expired ? "stale" : undefined) });
        return;
      }
      kit.spawn(async () => {
        const items = await load(false, "view", intent);
        if (items) kit.write(S, (p) => ({ ...p, [F.selected]: pick(items) }), { role: "view-data", intent, key: `${s.id}.view` });
      }, "swallow");
    }
    return {
      init() {
        kit.spawn(async () => void (await load(true, "initial")), "swallow");
        env.setInterval(() => {
          if (inflight > 0 || refreshing) return;
          if (!isFresh(data, s.fresh)) kit.spawn(async () => void (await load(true, "refetch")), "swallow");
        }, s.checkMs);
        env.on("focus", () => {
          if (inflight === 0 && !isFresh(data, s.fresh)) kit.spawn(async () => void (await load(true, "refetch")), "swallow");
        });
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "view") return view(intent, Number(step.args?.idx ?? 0));
        kit.spawn(async () => void (await load(false, "refresh", intent)), "swallow");
      },
      cond() {
        return inflight > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.8);
    while (t < win.t1 - 800) {
      if (user.rng.bool(0.7)) {
        const idx = user.rng.int(0, s.items.length - 1);
        const target = `${s.label.slice(0, -1)} ${String(s.items[idx]![s.nameField])}"`;
        steps.push({ t, feature: s.id, action: "view", ui: { kind: "click", target }, args: { idx }, intent: { kind: "view", key: `${s.id}.view`, mode: "replace", accidental: false } });
      } else {
        const c = user.click(t, s.refreshLabel, "refresh", { kind: "refresh", key: `${s.id}.refresh`, mode: "replace" }, { pendingCond: "loading" });
        steps.push(...c.steps);
        // Intentional second refresh (checking whether the numbers moved).
        if (user.rng.bool(0.15)) steps.push(...user.click(t + user.rng.float(600, 2200), s.refreshLabel, "refresh", { kind: "refresh", key: `${s.id}.refresh`, mode: "replace" }, { doubleP: 0 }).steps);
      }
      t += user.think(1.6);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    for (let i = 0; i < s.changes; i++) {
      const t = rng.float(win.t0 + 1000, win.t1);
      const idx = rng.int(0, s.items.length - 1);
      const mul = rng.float(0.85, 1.2);
      out.push({
        t,
        feature: s.id,
        desc: `${s.valueField} of item ${idx} changes on the server`,
        apply(w) {
          const coll = `${s.id}:items`;
          const id = w.db.collection(coll).order[idx];
          const it = id ? w.db.get(coll, id) : undefined;
          if (!it || !id) return;
          const v = Math.round(Number(it[s.valueField] ?? 1) * mul * 100) / 100;
          w.db.update(coll, id, { [s.valueField]: v, updatedAt: AppEnv.EPOCH + w.now() }, w.now());
        },
      });
    }
    return out;
  },
};
