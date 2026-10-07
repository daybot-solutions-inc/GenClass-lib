// Session tokens that expire mid-session. Requests get 401 after expiry; the app refreshes (POST refresh with a
// rotating refresh token) and retries. Knobs: single-flight refresh shared by concurrent 401s (guard) or one
// refresh per failed request (duplicate refreshes; the rotated token makes the second fail and logs the user out).

import type { FeatureDef, UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, seedItems, weightsOf } from "./common.js";

export interface AuthSpec {
  id: string;
  api: string;
  store: string;
  dataStore: string;
  f: { user: string; status: string; data: string; error: string };
  refreshPath: string;
  resources: { name: string; path: string; label: string }[];
  ttlMs: number;
  singleFlight: boolean;
  seed: Record<string, unknown[]>;
}

export const auth: FeatureDef<AuthSpec> = {
  kind: "auth",
  make({ rng, domain, naming, id, api }) {
    const resources = rng.sample(domain.entities, Math.min(2, domain.entities.length)).map((e) => ({ name: naming.word(e.p), path: naming.route("me", e.p), label: `tab "${title(e.p)}"` }));
    const seed: Record<string, unknown[]> = {};
    for (const r of resources) seed[r.name] = seedItems(rng, rng.pick(domain.entities), rng.int(1, 4));
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["session", "auth", "account"])),
      dataStore: naming.store(rng.pick(["me", "account", "profile"]), "data"),
      f: { user: rng.pick(["user", "account", "principal"]), status: naming.field("status", id), data: rng.pick(["data", "sections", "panels"]), error: naming.field("error", id) },
      refreshPath: naming.route("auth", rng.pick(["refresh", "token", "session/refresh"]).replace("/", "-")),
      resources,
      ttlMs: rng.int(2500, 9000),
      singleFlight: rng.bool(0.5),
      seed,
    };
  },
  pattern(s) {
    return [s.singleFlight ? "single-flight" : "per-request-refresh"];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const sess = `${s.id}:sess`;
    db.doc(sess, { token: "t0", refresh: "r0", gen: 0 });
    let expiresAt = s.ttlMs;
    for (const r of s.resources) {
      const coll = `${s.id}:${r.name}`;
      for (const it of s.seed[r.name] ?? []) db.insert(coll, it as never, `seed:${JSON.stringify(it)}`);
      srv.route(
        "GET",
        r.path,
        (req) => {
          const tok = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
          const d = db.doc(sess);
          if (tok !== d.fields.token || req.t > expiresAt) return { status: 401, body: api.error("unauthorized", "token expired") };
          return { status: 200, body: api.list(db.list(coll)) };
        },
        { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` },
      );
    }
    srv.route(
      "POST",
      s.refreshPath,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const d = db.doc(sess);
        if (b.refresh !== d.fields.refresh) return { status: 401, body: api.error("invalid_grant", "refresh token reused") };
        const gen = Number(d.fields.gen) + 1;
        db.writeDoc(sess, { token: `t${gen}`, refresh: `r${gen}`, gen }, req.t);
        expiresAt = req.t + s.ttlMs * 3;
        return { status: 200, body: api.one({ token: `t${gen}`, refresh: `r${gen}` }) };
      },
      { feature: s.id, kind: "auth", idempotent: false, resource: `d:${sess}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const S = env.store(s.store, s.id, { [F.user]: "signed-in", [F.status]: "ok", [F.error]: null } as Record<string, unknown>, { weights: weightsOf([[F.user, 1], [F.status, 0.4], [F.error, 0]]) });
    const D = env.store(s.dataStore, s.id, { [F.data]: {} as Record<string, unknown> } as Record<string, unknown>, { weights: weightsOf([[F.data, 1]]) });
    let token = "t0";
    let refresh = "r0";
    let refreshing: Promise<boolean> | null = null;
    const doRefresh = (intent: number | undefined): Promise<boolean> => {
      const run = async () => {
        const inFlight = env.know.ops.find((o) => o.feature === s.id && o.role === "refresh" && o.tEnd === undefined);
        const op = kit.op({ role: "refresh", method: "POST", url: s.refreshPath, body: { refresh }, key: `${s.id}.token`, idempotent: false, background: true, handled: true, ...(intent !== undefined ? { intent } : {}), ...(inFlight ? { dupOf: inFlight.id } : {}) });
        const r = await kit.call(op, { timeoutMs: 8000 });
        if (r.ok) {
          const b = kit.api.unone(r.body);
          token = String(b.token);
          refresh = String(b.refresh);
          return true;
        }
        if (r.status === 401) {
          kit.write(S, (p) => ({ ...p, [F.user]: null, [F.status]: "signed-out", [F.error]: "Your session expired. Please sign in again." }), { role: "logout", op, key: `${s.id}.session` });
          kit.shownError();
        }
        return false;
      };
      if (!s.singleFlight) return run();
      if (!refreshing) refreshing = run().finally(() => (refreshing = null));
      return refreshing;
    };
    async function load(name: string, intent: number | undefined, bg: boolean): Promise<void> {
      const res = s.resources.find((r) => r.name === name)!;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const op = kit.op({ role: `load:${name}`, method: "GET", url: res.path, key: `${s.id}.${name}`, background: bg, attempt, ...(intent !== undefined ? { intent } : {}) });
        const r = await kit.call(op, { headers: { authorization: `Bearer ${token}` }, timeoutMs: 8000 });
        if (r.ok) {
          const items = kit.api.unlist(r.body).items;
          kit.write(D, (p) => ({ ...p, [F.data]: { ...(p[F.data] as Record<string, unknown>), [name]: items } }), { role: "data", op, key: `${s.id}.${name}` });
          return;
        }
        if (r.status !== 401 || attempt === 2) return;
        if (S.get()[F.user] === null) return;
        const ok = await doRefresh(intent);
        if (!ok) return;
      }
    }
    return {
      init() {
        for (const r of s.resources) kit.spawn(() => load(r.name, undefined, true), "swallow");
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "open-all") {
          for (const r of s.resources) kit.spawn(() => load(r.name, intent, false), "swallow");
          return;
        }
        kit.spawn(() => load(String(step.args?.res), intent, false), "swallow");
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(1.5);
    while (t < win.t1 - 800) {
      if (user.rng.bool(0.5)) steps.push({ t, feature: s.id, action: "open-all", ui: { kind: "click", target: `button "${user.rng.pick(["Refresh all", "Sync", "Reload"])}"` }, intent: { kind: "open", key: `${s.id}.open`, mode: "replace", accidental: false } });
      else {
        const r = user.rng.pick(s.resources);
        steps.push({ t, feature: s.id, action: "open", ui: { kind: "click", target: r.label }, args: { res: r.name }, intent: { kind: "open", key: `${s.id}.open.${r.name}`, mode: "replace", accidental: false } });
      }
      t += user.think(2);
    }
    return steps;
  },
};
