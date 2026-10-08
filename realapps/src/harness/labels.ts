// Finishing the diagnosis label in Node, where the app's declared relations live (manifest.relations):
//   mutation "rel-check": inconsistent when a declared relation held just before the write and is violated at
//     both +300 ms and +1 s afterwards in the passive counterfactual (a partial / non-atomic update the app never
//     repairs), else expected;
//   inconsistency: inconsistent only if a declared relation is violated at decision time and involves the
//     flagged fields (otherwise the runtime learned a coincidental invariant: expected);
//   transition "rel-check": unusual when a declared relation is violated at decision time, else expected.

import type { AppManifest } from "../shared/manifest.js";
import type { DecisionRec } from "../shared/types.js";
import { relationBroken, stateAt, valueDist, type State } from "./cost.js";

function fieldRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) out.add(`${m[1]}.${m[2]}`);
  return [...out];
}

/**
 * Lists (store fields holding arrays, also one level down) that contain two elements with the same identity (id,
 * clientId, slug, _id): "store.field" -> duplicated keys. A generic structural fact about the app's data used only
 * for labels: the same entity appended twice is a repeated effect of one intent.
 */
export function duplicateKeys(stores: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const scan = (path: string, v: unknown, depth: number) => {
    if (Array.isArray(v)) {
      const seen = new Set<string>();
      for (const el of v) {
        if (!el || typeof el !== "object") continue;
        const o = el as Record<string, unknown>;
        const k = o.id ?? o.clientId ?? o.slug ?? o._id;
        if (k === undefined || k === null) continue;
        const key = String(k);
        if (seen.has(key)) out.add(`${path}#${key}`);
        seen.add(key);
      }
    } else if (v && typeof v === "object" && depth < 2) for (const [k, x] of Object.entries(v as object)) scan(`${path}.${k}`, x, depth + 1);
  };
  for (const [name, v] of Object.entries(stores)) scan(name, v, 0);
  return out;
}

function newDuplicates(before: State, after: State): boolean {
  const b = duplicateKeys(before.stores);
  for (const k of duplicateKeys(after.stores)) if (!b.has(k)) return true;
  return false;
}

export function finishDiagnosis(d: DecisionRec, app: AppManifest, base: State[], passive: State[] | null): string | undefined {
  const rels = app.relations ?? [];
  if (d.trigger === "error" && d.diagWhy === "handler-threw") {
    // an app exception: when the state it rendered holds a duplicated entity (e.g. a keyed list with the same
    // message twice), the error is the effect of a repeated change
    const now = stateAt(base, d.t);
    if (duplicateKeys(now.stores).size) return "duplicate";
    if (rels.some((r) => relationBroken(r, now.stores))) return "inconsistent";
    return d.diagnosis;
  }
  if (d.diagWhy !== "rel-check") return d.diagnosis;
  if (d.trigger === "mutation" || d.trigger === "delivery") {
    if (!passive) return "expected";
    const before = stateAt(base, d.t - 0.001);
    if (newDuplicates(before, stateAt(passive, d.t + 50)) && newDuplicates(before, stateAt(passive, d.t + 1000))) return "duplicate";
    const store = String(d.subject.store ?? "");
    const mine = rels.filter((r) => !store || r.fields.some((f) => f.split(".")[0] === store));
    for (const r of mine) {
      if (relationBroken(r, before.stores)) continue;
      if (relationBroken(r, stateAt(passive, d.t + 300).stores) && relationBroken(r, stateAt(passive, d.t + 1000).stores)) return "inconsistent";
    }
    return "expected";
  }
  if (d.trigger === "inconsistency") {
    const now = stateAt(base, d.t);
    const refs = [...fieldRefs(String(d.subject.invariant ?? "")), ...((d.subject.paths as string[] | undefined) ?? [])];
    // a broken uniqueness relation over a list that now holds the same entity twice
    const dups = [...duplicateKeys(now.stores)].map((k) => k.split("#")[0]!);
    if (/unique/.test(String(d.subject.invariant ?? "")) && dups.some((f) => refs.some((x) => x === f || x.startsWith(f + "[") || f.startsWith(x)))) return "duplicate";
    // genuine only when a declared relation is broken AND the flagged relation names its derived field (fields[0]):
    // an unrelated learned coincidence over the same list is not this break
    const broken = rels.filter((r) => relationBroken(r, now.stores));
    const same = (f: string, x: string) => f === x || f.startsWith(x + ".") || x.startsWith(f + ".") || x.startsWith(f + "[");
    const overlap = broken.some((r) => refs.some((x) => same(r.fields[0]!, x)));
    return overlap ? "inconsistent" : "expected";
  }
  if (d.trigger === "transition") {
    const now = stateAt(base, d.t);
    return rels.some((r) => relationBroken(r, now.stores)) ? "unusual" : "expected";
  }
  return d.diagnosis ?? "expected";
}

/** Minimum adjusted gap (premiums included) for S1 (same as sim/src/gen/trajectory.ts S1_GAP). */
export const S1_GAP = 1.0;

/** "store.field" paths (weight > 0.1) that differ from the ideal run at time t; "dom" when only the DOM differs. */
export function divergedAt(base: State[], ideal: State[], t: number, app: AppManifest): string[] {
  const a = stateAt(base, t);
  const b = stateAt(ideal, t);
  const w = app.weights ?? {};
  const out: string[] = [];
  for (const store of new Set([...Object.keys(a.stores), ...Object.keys(b.stores)])) {
    const x = a.stores[store] as Record<string, unknown> | undefined;
    const y = b.stores[store] as Record<string, unknown> | undefined;
    if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if ((w[`${store}.${k}`] ?? w[store] ?? 1) <= 0.1) continue;
        if (valueDist(x[k], y[k]) > 0) out.push(`${store}.${k}`);
      }
    } else if (valueDist(x, y) > 0 && (w[store] ?? 1) > 0.1) out.push(store);
  }
  if (!out.length && valueDist(a.dom, b.dom) > 0) out.push("dom");
  return out;
}

/**
 * S1 (sim's diagnosisFromOutcome): never `expected` where acting clearly wins; name what the action repairs or
 * prevents.
 *   a) fields already wrong at the decision (vs the ideal run): the verdict of the latest non-expected
 *      mutation/delivery decision that wrote them;
 *   b) the subject repeats an accidental user step: duplicate;
 *   c) coalesce/block of a request with an identical one in flight or just answered: duplicate;
 *   d) fields already wrong with no named cause: inconsistent (inconsistency/transition) or stale;
 *   e) otherwise: unusual.
 */
export function diagnosisFromOutcome(d: DecisionRec, decisions: DecisionRec[], base: State[], ideal: State[], app: AppManifest, best: string): { diag: string; source: string } {
  const fields = divergedAt(base, ideal, d.t, app);
  let found: DecisionRec | undefined;
  for (const x of decisions) {
    if (x.t > d.t || x.k === d.k || !x.diagnosis || x.diagnosis === "expected") continue;
    if (x.trigger !== "mutation" && x.trigger !== "delivery") continue;
    const paths = ((x.subject.paths as string[] | undefined) ?? []).map((q) => q.split(".").slice(0, 2).join("."));
    const store = String(x.subject.store ?? "");
    if (fields.some((f) => paths.includes(f) || (store && f.startsWith(store + "."))) && (!found || x.t >= found.t)) found = x;
  }
  if (found) return { diag: found.diagnosis!, source: "a-write" };
  if (d.repeat) return { diag: "duplicate", source: "b-repeat" };
  if (d.trigger === "request" && (best === "coalesce" || best === "block") && d.twin) return { diag: "duplicate", source: "c-twin" };
  if (fields.length) return { diag: d.trigger === "inconsistency" || d.trigger === "transition" ? "inconsistent" : "stale", source: "d-diverged" };
  return { diag: "unusual", source: "e-other" };
}
