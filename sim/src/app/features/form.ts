// Create form: fill fields, submit → POST (non-idempotent create) → append to a list with a derived count.
// Guards: disable while submitting, idempotency keys, retry with the same key. Defects: double submit, retry
// without key after a timeout (duplicate when the first attempt committed), optimistic append without rollback,
// count not maintained on some paths.

import type { Item } from "../../net/server.js";
import { rel, type FeatureDef, type UserStep } from "../feature.js";
import { errorFor } from "../kit.js";
import { title } from "../naming.js";
import { apiOf, errMsg, idsKey, seedItems, weightsOf } from "./common.js";

export interface FormSpec {
  id: string;
  api: string;
  formStore: string;
  listStore: string;
  f: { draft: string; submitting: string; error: string; list: string; count: string };
  fields: { name: string; kind: "text" | "num"; lo: number; hi: number; dec: number }[];
  listPath: string;
  createPath: string;
  seed: Item[];
  disable: boolean;
  idemKey: boolean;
  retry: "none" | "same-key" | "no-key";
  retryOn: "timeout" | "5xx";
  timeoutMs: number;
  onSuccess: "append" | "refetch";
  optimistic: boolean;
  rollback: boolean;
  countField: boolean;
  countOnAllPaths: boolean;
  onError: "show" | "throw";
  submitLabel: string;
  labels: Record<string, string>;
  words: string[];
  verb: string;
}

export const form: FeatureDef<FormSpec> = {
  kind: "form",
  make({ rng, entity, naming, id, api }) {
    const fields: FormSpec["fields"] = [{ name: naming.word(entity.name), kind: "text", lo: 0, hi: 0, dec: 0 }];
    for (const [f, lo, hi, dec] of entity.nums.slice(0, rng.int(0, 2))) fields.push({ name: naming.word(f), kind: "num", lo, hi, dec });
    const labels: Record<string, string> = {};
    for (const f of fields) labels[f.name] = `input "${title(f.name)}"`;
    const retry = rng.weighted([["none", 4], ["same-key", 2], ["no-key", 3]] as const);
    return {
      id,
      api: api.name,
      formStore: naming.store("new", entity.s, rng.pick(["form", "draft", ""]) || "form"),
      listStore: naming.store(entity.p),
      f: { draft: naming.field("draft", id), submitting: naming.field("submitting", id), error: naming.field("error", id), list: naming.field("list", id + "l"), count: naming.field("total", id + "l") },
      fields,
      listPath: naming.route(entity.p),
      createPath: naming.route(entity.p),
      seed: seedItems(rng, entity, rng.int(2, 8)),
      disable: rng.bool(0.45),
      idemKey: retry === "same-key" ? true : rng.bool(0.25),
      retry,
      retryOn: rng.weighted([["timeout", 1], ["5xx", 1]] as const),
      timeoutMs: retry === "none" ? rng.weighted([[0, 2], [rng.int(2000, 6000), 1]] as const) : rng.int(1500, 6000),
      onSuccess: rng.weighted([["append", 3], ["refetch", 1]] as const),
      optimistic: rng.bool(0.35),
      rollback: rng.bool(0.6),
      countField: rng.bool(0.7),
      countOnAllPaths: rng.bool(0.4),
      onError: rng.weighted([["show", 4], ["throw", 1]] as const),
      submitLabel: `button "${title(entity.create)} ${entity.s}"`,
      labels,
      words: entity.words,
      verb: entity.create,
    };
  },
  pattern(s) {
    return [s.disable ? "disable" : "nodisable", s.idemKey ? "idem" : "noidem", `retry:${s.retry}`, `retry-on:${s.retryOn}`, `ok:${s.onSuccess}`, s.optimistic ? (s.rollback ? "optimistic+rollback" : "optimistic-norollback") : "pessimistic", s.countField ? (s.countOnAllPaths ? "count" : "count-partial") : "nocount"];
  },
  relations(s) {
    if (!s.countField) return [];
    const c = `${s.listStore}.${s.f.count}`;
    const l = `${s.listStore}.${s.f.list}`;
    return [{ fields: [c, l], desc: "count equals number of items", check: (st) => Number(rel.field(st, c)) === ((rel.field(st, l) as unknown[]) ?? []).length }];
  },
  server(s, srv, db) {
    const coll = `${s.id}:items`;
    for (const it of s.seed) db.insert(coll, it, `seed:${JSON.stringify(it)}`);
    const api = apiOf(s.api);
    srv.route("GET", s.listPath, () => ({ status: 200, body: api.list(db.list(coll)) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
    srv.route(
      "POST",
      s.createPath,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const fields: Item = {};
        for (const f of s.fields) {
          const v = b[f.name];
          if (f.kind === "text" && (typeof v !== "string" || !v.trim())) return { status: 422, body: api.error("invalid", `${f.name} is required`) };
          fields[f.name] = (v ?? null) as Item[string];
        }
        // Content-derived id (identical bodies get successive ids: a duplicate is a real extra item).
        const it = db.insert(coll, fields, JSON.stringify(fields), req.t);
        return { status: 201, body: api.one(it) };
      },
      { feature: s.id, kind: "write", idempotent: false, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const draft0: Record<string, unknown> = {};
    for (const f of s.fields) draft0[f.name] = f.kind === "text" ? "" : null;
    const FS = env.store(s.formStore, s.id, { [F.draft]: draft0, [F.submitting]: false, [F.error]: null } as Record<string, unknown>, {
      weights: weightsOf([[F.draft, 0.3], [F.submitting, 0.12], [F.error, 0]]),
    });
    const listInit: Record<string, unknown> = { [F.list]: [] as Item[] };
    if (s.countField) listInit[F.count] = 0;
    const LS = env.store(s.listStore, s.id, listInit, {
      weights: weightsOf([[F.list, 1], [F.count, 0.6]]),
      resync: () => refetch(undefined, true),
    });
    const key = `${s.id}.create`;
    let inflight = 0;
    let tmpSeq = 0;
    async function refetch(intent?: number, bg = true): Promise<void> {
      const op = kit.op({ role: "list", method: "GET", url: s.listPath, key: `${s.id}.list`, background: bg, ...(intent !== undefined ? { intent } : {}) });
      const r = await kit.call(op);
      if (!r.ok) return;
      const { items } = kit.api.unlist(r.body);
      const patch: Record<string, unknown> = { [F.list]: items };
      // Defect: the refetch path forgets the count when countOnAllPaths is false.
      if (s.countField && s.countOnAllPaths) patch[F.count] = items.length;
      kit.write(LS, (p) => ({ ...p, ...patch }), { role: "refetch", op, key: `${s.id}.list`, ...(s.countField && !s.countOnAllPaths ? { anomaly: "partial" } : {}) });
    }
    function submit(intent: number): void {
      const it = env.know.getIntent(intent);
      if (s.disable && FS.get()[F.submitting]) return;
      const draft = { ...(FS.get()[F.draft] as Record<string, unknown>) };
      const nameField = s.fields[0]!.name;
      if (typeof draft[nameField] !== "string" || !(draft[nameField] as string).trim()) {
        kit.write(FS, (p) => ({ ...p, [F.error]: `${title(nameField)} is required` }), { role: "validation", intent });
        return;
      }
      // An accidental repeat reuses the key of the click it repeats (same form state, same intent).
      const ref = it?.accidental && it.repeatOf !== undefined ? it.repeatOf : intent;
      const idem = s.idemKey ? `k${env.rng.fork("idem", ref).token(10)}` : undefined;
      const body: Record<string, unknown> = { ...draft };
      inflight++;
      kit.write(FS, (p) => ({ ...p, [F.submitting]: true, [F.error]: null }), { role: "submitting", intent, key });
      let tmpId: string | null = null;
      if (s.optimistic) {
        tmpId = `tmp-${++tmpSeq}`;
        const tmp = { id: tmpId, ...draft };
        const patch = (p: Record<string, unknown>) => {
          const list = [...((p[F.list] as Item[]) ?? []), tmp as Item];
          const o: Record<string, unknown> = { ...p, [F.list]: list };
          if (s.countField) o[F.count] = list.length;
          return o;
        };
        kit.write(LS, patch, { role: "optimistic", intent, key });
      }
      const attemptOnce = async (attempt: number, retryOf?: number): Promise<void> => {
        const headers: Record<string, string> = {};
        if (idem && (attempt === 1 || s.retry === "same-key")) headers["idempotency-key"] = idem;
        const op = kit.op({
          role: "create",
          method: "POST",
          url: s.createPath,
          body,
          intent,
          key,
          idempotent: false,
          attempt,
          handled: s.retry !== "none",
          ...(retryOf !== undefined ? { retryOf } : {}),
          ...(it?.accidental ? { dupOf: it.repeatOf } : {}),
        });
        const opts: { headers: Record<string, string>; timeoutMs?: number } = { headers };
        if (s.timeoutMs) opts.timeoutMs = s.timeoutMs;
        const r = await kit.call(op, opts);
        const retriable = r.outcome === "timeout" || r.outcome === "neterr" || (s.retryOn === "5xx" && r.status >= 500);
        if (!r.ok && retriable && s.retry !== "none" && attempt < 3) {
          await env.sleep(400 * attempt);
          return attemptOnce(attempt + 1, op.id);
        }
        inflight--;
        if (r.ok) {
          const created = kit.api.unone(r.body);
          if (s.onSuccess === "refetch") {
            if (tmpId) {
              const t = tmpId;
              kit.write(LS, (p) => ({ ...p, [F.list]: ((p[F.list] as Item[]) ?? []).filter((x) => x.id !== t) }), { role: "confirm", op, intent, key });
            }
            await refetch(intent, false);
          } else {
            const t = tmpId;
            const patch = (p: Record<string, unknown>) => {
              const cur = ((p[F.list] as Item[]) ?? []).filter((x) => x.id !== t && x.id !== created.id);
              const list = [...cur, created];
              const o: Record<string, unknown> = { ...p, [F.list]: list };
              if (s.countField) o[F.count] = list.length;
              return o;
            };
            kit.write(LS, patch, { role: "created", op, intent, key });
          }
          kit.write(FS, (p) => ({ ...p, [F.draft]: { ...draft0 }, [F.submitting]: inflight > 0 }), { role: "reset", op, intent, key });
          return;
        }
        // Failure surfaces to the user.
        if (tmpId && s.rollback) {
          const t = tmpId;
          const patch = (p: Record<string, unknown>) => {
            const list = ((p[F.list] as Item[]) ?? []).filter((x) => x.id !== t);
            const o: Record<string, unknown> = { ...p, [F.list]: list };
            if (s.countField && s.countOnAllPaths) o[F.count] = list.length;
            return o;
          };
          kit.write(LS, patch, { role: "rollback", op, intent, key, ...(s.countField && !s.countOnAllPaths ? { anomaly: "partial" } : {}) });
        }
        kit.write(FS, (p) => ({ ...p, [F.submitting]: inflight > 0, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, intent, key });
        kit.shownError();
        if (s.onError === "throw") throw errorFor(r, `${s.verb} ${nameField}`);
      };
      kit.spawn(() => attemptOnce(1), "uncaught", { cause: "create-failed", diagnosis: "failing" });
    }
    return {
      init() {
        kit.spawn(() => refetch(undefined, true), "swallow");
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "submit") return submit(intent);
        const field = String(step.args?.field);
        const def = s.fields.find((f) => f.name === field);
        const raw = String(step.ui.value ?? "");
        const v = def?.kind === "num" ? Number(raw) || 0 : raw;
        kit.write(FS, (p) => ({ ...p, [F.draft]: { ...(p[F.draft] as Record<string, unknown>), [field]: v } }), { role: "input", intent, key: `${s.id}.draft` });
      },
      cond(name) {
        return name === "submitting" ? inflight > 0 : false;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.6);
    let n = 0;
    let lastValues: Record<string, string> | null = null;
    while (t < win.t1 - 1500 && n < 6) {
      n++;
      // Sometimes intentionally create the very same thing again (new intent, identical request).
      const same = lastValues && user.rng.bool(0.25);
      const values: Record<string, string> = {};
      for (const f of s.fields) {
        values[f.name] = same ? lastValues![f.name]! : f.kind === "text" ? `${user.rng.pick(s.words)}${user.rng.bool(0.4) ? " " + user.rng.pick(s.words) : ""}` : String(Math.round(user.rng.float(f.lo, f.hi)));
      }
      for (const f of s.fields) {
        const typed = user.type(t, "", values[f.name]!, s.labels[f.name]!, "input", `${s.id}.draft.${f.name}`, { field: f.name });
        steps.push(...typed.steps);
        t = typed.t + user.rng.float(150, 700);
      }
      const c = user.click(t, s.submitLabel, "submit", { kind: "create", key: `${s.id}.create` }, { pendingCond: "submitting", kind: "submit" });
      steps.push(...c.steps);
      lastValues = values;
      t += user.think(1.5);
    }
    return steps;
  },
};

export function listKey(items: unknown): string {
  return idsKey(items);
}
