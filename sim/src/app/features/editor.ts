// Document editor with autosave and server echo. Knobs: save trigger (debounce / interval / button), overlapping
// saves allowed or serialized, how the echo is applied (always = stale-echo defect, only-if-unchanged, version
// only), version checks with 409 handling, live edits from other users (applied blindly = conflict defect, or
// only when clean), retry policy, saved/saving flags.

import type { FeatureDef, UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, weightsOf } from "./common.js";

export interface EditorSpec {
  id: string;
  api: string;
  store: string;
  docId: string;
  fields: string[];
  f: { version: string; saving: string; saved: string; error: string };
  path: string;
  method: "PUT" | "PATCH";
  init: Record<string, string>;
  saveMode: "debounce" | "interval" | "button";
  saveMs: number;
  overlap: "allow" | "serialize";
  echo: "always" | "if-unchanged" | "version-only";
  versionCheck: boolean;
  onConflict: "refetch" | "overwrite" | "show";
  live: boolean;
  liveApply: "blind" | "if-clean";
  retry: "none" | "once" | "backoff";
  timeoutMs: number;
  savedFlag: boolean;
  words: string[];
  labels: Record<string, string>;
  saveLabel: string;
  externalEdits: number;
}

export const editor: FeatureDef<EditorSpec> = {
  kind: "editor",
  make({ rng, domain, naming, id, api }) {
    const [noun, fields] = rng.pick(domain.docs);
    const fs = fields.map((f) => naming.word(f));
    const init: Record<string, string> = {};
    for (const f of fs) init[f] = `${title(noun)} ${rng.pick(domain.entities).words.slice(0, 3).join(" ")}`;
    const saveMode = rng.weighted([["debounce", 5], ["interval", 2], ["button", 3]] as const);
    const labels: Record<string, string> = {};
    for (const f of fs) labels[f] = `${f.toLowerCase().includes("title") || f.toLowerCase().includes("head") ? "input" : "textarea"} "${title(f)}"`;
    return {
      id,
      api: api.name,
      store: naming.store(noun.split(" ").slice(-1)[0]!, rng.pick(["doc", "editor", "draft", ""]) || "doc"),
      docId: String(rng.int(10, 9999)),
      fields: fs,
      f: { version: naming.field("version", id), saving: naming.field("saving", id), saved: naming.field("saved", id), error: naming.field("error", id) },
      path: naming.route(noun.split(" ").slice(-1)[0]! + "s", ":id"),
      method: rng.bool(0.7) ? "PUT" : "PATCH",
      init,
      saveMode,
      saveMs: saveMode === "debounce" ? rng.int(300, 1500) : saveMode === "interval" ? rng.int(1500, 5000) : 0,
      overlap: rng.weighted([["allow", 5], ["serialize", 4]] as const),
      echo: rng.weighted([["always", 5], ["if-unchanged", 3], ["version-only", 2]] as const),
      versionCheck: rng.bool(0.4),
      onConflict: rng.weighted([["refetch", 2], ["overwrite", 1], ["show", 2]] as const),
      live: rng.bool(0.4),
      liveApply: rng.weighted([["blind", 1], ["if-clean", 1]] as const),
      retry: rng.weighted([["none", 3], ["once", 2], ["backoff", 2]] as const),
      timeoutMs: rng.weighted([[0, 3], [rng.int(3000, 10000), 2]] as const),
      savedFlag: rng.bool(0.7),
      words: rng.shuffle(domain.entities.flatMap((e) => e.words)).slice(0, 24),
      labels,
      saveLabel: `button "${rng.pick(["Save", "Save changes", "Publish", "Update"])}"`,
      externalEdits: rng.weighted([[0, 3], [1, 2], [2, 1]] as const),
    };
  },
  pattern(s) {
    return [`save:${s.saveMode}`, `overlap:${s.overlap}`, `echo:${s.echo}`, s.versionCheck ? `vcheck:${s.onConflict}` : "novcheck", s.live ? `live:${s.liveApply}` : "nolive", `retry:${s.retry}`];
  },
  server(s, srv, db) {
    const name = `${s.id}:doc:${s.docId}`;
    db.doc(name, s.init);
    const api = apiOf(s.api);
    const out = () => {
      const d = db.doc(name);
      return { id: s.docId, ...d.fields, version: d.version };
    };
    srv.route("GET", s.path, () => ({ status: 200, body: api.one(out()) }), { feature: s.id, kind: "read", idempotent: true, resource: `d:${name}` });
    srv.route(
      s.method,
      s.path,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const d = db.doc(name);
        if (s.versionCheck && typeof b.version === "number" && b.version !== d.version) {
          return { status: 409, body: { error: "version_conflict", current: out() } };
        }
        const patch: Record<string, string> = {};
        for (const f of s.fields) if (typeof b[f] === "string") patch[f] = b[f] as string;
        db.writeDoc(name, patch, req.t);
        return { status: 200, body: api.one(out()) };
      },
      { feature: s.id, kind: "write", idempotent: true, resource: `d:${name}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.doc`;
    const init: Record<string, unknown> = { ...s.init, [F.version]: 1, [F.saving]: false, [F.error]: null };
    if (s.savedFlag) init[F.saved] = true;
    const wts: [string, number][] = s.fields.map((f) => [f, 1] as [string, number]);
    wts.push([F.version, 0], [F.saving, 0.12], [F.saved, 0.3], [F.error, 0]);
    const url = s.path.replace(":id", s.docId);
    // Content bookkeeping: text of each edit intent, to tell which intent the shown text reflects.
    const textOf = new Map<number, string>();
    const sig = (v: Record<string, unknown>) => s.fields.map((f) => String(v[f] ?? "")).join("\u0001");
    textOf.set(0, sig(s.init));
    const shownIntent = () => {
      const cur = sig(S.get());
      let best: number | undefined;
      for (const [i, t] of textOf) if (t === cur && (best === undefined || i > best)) best = i;
      return best;
    };
    let inflight = 0;
    let pending = false;
    let timer: unknown = null;
    let lastSentSig = sig(s.init);
    let dirty = false;
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf(wts),
      resync: async () => {
        const op = kit.op({ role: "resync", method: "GET", url, key, background: true });
        const r = await kit.call(op);
        if (r.ok) applyServer(kit.api.unone(r.body), "refetch", op);
      },
    });
    function applyServer(doc: Record<string, unknown>, role: string, op?: ReturnType<typeof kit.op>, intent?: number): void {
      const patch: Record<string, unknown> = {};
      for (const f of s.fields) if (typeof doc[f] === "string") patch[f] = doc[f];
      if (typeof doc.version === "number") patch[F.version] = doc.version;
      const meta: Parameters<typeof kit.write>[2] = { role, key };
      if (op) meta.op = op;
      if (intent !== undefined) meta.intent = intent;
      kit.write(S, (p) => ({ ...p, ...patch }), meta);
    }
    function scheduleSave(): void {
      if (s.saveMode === "debounce") {
        if (timer) env.clearTimeout(timer);
        timer = env.setTimeout(() => {
          timer = null;
          save();
        }, s.saveMs);
      }
    }
    function save(attempt = 1, retryOf?: number, resend?: { body: Record<string, unknown>; intent: number | undefined }): void {
      if (s.overlap === "serialize" && inflight > 0 && attempt === 1) {
        pending = true;
        return;
      }
      const cur = S.get();
      const intent = resend ? resend.intent : env.know.latestIntent(key)?.id;
      const body: Record<string, unknown> = resend ? resend.body : {};
      if (!resend) {
        for (const f of s.fields) body[f] = cur[f];
        if (s.versionCheck) body.version = cur[F.version];
      }
      const sentSig = s.fields.map((f) => String(body[f] ?? "")).join("\u0001");
      lastSentSig = sentSig;
      inflight++;
      kit.write(S, (p) => ({ ...p, [F.saving]: true }), { role: "saving", key, intent });
      const op = kit.op({
        role: "save",
        method: s.method,
        url,
        body,
        intent,
        key,
        attempt,
        handled: s.retry !== "none",
        ...(retryOf !== undefined ? { retryOf } : {}),
        classify: () => (intent !== undefined && env.know.superseded(intent) && attempt > 1 ? "stale" : undefined),
      });
      kit.spawn(
        async () => {
          const opts: { timeoutMs?: number } = {};
          if (s.timeoutMs) opts.timeoutMs = s.timeoutMs;
          const r = await kit.call(op, opts);
          inflight--;
          const stillSaving = inflight > 0;
          if (r.ok) {
            const doc = kit.api.unone(r.body);
            const localSig = sig(S.get());
            const unchanged = localSig === sentSig;
            const stale = () => {
              if (intent === undefined) return undefined;
              const shown = shownIntent();
              return shown !== undefined && shown > intent ? "stale" : "expected";
            };
            if (s.echo === "always") {
              const patch: Record<string, unknown> = { [F.saving]: stillSaving, [F.error]: null };
              for (const f of s.fields) if (typeof doc[f] === "string") patch[f] = doc[f];
              if (typeof doc.version === "number") patch[F.version] = doc.version;
              if (s.savedFlag) patch[F.saved] = true;
              kit.write(S, (p) => ({ ...p, ...patch }), { role: "echo", op, intent, key, classify: stale });
              dirty = false;
            } else if (s.echo === "if-unchanged") {
              const patch: Record<string, unknown> = { [F.saving]: stillSaving, [F.error]: null };
              if (unchanged) {
                for (const f of s.fields) if (typeof doc[f] === "string") patch[f] = doc[f];
                if (s.savedFlag) patch[F.saved] = true;
                dirty = false;
              }
              if (typeof doc.version === "number") patch[F.version] = doc.version;
              kit.write(S, (p) => ({ ...p, ...patch }), { role: "echo", op, intent, key });
            } else {
              const patch: Record<string, unknown> = { [F.saving]: stillSaving, [F.error]: null };
              if (typeof doc.version === "number") patch[F.version] = doc.version;
              if (s.savedFlag) patch[F.saved] = unchanged;
              if (unchanged) dirty = false;
              kit.write(S, (p) => ({ ...p, ...patch }), { role: "echo", op, intent, key });
            }
            if (pending) {
              pending = false;
              save();
            }
            return;
          }
          if (r.status === 409) {
            const cur = ((r.body as Record<string, unknown>)?.current ?? {}) as Record<string, unknown>;
            if (s.onConflict === "refetch") {
              applyServer(cur, "conflict-refetch", op, intent);
              kit.write(S, (p) => ({ ...p, [F.saving]: stillSaving }), { role: "saving", key });
            } else if (s.onConflict === "overwrite") {
              const b2: Record<string, unknown> = { ...body, version: cur.version };
              save(attempt + 1, op.id, { body: b2, intent });
            } else {
              kit.shownError();
              kit.write(S, (p) => ({ ...p, [F.saving]: stillSaving, [F.error]: "Someone else changed this document" }), { role: "error", key, op });
            }
            return;
          }
          // Failure.
          if (s.retry === "once" && attempt === 1) {
            await env.sleep(1000);
            save(2, op.id, { body, intent });
            return;
          }
          if (s.retry === "backoff" && attempt < 5) {
            await env.sleep(Math.min(8000, 500 * 2 ** attempt));
            save(attempt + 1, op.id, { body, intent });
            return;
          }
          if (pending) {
            pending = false;
            save();
          }
          kit.shownError();
          kit.write(S, (p) => ({ ...p, [F.saving]: stillSaving, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", key, op });
        },
        "uncaught",
        { cause: "save-failed", diagnosis: "failing", op },
      );
    }
    return {
      init() {
        const op = kit.op({ role: "load", method: "GET", url, key, background: true });
        kit.spawn(async () => {
          const r = await kit.call(op);
          if (r.ok) applyServer(kit.api.unone(r.body), "load", op, 0);
        }, "swallow");
        if (s.saveMode === "interval") {
          env.setInterval(() => {
            if (dirty) save();
          }, s.saveMs);
        }
        if (s.live) {
          env.subscribe(`${s.id}:doc`, (msg) => {
            const m = msg as Record<string, unknown>;
            const localDirty = sig(S.get()) !== lastSentSig || inflight > 0 || dirty;
            const competing = localDirty;
            if (s.liveApply === "if-clean" && localDirty) return;
            const patch: Record<string, unknown> = {};
            for (const f of s.fields) if (typeof m[f] === "string") patch[f] = m[f];
            if (typeof m.version === "number") patch[F.version] = m.version;
            kit.write(S, (p) => ({ ...p, ...patch }), { role: "push", key, classify: () => (competing ? "conflict" : "expected") });
          });
        }
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "save") {
          if (timer) {
            env.clearTimeout(timer);
            timer = null;
          }
          save();
          return;
        }
        const field = String(step.args?.field ?? s.fields[0]);
        const v = String(step.ui.value ?? "");
        const next = { ...S.get(), [field]: v };
        textOf.set(intent, sig(next));
        dirty = true;
        const patch: Record<string, unknown> = { [field]: v };
        if (s.savedFlag) patch[F.saved] = false;
        kit.write(S, (p) => ({ ...p, ...patch }), { role: "input", intent, key });
        scheduleSave();
      },
      cond(name) {
        return name === "saving" ? inflight > 0 : false;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    const cur: Record<string, string> = { ...s.init };
    let t = win.t0 + user.think(0.6);
    while (t < win.t1 - 1000) {
      const field = user.rng.bool(0.8) ? s.fields[s.fields.length - 1]! : s.fields[0]!;
      const nWords = user.rng.int(1, 4);
      let text = "";
      for (let i = 0; i < nWords; i++) text += " " + user.rng.pick(s.words);
      const typed = user.type(t, cur[field]!, text, s.labels[field]!, "edit", `${s.id}.doc`, { field });
      for (const st of typed.steps) st.intent.kind = "edit";
      steps.push(...typed.steps);
      if (typed.steps.length) cur[field] = String(typed.steps[typed.steps.length - 1]!.ui.value);
      t = typed.t;
      if (s.saveMode === "button" || user.rng.bool(0.15)) {
        t += user.rng.float(150, 1200);
        const c = user.click(t, s.saveLabel, "save", { kind: "save", key: `${s.id}.save`, mode: "replace" }, { pendingCond: "saving" });
        steps.push(...c.steps);
        // quick edit right after saving
        if (user.rng.bool(0.35)) t += user.rng.float(100, 600);
        else t += user.think();
      } else t += user.think(1.2);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: import("../feature.js").ExternalEvent[] = [];
    for (let i = 0; i < s.externalEdits; i++) {
      const t = rng.float(win.t0 + 1500, Math.max(win.t0 + 1600, win.t1 - 1500));
      const field = rng.pick(s.fields);
      const add = " " + rng.pick(s.words);
      out.push({
        t,
        feature: s.id,
        desc: `another user edits ${field}`,
        apply(w) {
          const name = `${s.id}:doc:${s.docId}`;
          const d = w.db.doc(name);
          const nv = String(d.fields[field] ?? "") + add;
          w.db.writeDoc(name, { [field]: nv }, w.now());
          if (s.live) w.publish(`${s.id}:doc`, { ...w.db.doc(name).fields, version: w.db.doc(name).version });
        },
      });
    }
    return out;
  },
};
