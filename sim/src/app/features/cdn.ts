// Public content read through a CDN edge cache (pages, listings, profiles). The edge keeps one snapshot per URL
// (path + query) for `ttlMs` and serves it with `age` / `x-cache: HIT`, even after writes, unless a purge removed
// it. Writes go to the origin, which purges the edge; but a fill that was still on its way from the origin (its
// read happened before the write landed) survives the purge and then serves pre-write data for a full TTL (the
// purge race). Under ideal timing the app's reads never race its writes, so stale reads come from latency. The app
// edits the page in place, saves it (PUT/PATCH) and reads it back. Knobs: re-read without cache busting (the stale
// CDN copy overwrites the fresh echo), cache-busting query param, write response only, or re-read with a version
// check; refetch-on-mutate (a read racing the write) vs after it; auto-refresh through the CDN.

import type { Db, Json } from "../../net/server.js";
import type { ExternalEvent, FeatureDef, UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, weightsOf } from "./common.js";

export interface CdnSpec {
  id: string;
  api: string;
  store: string;
  f: { version: string; saving: string; error: string };
  fields: string[];
  init: Record<string, string>;
  docId: string;
  path: string;
  method: "PUT" | "PATCH";
  ttlMs: number;
  fillMs: number;
  invalidate: "on-mutate" | "after";
  after: "reread" | "bust" | "echo" | "version";
  bustParam: string;
  autoMs: number;
  words: string[];
  labels: Record<string, string>;
  saveLabel: string;
  reloadLabel: string;
  edits: number;
}

const edgeKey = (s: CdnSpec, k: string) => `${s.id}:edge:${k}`;
const docName = (s: CdnSpec) => `${s.id}:page:${s.docId}`;

/** Purge edge entries whose fill completed by `t`; fills still on their way from the origin survive. */
function purge(db: Db, s: CdnSpec, t: number): void {
  for (const [k, v] of [...db.kv]) {
    if (!k.startsWith(edgeKey(s, ""))) continue;
    const at = v && typeof v === "object" && !Array.isArray(v) ? Number(v.at) : 0;
    if (at <= t) db.kv.delete(k);
  }
}

export const cdn: FeatureDef<CdnSpec> = {
  kind: "cdn",
  make({ rng, domain, naming, id, api, clean }) {
    const [noun, fields] = rng.pick(domain.docs);
    const fs = fields.map((f) => naming.word(f));
    const init: Record<string, string> = {};
    const labels: Record<string, string> = {};
    for (const f of fs) {
      init[f] = `${title(noun)} ${rng.pick(domain.entities).words.slice(0, 2).join(" ")}`;
      labels[f] = `${/title|name|head|subject/i.test(f) ? "input" : "textarea"} "${title(f)}"`;
    }
    const last = noun.split(" ").slice(-1)[0]!;
    return {
      id,
      api: api.name,
      store: naming.store(last, rng.pick(["page", "public", "listing", "live"])),
      f: { version: naming.field("version", id), saving: naming.field("saving", id), error: naming.field("error", id) },
      fields: fs,
      init,
      docId: String(rng.int(10, 9999)),
      path: naming.route(rng.pick(["pages", "public", "content", "published"]), `${last}s`, ":id"),
      method: rng.bool(0.6) ? "PUT" : "PATCH",
      ttlMs: rng.pick([5000, 10000, 30000, 60000]),
      fillMs: rng.int(150, 900),
      invalidate: clean ? "after" : rng.weighted([["after", 3], ["on-mutate", 2]] as const),
      after: clean ? rng.pick(["bust", "echo", "version"] as const) : rng.weighted([["reread", 4], ["bust", 2], ["echo", 2], ["version", 2]] as const),
      bustParam: rng.pick(["v", "rev", "_", "t", "nocache"]),
      autoMs: rng.weighted([[0, 2], [rng.int(4000, 15000), 3]] as const),
      words: rng.shuffle(domain.entities.flatMap((e) => e.words)).slice(0, 20),
      labels,
      saveLabel: `button "${rng.pick(["Save", "Publish", "Update page", "Save changes"])}"`,
      reloadLabel: `button "${rng.pick(["Reload", "Refresh", "View live", "Preview"])}"`,
      edits: rng.weighted([[0, 2], [1, 2], [2, 1]] as const),
    };
  },
  pattern(s) {
    return [`after:${s.after}`, `invalidate:${s.invalidate}`, s.autoMs ? "auto" : "noauto"];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const name = docName(s);
    db.doc(name, s.init);
    const origin = (): Record<string, Json> => {
      const d = db.doc(name);
      return { id: s.docId, ...d.fields, version: d.version };
    };
    const cc = { "cache-control": `public, max-age=${Math.round(s.ttlMs / 1000)}` };
    srv.route(
      "GET",
      s.path,
      (req) => {
        const k = edgeKey(s, `${req.path}?${req.query.toString()}`);
        const e = db.kv.get(k);
        // HIT (a fill still in flight is shared too: request collapsing at the edge).
        if (e && typeof e === "object" && !Array.isArray(e) && req.t - Number(e.at) < s.ttlMs) {
          const age = Math.max(0, Math.floor((req.t - Number(e.at)) / 1000));
          return { status: 200, body: api.one({ ...(e.body as Record<string, Json>), age }), headers: { ...cc, age: String(age), "x-cache": "HIT" } };
        }
        const body = origin();
        // MISS: the fill lands in the edge only once the origin fetch completes.
        db.kv.set(k, { body, at: req.t + s.fillMs });
        return { status: 200, body: api.one({ ...body, age: 0 }), headers: { ...cc, age: "0", "x-cache": "MISS" } };
      },
      { feature: s.id, kind: "read", idempotent: true, resource: `d:${name}` },
    );
    srv.route(
      s.method,
      s.path,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const patch: Record<string, string> = {};
        for (const f of s.fields) if (typeof b[f] === "string") patch[f] = b[f] as string;
        db.writeDoc(name, patch, req.t);
        purge(db, s, req.t);
        return { status: 200, body: api.one(origin()), headers: { "cache-control": "no-store" } };
      },
      { feature: s.id, kind: "write", idempotent: true, resource: `d:${name}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.page`;
    const url = s.path.replace(":id", s.docId);
    const sig = (v: Record<string, unknown>) => s.fields.map((f) => String(v[f] ?? "")).join("\u0001");
    const fieldsOf = (doc: Record<string, unknown>) => {
      const o: Record<string, unknown> = {};
      for (const f of s.fields) if (typeof doc[f] === "string") o[f] = doc[f];
      return o;
    };
    const wts: [string, number][] = s.fields.map((f) => [f, 1] as [string, number]);
    wts.push([F.version, 0], [F.saving, 0.12], [F.error, 0]);
    const S = env.store(s.store, s.id, { ...s.init, [F.version]: 1, [F.saving]: false, [F.error]: null } as Record<string, unknown>, {
      weights: weightsOf(wts),
      resync: () => read("resync", undefined, true, true),
    });
    let savedVersion = 0;
    let inflight = 0;
    let dirty = false;
    async function read(role: string, intent: number | undefined, bg: boolean, bust: boolean): Promise<void> {
      // Background refreshes never clobber a form that is being edited or saved.
      if (role === "poll-result" && (dirty || inflight > 0)) return;
      const v0 = s.bustParam === "v" || s.bustParam === "rev" ? String(savedVersion) : String(env.clientNow());
      const op = kit.op({ role, method: "GET", url: bust ? `${url}?${s.bustParam}=${v0}` : url, key, background: bg, ...(intent !== undefined ? { intent } : {}) });
      const r = await kit.call(op, { timeoutMs: 8000 });
      if (!r.ok) {
        if (!bg) {
          kit.write(S, (p) => ({ ...p, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, key });
          kit.shownError();
        }
        return;
      }
      const doc = kit.api.unone(r.body);
      const v = Number(doc.version);
      if (s.after === "version" && v < savedVersion) return; // guard: older than our own confirmed write
      const classify = () => {
        const cur = S.get();
        if (sig(doc) === sig(cur)) return undefined; // nothing on screen would change
        const shown = Number(cur[F.version]);
        if (v < shown) return "stale";
        // Same version but different content while local edits are unsaved / in flight: pre-write data.
        if ((inflight > 0 || dirty || v < savedVersion) && v <= shown) return "stale";
        return undefined;
      };
      kit.write(S, (p) => ({ ...p, ...fieldsOf(doc), [F.version]: v, [F.error]: null }), { role, op, key, classify, ...(intent !== undefined ? { intent } : {}) });
    }
    function save(intent: number): void {
      const it = env.know.getIntent(intent);
      const cur = S.get();
      const body: Record<string, unknown> = {};
      for (const f of s.fields) body[f] = cur[f];
      const sent = sig(cur);
      inflight++;
      dirty = false;
      kit.write(S, (p) => ({ ...p, [F.saving]: true, [F.error]: null }), { role: "saving", intent, key });
      const op = kit.op({ role: "save", method: s.method, url, body, intent, key, idempotent: true, ...(it?.accidental ? { dupOf: it.repeatOf ?? -1 } : {}) });
      kit.spawn(
        async () => {
          const pending = kit.call(op, { timeoutMs: 10000 });
          // Refetch-on-mutate: the invalidation read is sent right after the write and may reach the edge first.
          if (s.invalidate === "on-mutate") kit.spawn(() => read("refetch", intent, true, false), "swallow");
          const r = await pending;
          inflight--;
          const still = inflight > 0;
          if (!r.ok) {
            dirty = true;
            kit.write(S, (p) => ({ ...p, [F.saving]: still, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, intent, key });
            kit.shownError();
            return;
          }
          const doc = kit.api.unone(r.body);
          const v = Number(doc.version);
          savedVersion = Math.max(savedVersion, v);
          kit.write(S, (p) => ({ ...p, ...(sig(p) === sent ? fieldsOf(doc) : {}), [F.version]: Math.max(v, Number(p[F.version])), [F.saving]: still }), { role: "echo", op, intent, key });
          if (s.after === "echo") return;
          await read(s.after === "bust" ? "confirm" : "refetch", intent, false, s.after === "bust");
        },
        "uncaught",
        { cause: "save-failed", diagnosis: "failing", op },
      );
    }
    return {
      init() {
        kit.spawn(() => read("load", undefined, true, false), "swallow");
        if (s.autoMs) env.setInterval(() => kit.spawn(() => read("poll-result", undefined, true, false), "swallow"), s.autoMs);
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "save") return save(intent);
        if (step.action === "reload") return kit.spawn(() => read("refetch", intent, false, false), "uncaught", { cause: "reload-failed", diagnosis: "failing" });
        const field = String(step.args?.field ?? s.fields[0]);
        dirty = true;
        kit.write(S, (p) => ({ ...p, [field]: String(step.ui.value ?? "") }), { role: "input", intent, key });
      },
      cond() {
        return inflight > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    const cur: Record<string, string> = { ...s.init };
    const reload = (t: number) => user.click(t, s.reloadLabel, "reload", { kind: "reload", key: `${s.id}.reload`, mode: "replace" }, { doubleP: 0 }).steps;
    let t = win.t0 + user.think(0.7);
    while (t < win.t1 - 1200) {
      if (user.rng.bool(0.15)) {
        steps.push(...reload(t));
        t += user.think();
        continue;
      }
      const field = user.rng.pick(s.fields);
      const add = ` ${user.rng.pick(s.words)}${user.rng.bool(0.4) ? " " + user.rng.pick(s.words) : ""}`;
      const typed = user.type(t, cur[field]!, add, s.labels[field]!, "edit", `${s.id}.page`, { field });
      for (const st of typed.steps) st.intent.kind = "edit";
      steps.push(...typed.steps);
      if (typed.steps.length) cur[field] = String(typed.steps[typed.steps.length - 1]!.ui.value);
      t = typed.t + user.rng.float(200, 1100);
      steps.push(...user.click(t, s.saveLabel, "save", { kind: "save", key: `${s.id}.save`, mode: "replace" }, { pendingCond: "saving" }).steps);
      // Check the live page right after publishing (a read through the CDN).
      let next = t + user.think(1.4);
      if (user.rng.bool(0.35)) {
        const tr = t + user.rng.float(600, 2500);
        steps.push(...reload(tr));
        next = Math.max(next, tr + user.think(0.6));
      }
      t = next;
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    for (let i = 0; i < s.edits; i++) {
      const field = rng.pick(s.fields);
      const add = ` ${rng.pick(s.words)}`;
      out.push({
        t: rng.float(win.t0 + 2000, Math.max(win.t0 + 2100, win.t1 - 1000)),
        feature: s.id,
        desc: `another editor changes ${field}`,
        apply(w) {
          const name = docName(s);
          w.db.writeDoc(name, { [field]: String(w.db.doc(name).fields[field] ?? "") + add }, w.now());
          purge(w.db, s, w.now());
        },
      });
    }
    return out;
  },
};
