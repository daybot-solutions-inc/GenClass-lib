// Autosave with ETag / If-Match. GET returns the document with an ETag header; each PUT carries If-Match and the
// server answers 412 Precondition Failed when the document changed since (another user, or our own overlapping
// save). Knobs: conditional PUT or blind PUT (other users' edits silently overwritten), 412 handling (refetch +
// three-way merge + resend; force = resend without If-Match, a lost update; reload = take the server copy and
// drop local edits), echo application (only when the text is unchanged since the save was sent, or always: an
// older echo over newer typing), serialized saves (overlapping conditional saves 412 each other).

import type { SimOp } from "../../oracle/knowledge.js";
import { hashAll, type Rng } from "../../rng.js";
import type { ExternalEvent, FeatureDef, UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, weightsOf } from "./common.js";

export interface EtagSpec {
  id: string;
  api: string;
  store: string;
  docId: string;
  fields: string[];
  init: Record<string, string>;
  f: { etag: string; saving: string; saved: string; error: string };
  path: string;
  weak: boolean;
  ifMatch: boolean;
  on412: "merge" | "force" | "reload";
  echo: "if-unchanged" | "always";
  serialize: boolean;
  debounceMs: number;
  timeoutMs: number;
  words: string[];
  labels: Record<string, string>;
  saveLabel: string;
  externalEdits: number;
}

function knob<T>(rng: Rng, clean: boolean | undefined, good: T, opts: readonly (readonly [T, number])[]): T {
  const v = rng.weighted(opts);
  return clean ? good : v;
}

export const etag: FeatureDef<EtagSpec> = {
  kind: "etag",
  make({ rng, clean, domain, naming, id, api }) {
    const [noun, fields] = rng.pick(domain.docs);
    const fs = fields.map((f) => naming.word(f));
    const init: Record<string, string> = {};
    const labels: Record<string, string> = {};
    for (const f of fs) {
      init[f] = `${title(noun)} ${rng.pick(domain.entities).words.slice(0, 2).join(" ")}`;
      labels[f] = `${/title|head|name/i.test(f) ? "input" : "textarea"} "${title(f)}"`;
    }
    const last = noun.split(" ").slice(-1)[0]!;
    return {
      id,
      api: api.name,
      store: naming.store(last, rng.pick(["doc", "draft", "page", "record"])),
      docId: String(rng.int(10, 9999)),
      fields: fs,
      init,
      f: { etag: rng.pick(["etag", "rev", "revision"]), saving: naming.field("saving", id), saved: naming.field("saved", id), error: naming.field("error", id) },
      path: naming.route(`${last}s`, ":id"),
      weak: rng.bool(0.3),
      ifMatch: knob(rng, clean, true, [[true, 3], [false, 1]] as const),
      on412: knob(rng, clean, "merge", [["merge", 3], ["force", 2], ["reload", 1]] as const),
      echo: knob(rng, clean, "if-unchanged", [["if-unchanged", 1], ["always", 1]] as const),
      serialize: knob(rng, clean, true, [[true, 1], [false, 1]] as const),
      debounceMs: rng.int(300, 1500),
      timeoutMs: rng.weighted([[0, 2], [rng.int(3000, 9000), 2]] as const),
      words: rng.shuffle(domain.entities.flatMap((e) => e.words)).slice(0, 24),
      labels,
      saveLabel: `button "${rng.pick(["Save", "Save changes", "Update"])}"`,
      externalEdits: rng.weighted([[0, 1], [1, 2], [2, 2], [3, 1]] as const),
    };
  },
  pattern(s) {
    return [s.ifMatch ? "if-match" : "blind", `412:${s.on412}`, `echo:${s.echo}`, s.serialize ? "serialize" : "overlap"];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const name = `${s.id}:doc:${s.docId}`;
    db.doc(name, s.init);
    const tag = () => `${s.weak ? "W/" : ""}"${hashAll(name, db.doc(name).version).toString(36)}"`;
    const out = () => api.one({ id: s.docId, ...db.doc(name).fields });
    srv.route("GET", s.path, () => ({ status: 200, body: out(), headers: { etag: tag() } }), { feature: s.id, kind: "read", idempotent: true, resource: `d:${name}` });
    srv.route("PUT", s.path, (req) => {
      const im = req.headers.get("if-match");
      if (im !== undefined && im !== tag()) return { status: 412, body: api.error("precondition_failed", "document was modified"), headers: { etag: tag() } };
      const b = (req.body ?? {}) as Record<string, unknown>;
      const patch: Record<string, string> = {};
      for (const f of s.fields) if (typeof b[f] === "string") patch[f] = b[f] as string;
      db.writeDoc(name, patch, req.t);
      return { status: 200, body: out(), headers: { etag: tag() } };
    }, { feature: s.id, kind: "write", idempotent: true, resource: `d:${name}` });
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.doc`;
    const url = s.path.replace(":id", s.docId);
    const S = env.store(s.store, s.id, { ...s.init, [F.etag]: null, [F.saving]: false, [F.saved]: true, [F.error]: null } as Record<string, unknown>, {
      weights: weightsOf([...s.fields.map((f) => [f, 1] as [string, number]), [F.etag, 0], [F.saving, 0.12], [F.saved, 0.3], [F.error, 0]]),
      resync: async () => {
        const op = kit.op({ role: "resync", method: "GET", url, key, background: true });
        const r = await kit.call(op);
        if (r.ok) adopt(fieldsOf(kit.api.unone(r.body)), r.headers?.get("etag") ?? null, "refetch", op);
      },
    });
    const sig = (v: Record<string, unknown>) => s.fields.map((f) => String(v[f] ?? "")).join("\u0001");
    const fieldsOf = (doc: Record<string, unknown>) => Object.fromEntries(s.fields.filter((f) => typeof doc[f] === "string").map((f) => [f, doc[f] as string]));
    let tagNow: string | null = null;
    let base: Record<string, string> = { ...s.init };
    let inflight = 0;
    let pending = false;
    let timer: unknown = null;
    function adopt(doc: Record<string, string>, t: string | null, role: string, op: SimOp): void {
      tagNow = t;
      base = { ...base, ...doc };
      kit.write(S, (p) => ({ ...p, ...doc, [F.etag]: t, [F.saved]: true }), { role, op, key });
    }
    function settle(op: SimOp): void {
      kit.write(S, (p) => ({ ...p, [F.saving]: inflight > 0 }), { role: "saving", op, key });
      if (pending && inflight === 0) {
        pending = false;
        save();
      }
    }
    function save(attempt = 1, prev?: SimOp, force = false, dupOf?: number): void {
      if (s.serialize && inflight > 0 && attempt === 1) {
        pending = true;
        return;
      }
      const body: Record<string, unknown> = Object.fromEntries(s.fields.map((f) => [f, S.get()[f]]));
      const sentSig = sig(body);
      const intent = env.know.latestIntent(key)?.id;
      const headers: Record<string, string> = s.ifMatch && !force && tagNow ? { "if-match": tagNow } : {};
      inflight++;
      kit.write(S, (p) => ({ ...p, [F.saving]: true }), { role: "saving", intent, key });
      const op = kit.op({ role: force ? "force-save" : "save", method: "PUT", url, body, intent, key, attempt, handled: true, ...(prev ? { retryOf: prev.id } : {}), ...(dupOf !== undefined ? { dupOf } : {}), ...(force ? { classify: () => "conflict" } : {}) });
      kit.spawn(async () => {
        const r = await kit.call(op, { headers, ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}) });
        inflight--;
        if (r.ok) {
          const doc = fieldsOf(kit.api.unone(r.body));
          tagNow = r.headers?.get("etag") ?? null;
          base = { ...base, ...doc };
          const unchanged = sig(S.get()) === sentSig;
          const apply = unchanged || s.echo === "always";
          const verdict = apply && !unchanged ? "stale" : intent !== undefined && env.know.superseded(intent) ? "expected" : undefined;
          kit.write(S, (p) => ({ ...p, ...(apply ? { ...doc, [F.saved]: true } : {}), [F.etag]: tagNow, [F.error]: null }), { role: "echo", op, intent, key, classify: () => verdict });
          settle(op);
          return;
        }
        if (r.status === 412) return conflict(op, attempt, intent);
        kit.write(S, (p) => ({ ...p, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, key });
        kit.shownError();
        settle(op);
      }, "uncaught", { cause: "save-failed", diagnosis: "failing", op });
    }
    async function conflict(op: SimOp, attempt: number, intent: number | undefined): Promise<void> {
      if (s.on412 === "force" && attempt < 3) {
        save(attempt + 1, op, true);
        return settle(op);
      }
      const gop = kit.op({ role: "conflict-refetch", method: "GET", url, key, background: true, handled: true, ...(intent !== undefined ? { intent } : {}) });
      const r = await kit.call(gop);
      if (!r.ok) {
        kit.write(S, (p) => ({ ...p, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op: gop, key });
        kit.shownError();
        return settle(op);
      }
      const remote = fieldsOf(kit.api.unone(r.body));
      const baseThen = base;
      if (s.on412 === "reload") {
        adopt(remote, r.headers?.get("etag") ?? null, "conflict-refetch", gop);
        kit.write(S, (p) => ({ ...p, [F.error]: "Changed by someone else: reloaded" }), { role: "error", op: gop, key });
        kit.shownError();
        return settle(op);
      }
      // Three-way merge: fields edited locally since the last sync win, untouched fields take the server's text.
      tagNow = r.headers?.get("etag") ?? null;
      base = { ...base, ...remote };
      const local = S.get();
      const dirty = s.fields.some((f) => local[f] !== baseThen[f]);
      kit.write(S, (p) => {
        const o: Record<string, unknown> = { ...p, [F.etag]: tagNow };
        for (const f of s.fields) if (p[f] === baseThen[f] && remote[f] !== undefined) o[f] = remote[f];
        return o;
      }, { role: "conflict-refetch", op: gop, key, classify: () => (dirty ? "conflict" : "expected") });
      if (attempt < 3 && s.fields.some((f) => S.get()[f] !== remote[f])) save(attempt + 1, op);
      settle(op);
    }
    return {
      init() {
        const op = kit.op({ role: "load", method: "GET", url, key, background: true });
        kit.spawn(async () => {
          const r = await kit.call(op);
          if (r.ok) adopt(fieldsOf(kit.api.unone(r.body)), r.headers?.get("etag") ?? null, "load", op);
        }, "swallow");
      },
      handle(step: UserStep, intent: number) {
        if (timer) env.clearTimeout(timer);
        timer = null;
        if (step.action === "save") {
          const it = env.know.getIntent(intent);
          save(1, undefined, false, it?.accidental ? it.repeatOf : undefined);
          return;
        }
        const field = String(step.args?.field ?? s.fields[0]);
        kit.write(S, (p) => ({ ...p, [field]: String(step.ui.value ?? ""), [F.saved]: false }), { role: "input", intent, key });
        timer = env.setTimeout(() => {
          timer = null;
          save();
        }, s.debounceMs);
      },
      cond() {
        return inflight > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    const cur: Record<string, string> = { ...s.init };
    let t = win.t0 + user.think(0.6);
    while (t < win.t1 - 1000) {
      const field = user.rng.bool(0.75) ? s.fields[s.fields.length - 1]! : s.fields[0]!;
      let text = "";
      for (let i = 0, n = user.rng.int(1, 4); i < n; i++) text += " " + user.rng.pick(s.words);
      const typed = user.type(t, cur[field]!, text, s.labels[field]!, "edit", `${s.id}.doc`, { field });
      steps.push(...typed.steps);
      if (typed.steps.length) cur[field] = String(typed.steps[typed.steps.length - 1]!.ui.value);
      t = typed.t;
      if (user.rng.bool(0.25)) {
        t += user.rng.float(100, 900);
        const viaKey = user.rng.bool(0.5);
        steps.push(...user.click(t, viaKey ? s.labels[field]! : s.saveLabel, "save", { kind: "save", key: `${s.id}.save` }, { pendingCond: "saving", kind: viaKey ? "key" : "click", ...(viaKey ? { value: "Meta+s" } : {}) }).steps);
      }
      t += user.think(1.2);
    }
    return steps;
  },
  external(s, rng, win, steps) {
    const out: ExternalEvent[] = [];
    const plan: { t: number; field: string; add: string }[] = [];
    for (let i = 0; i < s.externalEdits; i++) plan.push({ t: rng.float(win.t0 + 1500, Math.max(win.t0 + 1600, win.t1 - 1500)), field: rng.pick(s.fields), add: " " + rng.pick(s.words) });
    // A collaborator saving right around the user's own saves (the race If-Match exists for).
    for (const st of steps.filter((x) => x.action === "save" || (x.action === "edit" && rng.bool(0.03))).slice(0, 4)) {
      if (rng.bool(0.5)) plan.push({ t: st.t + rng.float(20, 1500), field: rng.pick(s.fields), add: " " + rng.pick(s.words) });
    }
    for (const { t, field, add } of plan) {
      out.push({
        t,
        feature: s.id,
        desc: `another user edits ${field}`,
        apply(w) {
          const name = `${s.id}:doc:${s.docId}`;
          w.db.writeDoc(name, { [field]: String(w.db.doc(name).fields[field] ?? "") + add }, w.now());
        },
      });
    }
    return out;
  },
};
