// Multi-step form wizard with async server validation per step (POST /validate on blur and on Next) and a final
// create. Knobs: validation response guard (request id / value check / none: a slow response for older input
// decides the validity shown for newer input), navigation (guarded: Next ignored while one is pending and Back
// cancels a pending Next; relative: every resolved Next adds one, so a double click skips a step), submit guards
// (disabled while submitting, idempotency key). Other users can take a name right after it validated (422 on
// submit: a benign, handled failure).

import { canonical, type Item } from "../../net/server.js";
import type { Rng } from "../../rng.js";
import type { ExternalEvent, FeatureDef, UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

interface WField { name: string; kind: "text" | "num"; lo: number; hi: number; dec: number; unique: boolean; label: string }

export interface WizardSpec {
  id: string;
  api: string;
  store: string;
  f: { step: string; values: string; valid: string; errors: string; checking: string; submitting: string; error: string; created: string };
  steps: { name: string; fields: WField[] }[];
  coll: string;
  paths: { validate: string; create: string };
  seed: Item[];
  reqGuard: "reqid" | "value" | "none";
  nav: "guarded" | "relative";
  disable: boolean;
  idem: boolean;
  timeoutMs: number;
  words: string[];
  labels: { next: string; back: string; submit: string };
}

function knob<T>(rng: Rng, clean: boolean | undefined, good: T, opts: readonly (readonly [T, number])[]): T {
  const v = rng.weighted(opts);
  return clean ? good : v;
}

function problems(fields: WField[], values: Record<string, unknown>, taken: (v: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (f.kind === "num") {
      const n = Number(v);
      if (v === null || v === "" || !Number.isFinite(n) || n < f.lo || n > f.hi) out[f.name] = `Must be between ${f.lo} and ${f.hi}`;
    } else if (String(v ?? "").trim().length < 3) out[f.name] = "Too short";
    else if (f.unique && taken(String(v).trim().toLowerCase())) out[f.name] = "Already taken";
  }
  return out;
}

export const wizard: FeatureDef<WizardSpec> = {
  kind: "wizard",
  make({ rng, clean, entity, naming, id, api }) {
    const fld = (name: string, kind: "text" | "num", lo = 0, hi = 0, dec = 0, unique = false): WField => ({ name: naming.word(name), kind, lo, hi, dec, unique, label: `input "${title(name)}"` });
    const nums = entity.nums.map(([n, lo, hi, dec]) => fld(n, "num", lo, hi, dec));
    const s0 = [fld(entity.name, "text", 0, 0, 0, true), ...nums.slice(0, 1)];
    const s1 = [...nums.slice(1, 2), fld(rng.pick(["owner", "contact", "reference", "notes"]), "text")];
    return {
      id,
      api: api.name,
      store: naming.store("new", entity.s, rng.pick(["wizard", "setup", "onboarding"])),
      f: { step: rng.pick(["step", "stepIndex", "page"]), values: naming.field("draft", id), valid: rng.pick(["valid", "validity", "checks"]), errors: rng.pick(["errors", "fieldErrors", "messages"]), checking: rng.pick(["validating", "checking"]), submitting: naming.field("submitting", id), error: naming.field("error", id), created: rng.pick(["created", "lastCreated", "done"]) },
      steps: [{ name: rng.pick(["Details", "Basics", "General"]), fields: s0 }, { name: rng.pick(["Options", "Settings", "More"]), fields: s1 }, { name: "Review", fields: [] }],
      coll: entity.p,
      paths: { validate: naming.route(entity.p, rng.pick(["validate", "check", "preflight"])), create: naming.route(entity.p) },
      seed: seedItems(rng, entity, rng.int(3, 10)),
      reqGuard: knob(rng, clean, "reqid", [["reqid", 2], ["value", 2], ["none", 3]] as const),
      nav: knob(rng, clean, "guarded", [["guarded", 1], ["relative", 1]] as const),
      disable: knob(rng, clean, true, [[true, 1], [false, 1]] as const),
      idem: knob(rng, clean, true, [[true, 1], [false, 2]] as const),
      timeoutMs: rng.weighted([[0, 2], [rng.int(3000, 8000), 2]] as const),
      words: entity.words,
      labels: { next: `button "${rng.pick(["Next", "Continue", "Next step"])}"`, back: `button "${rng.pick(["Back", "Previous"])}"`, submit: `button "${title(entity.create)} ${entity.s}"` },
    };
  },
  pattern(s) {
    return [`vguard:${s.reqGuard}`, `nav:${s.nav}`, s.disable ? "disable" : "nodisable", s.idem ? "idem" : "noidem"];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:${s.coll}`;
    const nameField = s.steps[0]!.fields[0]!.name;
    for (const it of s.seed) db.insert(coll, { ...it, [nameField]: String(Object.values(it)[0]) }, `seed:${canonical(it)}`);
    const taken = (v: string) => db.list(coll).some((it) => String(it[nameField] ?? "").toLowerCase() === v);
    srv.route("POST", s.paths.validate, (req) => {
      const b = (req.body ?? {}) as { step?: number; values?: Record<string, unknown> };
      const errors = problems(s.steps[Number(b.step ?? 0)]?.fields ?? [], b.values ?? {}, taken);
      return { status: 200, body: api.one({ valid: Object.keys(errors).length === 0, errors }) };
    }, { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
    srv.route("POST", s.paths.create, (req) => {
      const values = (req.body ?? {}) as Record<string, unknown>;
      const errors = problems(s.steps.flatMap((x) => x.fields), values, taken);
      if (Object.keys(errors).length) return { status: 422, body: { ...(api.error("invalid", "validation failed") as object), errors } };
      return { status: 201, body: api.one(db.insert(coll, values as Item, undefined, req.t)) };
    }, { feature: s.id, kind: "write", idempotent: false, resource: `c:${coll}` });
  },
  client(s, env, kit) {
    const F = s.f;
    const all = s.steps.flatMap((x) => x.fields);
    const last = s.steps.length - 1;
    const blank = () => Object.fromEntries(all.map((f) => [f.name, f.kind === "num" ? null : ""]));
    const S = env.store(s.store, s.id, { [F.step]: 0, [F.values]: blank(), [F.valid]: {}, [F.errors]: {}, [F.checking]: false, [F.submitting]: false, [F.error]: null, [F.created]: null } as Record<string, unknown>, {
      weights: weightsOf([[F.step, 0.5], [F.values, 0.4], [F.valid, 0.3], [F.errors, 0], [F.checking, 0.1], [F.submitting, 0.1], [F.error, 0], [F.created, 1]]),
    });
    const navKey = `${s.id}.nav`;
    let vseq = 0;
    const latestV = new Map<number, number>();
    let checking = 0;
    let navTok = 0;
    let navPending = false;
    let submitting = 0;
    const valuesOf = (k: number) => {
      const v = S.get()[F.values] as Record<string, unknown>;
      return Object.fromEntries(s.steps[k]!.fields.map((f) => [f.name, v[f.name] ?? null]));
    };
    async function validate(k: number, intent: number): Promise<boolean | null> {
      const fields = s.steps[k]!.fields;
      if (!fields.length) return true;
      const sent = valuesOf(k);
      const my = ++vseq;
      latestV.set(k, my);
      checking++;
      kit.write(S, (p) => ({ ...p, [F.checking]: true }), { role: "checking", intent, key: `${s.id}.validate` });
      const op = kit.op({ role: "validate", method: "POST", url: s.paths.validate, body: { step: k, values: sent }, intent, key: `${s.id}.validate.${k}`, idempotent: true });
      const r = await kit.call(op, s.timeoutMs ? { timeoutMs: s.timeoutMs } : {});
      checking--;
      const changed = canonical(valuesOf(k)) !== canonical(sent);
      if ((s.reqGuard === "reqid" && latestV.get(k) !== my) || (s.reqGuard === "value" && changed)) {
        kit.write(S, (p) => ({ ...p, [F.checking]: checking > 0 }), { role: "checking", op, key: `${s.id}.validate` });
        return null;
      }
      if (!r.ok) {
        kit.write(S, (p) => ({ ...p, [F.checking]: checking > 0, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, key: `${s.id}.validate` });
        kit.shownError();
        return false;
      }
      const b = kit.api.unone(r.body) as Record<string, unknown>;
      const errs = (b.errors ?? {}) as Record<string, string>;
      const before = S.get()[F.errors] as Record<string, string>;
      const verdict = changed ? "stale" : undefined;
      kit.write(S, (p) => {
        const valid = { ...(p[F.valid] as Record<string, boolean | null>) };
        const errors = { ...(p[F.errors] as Record<string, string>) };
        for (const f of fields) {
          valid[f.name] = !errs[f.name];
          if (errs[f.name]) errors[f.name] = errs[f.name]!;
          else delete errors[f.name];
        }
        return { ...p, [F.valid]: valid, [F.errors]: errors, [F.checking]: checking > 0, [F.error]: null };
      }, { role: "validation", op, intent, key: `${s.id}.validate`, classify: () => verdict });
      if (fields.some((f) => errs[f.name] && !before[f.name])) kit.shownError();
      return b.valid === true;
    }
    function next(intent: number): void {
      if (s.nav === "guarded" && navPending) return;
      const from = Number(S.get()[F.step]);
      if (from >= last) return;
      const tok = ++navTok;
      navPending = true;
      kit.spawn(async () => {
        const ok = await validate(from, intent);
        if (tok === navTok) navPending = false;
        if (ok !== true) return;
        const cur = Number(S.get()[F.step]);
        if (s.nav === "guarded" && (tok !== navTok || cur !== from)) return;
        const verdict = cur !== from ? (env.know.getIntent(intent)?.accidental ? "duplicate" : "stale") : undefined;
        kit.write(S, (p) => ({ ...p, [F.step]: s.nav === "guarded" ? from + 1 : Math.min(last, Number(p[F.step]) + 1) }), { role: "navigate", intent, key: navKey, classify: () => verdict });
      }, "uncaught", { cause: "validate-failed", diagnosis: "failing" });
    }
    function submit(intent: number): void {
      if (Number(S.get()[F.step]) !== last || (s.disable && submitting > 0)) return;
      const it = env.know.getIntent(intent);
      const ref = it?.accidental && it.repeatOf !== undefined ? it.repeatOf : intent;
      const values = { ...(S.get()[F.values] as Record<string, unknown>) };
      submitting++;
      kit.write(S, (p) => ({ ...p, [F.submitting]: true, [F.error]: null }), { role: "submitting", intent, key: `${s.id}.submit` });
      const op = kit.op({ role: "create", method: "POST", url: s.paths.create, body: values, intent, key: `${s.id}.submit`, idempotent: false, ...(it?.accidental ? { dupOf: it.repeatOf } : {}) });
      kit.spawn(async () => {
        const headers: Record<string, string> = s.idem ? { "idempotency-key": `wz-${env.rng.fork("wizard", ref).token(10)}` } : {};
        const r = await kit.call(op, { headers, ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}) });
        submitting--;
        if (r.ok) {
          const created = String(kit.api.unone(r.body)[all[0]!.name] ?? "");
          kit.write(S, (p) => ({ ...p, [F.step]: 0, [F.values]: blank(), [F.valid]: {}, [F.errors]: {}, [F.submitting]: submitting > 0, [F.created]: created }), { role: "created", op, intent, key: `${s.id}.submit` });
          return;
        }
        const errs = r.status === 422 ? (((r.body ?? {}) as Record<string, unknown>).errors ?? {}) as Record<string, string> : {};
        const back = Object.keys(errs).length ? s.steps.findIndex((x) => x.fields.some((f) => errs[f.name])) : -1;
        kit.write(S, (p) => ({ ...p, [F.submitting]: submitting > 0, [F.error]: r.status === 422 ? "Please fix the highlighted fields" : errMsg(r.status, r.outcome), [F.errors]: { ...(p[F.errors] as object), ...errs }, ...(back >= 0 ? { [F.step]: back } : {}) }), { role: "error", op, intent, key: `${s.id}.submit` });
        kit.shownError();
      }, "uncaught", { cause: "create-failed", diagnosis: "failing", op });
    }
    return {
      handle(step: UserStep, intent: number) {
        const field = String(step.args?.field ?? "");
        const def = all.find((f) => f.name === field);
        if (step.action === "input" && def) {
          const raw = String(step.ui.value ?? "");
          // A number input holding a typo keeps the raw text (the server rejects it); never NaN in state.
          const v = def.kind === "num" ? (raw === "" ? null : Number.isFinite(Number(raw)) ? Number(raw) : raw) : raw;
          kit.write(S, (p) => ({ ...p, [F.values]: { ...(p[F.values] as object), [field]: v } }), { role: "input", intent, key: `${s.id}.field.${field}` });
        } else if (step.action === "blur" && def) {
          kit.spawn(async () => void (await validate(s.steps.findIndex((x) => x.fields.includes(def)), intent)), "uncaught", { cause: "validate-failed", diagnosis: "failing" });
        } else if (step.action === "next") next(intent);
        else if (step.action === "back") {
          if (s.nav === "guarded" && navPending) {
            navTok++;
            navPending = false;
            return;
          }
          kit.write(S, (p) => ({ ...p, [F.step]: Math.max(0, Number(p[F.step]) - 1) }), { role: "navigate", intent, key: navKey });
        } else if (step.action === "submit") submit(intent);
      },
      cond(name) {
        return name === "submitting" ? submitting > 0 : checking > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    const nav = (t: number, action: string, label: string): UserStep => ({ t, feature: s.id, action, ui: { kind: "click", target: label }, intent: { kind: action, key: `${s.id}.nav`, mode: "replace", accidental: false } });
    const fmt = (f: WField, n: number) => (f.dec ? n.toFixed(f.dec) : String(Math.round(n)));
    let t = win.t0 + user.think(0.8);
    for (let round = 0; round < 3 && t < win.t1 - 4000; round++) {
      for (let k = 0; k < s.steps.length - 1; k++) {
        for (const f of s.steps[k]!.fields) {
          const bad = user.rng.bool(0.22);
          const w = user.rng.pick(s.words);
          let good = f.kind === "num" ? fmt(f, user.rng.float(f.lo, f.hi)) : f.unique || w.length < 3 ? `${w} ${user.rng.pick(s.words)}` : w;
          if (f.unique && s.seed.some((it) => String(Object.values(it)[0]).toLowerCase() === good.toLowerCase())) good += ` ${user.rng.int(2, 99)}`;
          const first = !bad ? good : f.kind === "num" ? fmt(f, f.hi * 3 + 7) : good.slice(0, 2);
          const ty = user.type(t, "", first, f.label, "input", `${s.id}.field.${f.name}`, { field: f.name });
          steps.push(...ty.steps);
          t = ty.t + user.rng.float(80, 400);
          steps.push({ t, feature: s.id, action: "blur", ui: { kind: "key", target: f.label, value: "Tab" }, args: { field: f.name }, intent: { kind: "blur", key: `${s.id}.blur.${f.name}`, mode: "replace", accidental: false } });
          if (bad) {
            // Notice the message and fix it right away: the second check can overtake the first.
            t += user.rng.float(250, 1200);
            let cur = first;
            if (f.kind === "num") {
              while (cur.length) {
                t += user.key() * 0.6;
                cur = cur.slice(0, -1);
                steps.push({ t, feature: s.id, action: "input", ui: { kind: "type", target: f.label, value: cur }, args: { field: f.name }, intent: { kind: "input", key: `${s.id}.field.${f.name}`, mode: "replace", accidental: false } });
              }
            }
            const fix = user.type(t, cur, f.kind === "num" ? good : good.slice(2), f.label, "input", `${s.id}.field.${f.name}`, { field: f.name });
            steps.push(...fix.steps);
            t = fix.t + user.rng.float(80, 400);
            steps.push({ t, feature: s.id, action: "blur", ui: { kind: "key", target: f.label, value: "Tab" }, args: { field: f.name }, intent: { kind: "blur", key: `${s.id}.blur.${f.name}`, mode: "replace", accidental: false } });
          }
          t += user.rng.float(200, 900);
        }
        steps.push(...user.click(t, s.labels.next, "next", { kind: "next", key: `${s.id}.nav`, mode: "replace" }, { pendingCond: "checking" }).steps);
        if (k > 0 && user.rng.bool(0.15)) {
          // Next, then straight back to double-check, then Next again.
          t += user.rng.float(200, 700);
          steps.push(nav(t, "back", s.labels.back));
          t += user.rng.float(500, 1500);
          steps.push(nav(t, "next", s.labels.next));
        }
        t += user.think(0.8);
      }
      steps.push(...user.click(t, s.labels.submit, "submit", { kind: "create", key: `${s.id}.submit` }, { pendingCond: "submitting", kind: "submit" }).steps);
      t += user.think(2.5);
    }
    return steps;
  },
  external(s, rng, _win, steps) {
    // Someone else registers the very name the user just validated (the final submit then gets a 422).
    const out: ExternalEvent[] = [];
    const nameField = s.steps[0]!.fields[0]!;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i]!;
      if (st.action !== "blur" || st.args?.field !== nameField.name || !rng.bool(0.12)) continue;
      const typed = [...steps.slice(0, i)].reverse().find((x) => x.action === "input" && x.args?.field === nameField.name);
      const name = String(typed?.ui.value ?? "").trim();
      if (name.length < 3) continue;
      out.push({ t: st.t + rng.float(100, 2500), feature: s.id, desc: `another user takes the name ${name}`, apply(w) {
        const coll = `${s.id}:${s.coll}`;
        if (!w.db.list(coll).some((it) => String(it[nameField.name] ?? "").toLowerCase() === name.toLowerCase())) w.db.insert(coll, { [nameField.name]: name }, `ext:${name}`, w.now());
      } });
    }
    return out;
  },
};
