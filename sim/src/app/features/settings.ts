// Settings panel: each toggle/select PATCHes one key; the server echoes the full settings object. Knobs: echo
// applied in full (a slower earlier response reverts a newer local change: stale), only the changed key, or
// ignored; per-request sequence guard; serialized writes (queue).

import type { FeatureDef, UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, weightsOf } from "./common.js";

export interface SettingsSpec {
  id: string;
  api: string;
  store: string;
  f: { values: string; saving: string; error: string };
  keys: string[];
  init: Record<string, boolean>;
  path: string;
  echo: "full" | "key" | "none";
  seqGuard: boolean;
  serialize: boolean;
  rollback: boolean;
  labels: Record<string, string>;
}

export const settings: FeatureDef<SettingsSpec> = {
  kind: "settings",
  make({ rng, domain, naming, id, api }) {
    const keys = rng.sample(domain.settings, Math.min(domain.settings.length, rng.int(2, 3))).map((k) => naming.word(k));
    const init: Record<string, boolean> = {};
    const labels: Record<string, string> = {};
    for (const k of keys) {
      init[k] = rng.bool(0.5);
      labels[k] = `switch "${title(k)}"`;
    }
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["settings", "preferences", "prefs", "config"])),
      f: { values: naming.field("value", id), saving: naming.field("saving", id), error: naming.field("error", id) },
      keys,
      init,
      path: naming.route(rng.pick(["settings", "preferences", "me/settings", "account/prefs"]).replace("/", "-")),
      echo: rng.weighted([["full", 4], ["key", 2], ["none", 2]] as const),
      seqGuard: rng.bool(0.3),
      serialize: rng.bool(0.25),
      rollback: rng.bool(0.5),
      labels,
    };
  },
  pattern(s) {
    return [`echo:${s.echo}`, s.seqGuard ? "seq" : "noseq", s.serialize ? "serialize" : "parallel", s.rollback ? "rollback" : "norollback"];
  },
  server(s, srv, db) {
    const name = `${s.id}:settings`;
    db.doc(name, s.init);
    const api = apiOf(s.api);
    srv.route("GET", s.path, () => ({ status: 200, body: api.one({ ...db.doc(name).fields }) }), { feature: s.id, kind: "read", idempotent: true, resource: `d:${name}` });
    srv.route(
      "PATCH",
      s.path,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const patch: Record<string, boolean> = {};
        for (const k of s.keys) if (typeof b[k] === "boolean") patch[k] = b[k] as boolean;
        db.writeDoc(name, patch, req.t);
        return { status: 200, body: api.one({ ...db.doc(name).fields }) };
      },
      { feature: s.id, kind: "write", idempotent: true, resource: `d:${name}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const S = env.store(s.store, s.id, { [F.values]: { ...s.init }, [F.saving]: false, [F.error]: null } as Record<string, unknown>, {
      weights: weightsOf([[F.values, 1], [F.saving, 0.1], [F.error, 0]]),
      resync: async () => {
        const op = kit.op({ role: "resync", method: "GET", url: s.path, key: `${s.id}.values`, background: true });
        const r = await kit.call(op);
        if (r.ok) kit.write(S, (p) => ({ ...p, [F.values]: kit.api.unone(r.body) }), { role: "resync", op, key: `${s.id}.values` });
      },
    });
    let seq = 0;
    let inflight = 0;
    let chain: Promise<void> = Promise.resolve();
    function change(intent: number, k: string, v: boolean): void {
      const key = `${s.id}.${k}`;
      const before = (S.get()[F.values] as Record<string, boolean>)[k];
      kit.write(S, (p) => ({ ...p, [F.values]: { ...(p[F.values] as Record<string, boolean>), [k]: v } }), { role: "input", intent, key });
      const my = ++seq;
      const run = async () => {
        inflight++;
        kit.write(S, (p) => ({ ...p, [F.saving]: true }), { role: "saving", intent, key });
        const op = kit.op({ role: "patch", method: "PATCH", url: s.path, body: { [k]: v }, intent, key, idempotent: true });
        const r = await kit.call(op, { timeoutMs: 8000 });
        inflight--;
        if (r.ok) {
          if (s.seqGuard && my !== seq) {
            kit.write(S, (p) => ({ ...p, [F.saving]: inflight > 0 }), { role: "saving", op, key });
            return;
          }
          const srv = kit.api.unone(r.body) as Record<string, boolean>;
          const classify = () => {
            const cur = S.get()[F.values] as Record<string, boolean>;
            for (const kk of s.keys) {
              if (srv[kk] !== cur[kk]) {
                const latest = env.know.latestIntent(`${s.id}.${kk}`);
                if (latest && latest.t > op.t0) return "stale";
              }
            }
            return undefined;
          };
          if (s.echo === "full") kit.write(S, (p) => ({ ...p, [F.values]: { ...srv }, [F.saving]: inflight > 0 }), { role: "echo", op, intent, key, classify });
          else if (s.echo === "key") kit.write(S, (p) => ({ ...p, [F.values]: { ...(p[F.values] as Record<string, boolean>), [k]: srv[k] === true }, [F.saving]: inflight > 0 }), { role: "echo", op, intent, key, classify });
          else kit.write(S, (p) => ({ ...p, [F.saving]: inflight > 0 }), { role: "saving", op, key });
          return;
        }
        const patch: Record<string, unknown> = { [F.saving]: inflight > 0, [F.error]: errMsg(r.status, r.outcome) };
        kit.write(S, (p) => ({ ...p, ...patch, ...(s.rollback ? { [F.values]: { ...(p[F.values] as Record<string, boolean>), [k]: before } } : {}) }), { role: s.rollback ? "rollback" : "error", op, intent, key });
        kit.shownError();
      };
      if (s.serialize) {
        chain = chain.then(run, run);
        void chain.catch(() => undefined);
      } else kit.spawn(run, "uncaught", { cause: "settings-failed", diagnosis: "failing" });
    }
    return {
      init() {
        kit.spawn(async () => {
          const op = kit.op({ role: "load", method: "GET", url: s.path, key: `${s.id}.values`, background: true });
          const r = await kit.call(op);
          if (r.ok) kit.write(S, (p) => ({ ...p, [F.values]: kit.api.unone(r.body) }), { role: "load", op, key: `${s.id}.values` });
        }, "swallow");
      },
      handle(step: UserStep, intent: number) {
        change(intent, String(step.args?.key), step.ui.value === "on");
      },
      cond() {
        return inflight > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    const cur = { ...s.init };
    let t = win.t0 + user.think(0.8);
    while (t < win.t1 - 800) {
      const k = user.rng.pick(s.keys);
      const n = user.rng.weighted([[1, 5], [2, 2], [3, 1]] as const);
      for (let i = 0; i < n; i++) {
        cur[k] = !cur[k];
        steps.push({ t, feature: s.id, action: "set", ui: { kind: "change", target: s.labels[k]!, value: cur[k] ? "on" : "off" }, args: { key: k }, intent: { kind: "set", key: `${s.id}.${k}`, mode: "replace", accidental: false } });
        t += user.rng.float(200, 900);
      }
      t += user.think();
    }
    return steps;
  },
};
