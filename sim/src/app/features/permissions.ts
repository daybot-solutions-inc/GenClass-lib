// Role-based permissions that change mid-session. The app loads GET /me/permissions at start and enables its write
// controls from it; an admin downgrades the user (editor -> viewer) at some point (server-side flag), optionally
// restoring access later, so writes start returning 403. Writes sent just before the change land after it under
// latency, and the app learns about the change by a live push, a periodic permission poll, or only from the first
// 403. Knobs: on 403 refetch permissions and disable the controls (guard), refetch but forget to recompute the
// derived `canEdit` flag (partial), keep the controls enabled and just show an error, or retry the write (repeated
// 403s); optimistic toggles with or without rollback on 403; live permission pushes; permission polling.

import type { Item } from "../../net/server.js";
import { rel, type ExternalEvent, type FeatureDef, type UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface PermissionsSpec {
  id: string;
  api: string;
  permStore: string;
  dataStore: string;
  f: { role: string; canEdit: string; list: string; saving: string; error: string };
  nameField: string;
  flag: string;
  items: Item[];
  permPath: string;
  listPath: string;
  itemPath: string;
  topic: string;
  writer: string;
  on403: "refetch" | "refetch-partial" | "ignore" | "retry";
  optimistic: boolean;
  rollback: boolean;
  live: boolean;
  pollMs: number;
  restore: boolean;
  label: string;
}

const canWrite = (role: string) => role !== "viewer";

export const permissions: FeatureDef<PermissionsSpec> = {
  kind: "permissions",
  make({ rng, entity, naming, id, api, clean }) {
    const flag = entity.flags[0] ?? rng.pick(["pinned", "starred", "archived", "shared"]);
    return {
      id,
      api: api.name,
      permStore: naming.store(rng.pick(["me", "access", "permissions", "account"])),
      dataStore: naming.store(entity.p, rng.pick(["admin", "manage", "shared", "workspace"])),
      f: { role: naming.word(rng.pick(["role", "accessLevel", "membership"])), canEdit: naming.word(rng.pick(["canEdit", "canWrite", "editable", "writeAccess"])), list: naming.field("list", id), saving: naming.field("saving", id), error: naming.field("error", id) },
      nameField: entity.name,
      flag,
      items: seedItems(rng, entity, rng.int(3, 8), (it) => {
        it[flag] = rng.bool(0.3);
      }),
      permPath: naming.route("me", rng.pick(["permissions", "access", "roles"])),
      listPath: naming.route(entity.p),
      itemPath: naming.route(entity.p, ":id"),
      topic: `${rng.pick(["acl", "access", "membership"])}-${rng.pick(["changes", "events", "live"])}`,
      writer: rng.pick(["editor", "member", "admin", "owner"]),
      on403: clean ? "refetch" : rng.weighted([["refetch", 3], ["refetch-partial", 2], ["ignore", 3], ["retry", 2]] as const),
      optimistic: rng.bool(0.6),
      rollback: clean ? true : rng.bool(0.5),
      live: rng.bool(0.4),
      pollMs: rng.weighted([[0, 3], [rng.int(5000, 20000), 2]] as const),
      restore: rng.bool(0.35),
      label: `switch "${title(flag)}"`,
    };
  },
  pattern(s) {
    return [`on403:${s.on403}`, s.optimistic ? (s.rollback ? "optimistic+rollback" : "optimistic-norollback") : "pessimistic", s.live ? "live" : "nolive", s.pollMs ? "poll" : "nopoll"];
  },
  relations(s) {
    const C = `${s.permStore}.${s.f.canEdit}`;
    const R = `${s.permStore}.${s.f.role}`;
    return [{ fields: [C, R], desc: "write controls are enabled exactly when the role allows writing", check: (st) => rel.field(st, C) === canWrite(String(rel.field(st, R))) }];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:items`;
    const roleKey = `${s.id}:role`;
    for (const it of s.items) db.insert(coll, it, `seed:${String(it[s.nameField])}`);
    db.kv.set(roleKey, s.writer);
    const role = () => String(db.kv.get(roleKey) ?? s.writer);
    srv.route("GET", s.permPath, () => ({ status: 200, body: api.one({ role: role(), permissions: canWrite(role()) ? ["read", "write"] : ["read"] }) }), { feature: s.id, kind: "auth", idempotent: true });
    srv.route("GET", s.listPath, () => ({ status: 200, body: api.list(db.list(coll)) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
    srv.route(
      "PATCH",
      s.itemPath,
      (req) => {
        if (!canWrite(role())) return { status: 403, body: api.error("forbidden", "You no longer have edit access to this workspace") };
        const b = (req.body ?? {}) as Record<string, unknown>;
        const it = db.update(coll, String(req.params.id), { [s.flag]: b[s.flag] === true }, req.t);
        if (!it) return { status: 404, body: api.error("not_found", "gone") };
        return { status: 200, body: api.one(it) };
      },
      { feature: s.id, kind: "write", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const P = env.store(s.permStore, s.id, { [F.role]: s.writer, [F.canEdit]: true } as Record<string, unknown>, {
      weights: weightsOf([[F.role, 0.3], [F.canEdit, 0.3]]),
      resync: () => loadPerms(true, "resync"),
    });
    const D = env.store(s.dataStore, s.id, { [F.list]: [] as Item[], [F.saving]: false, [F.error]: null } as Record<string, unknown>, {
      weights: weightsOf([[F.list, 1], [F.saving, 0.1], [F.error, 0]]),
      resync: () => loadList(true),
    });
    let saving = 0;
    const pkey = `${s.id}.perms`;
    const setFlag = (id: string, v: unknown) => (p: Record<string, unknown>) => ({ ...p, [F.list]: ((p[F.list] as Item[]) ?? []).map((x) => (x.id === id ? { ...x, [s.flag]: v as boolean } : x)) });
    async function loadPerms(bg: boolean, why: string): Promise<void> {
      const op = kit.op({ role: "permissions", method: "GET", url: s.permPath, key: pkey, background: bg });
      const r = await kit.call(op, { timeoutMs: 8000 });
      if (!r.ok) return;
      const b = kit.api.unone(r.body);
      const role = String(b.role);
      const can = Array.isArray(b.permissions) && b.permissions.includes("write");
      // Defect: the 403 handler stores the new role but forgets the derived flag.
      const partial = s.on403 === "refetch-partial" && why === "403";
      const breaks = partial && P.get()[F.canEdit] !== can;
      kit.write(P, (p) => ({ ...p, [F.role]: role, ...(partial ? {} : { [F.canEdit]: can }) }), { role: "load", op, key: pkey, ...(breaks ? { anomaly: "partial" } : {}) });
    }
    async function loadList(bg: boolean, intent?: number): Promise<void> {
      const op = kit.op({ role: "load", method: "GET", url: s.listPath, key: `${s.id}.list`, background: bg, ...(intent !== undefined ? { intent } : {}) });
      const r = await kit.call(op, { timeoutMs: 8000 });
      if (r.ok) kit.write(D, (p) => ({ ...p, [F.list]: kit.api.unlist(r.body).items }), { role: "load", op, key: `${s.id}.list` });
    }
    function toggle(intent: number, idx: number): void {
      if (P.get()[F.canEdit] !== true) return; // controls are disabled
      const list = (D.get()[F.list] as Item[]) ?? [];
      const item = list[idx % Math.max(1, list.length)];
      if (!item) return;
      const id = String(item.id);
      const prev = item[s.flag] === true;
      const next = !prev;
      const key = `${s.id}.item.${idx}`;
      const it = env.know.getIntent(intent);
      if (s.optimistic) kit.write(D, setFlag(id, next), { role: "optimistic", intent, key });
      saving++;
      kit.write(D, (p) => ({ ...p, [F.saving]: true, [F.error]: null }), { role: "saving", intent, key });
      const send = async (attempt: number, retryOf?: number): Promise<void> => {
        const op = kit.op({ role: "toggle", method: "PATCH", url: s.itemPath.replace(":id", encodeURIComponent(id)), body: { [s.flag]: next }, intent, key, idempotent: true, attempt, handled: s.on403 === "retry", ...(retryOf !== undefined ? { retryOf } : {}), ...(it?.accidental && attempt === 1 ? { dupOf: it.repeatOf ?? -1 } : {}) });
        const r = await kit.call(op, { timeoutMs: 8000 });
        if (r.status === 403 && s.on403 === "retry" && attempt < 3) {
          await env.sleep(400 * attempt);
          return send(attempt + 1, op.id);
        }
        saving--;
        const busy = saving > 0;
        if (r.ok) {
          const srv = kit.api.unone(r.body);
          kit.write(D, (p) => ({ ...setFlag(id, srv[s.flag] === true)(p), [F.saving]: busy }), { role: "echo", op, intent, key });
          return;
        }
        const undo = s.optimistic && s.rollback;
        kit.write(D, (p) => ({ ...(undo ? setFlag(id, prev)(p) : p), [F.saving]: busy, [F.error]: r.status === 403 ? "You don't have permission to change this" : errMsg(r.status, r.outcome) }), { role: undo ? "rollback" : "error", op, intent, key });
        kit.shownError();
        if (r.status === 403 && (s.on403 === "refetch" || s.on403 === "refetch-partial")) await loadPerms(true, "403");
      };
      kit.spawn(() => send(1), "uncaught", { cause: "toggle-failed", diagnosis: "failing" });
    }
    return {
      init() {
        kit.spawn(async () => {
          await loadPerms(true, "init");
          await loadList(true);
        }, "swallow");
        if (s.pollMs) env.setInterval(() => kit.spawn(() => loadPerms(true, "poll"), "swallow"), s.pollMs);
        if (s.live) {
          env.socket(s.topic, (msg) => {
            const role = String((msg as Record<string, unknown>).role);
            kit.write(P, (p) => ({ ...p, [F.role]: role, [F.canEdit]: canWrite(role) }), { role: "push", key: pkey });
          });
        }
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "reload") return kit.spawn(() => loadList(false, intent), "swallow");
        toggle(intent, Number(step.args?.item ?? 0));
      },
      cond() {
        return saving > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.8);
    while (t < win.t1 - 800) {
      const i = user.rng.int(0, s.items.length - 1);
      const target = `${s.label.slice(0, -1)}: ${String(s.items[i]![s.nameField])}"`;
      const key = `${s.id}.item.${i}`;
      if (user.rng.bool(0.12)) steps.push(...user.click(t, `button "${user.rng.pick(["Reload", "Refresh"])}"`, "reload", { kind: "reload", key: `${s.id}.reload`, mode: "replace" }).steps);
      else {
        steps.push(...user.click(t, target, "toggle", { kind: "toggle", key, mode: "replace" }, { args: { item: i }, pendingCond: "saving", kind: "change" }).steps);
        // Quick correction: flip it back.
        if (user.rng.bool(0.15)) steps.push(...user.click(t + user.rng.float(400, 1500), target, "toggle", { kind: "toggle", key, mode: "replace" }, { args: { item: i }, kind: "change", doubleP: 0 }).steps);
      }
      t += user.think(1.3);
    }
    return steps;
  },
  external(s, rng, win, steps) {
    const mine = steps.filter((st) => st.action === "toggle");
    // The admin acts while the user is working: between 30% and 70% of their toggles (or of the session).
    const tRevoke = mine.length >= 3 ? mine[Math.floor(mine.length * rng.float(0.3, 0.7))]!.t + rng.float(-800, 800) : rng.float(win.t0 + (win.t1 - win.t0) * 0.3, win.t0 + (win.t1 - win.t0) * 0.7);
    const set = (role: string, desc: string, t: number): ExternalEvent => ({
      t,
      feature: s.id,
      desc,
      apply(w) {
        w.db.kv.set(`${s.id}:role`, role);
        if (s.live) w.publish(s.topic, { role });
      },
    });
    const out = [set("viewer", "an admin downgrades the user to viewer", tRevoke)];
    if (s.restore) out.push(set(s.writer, "an admin restores edit access", tRevoke + rng.float(6000, 25000)));
    return out;
  },
};
