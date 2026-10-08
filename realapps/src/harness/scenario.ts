// Scenario = one app (+ feature flags) + one scripted user session + one network/chaos profile + other users'
// events + wording. Everything derives from one seed through keyed RNG forks (sim/src/rng.ts), so every run of a
// trajectory (ideal, base, counterfactuals) rebuilds the same scenario.

import { hashAll, Rng } from "../../../sim/src/rng.js";
import { ACTION_PARA } from "../../../sim/src/run/transform.js";
import { DEFAULT_DIAGNOSES as RT_DEFAULT_DIAGNOSES } from "@rt/questions";
import type { AppManifest } from "../shared/manifest.js";
import { endpointsOf } from "../shared/routes.js";
import type { ExternalEvent, Lat, NetProfile, OutageMode, Step } from "../shared/types.js";

export type Chaos = "calm" | "normal" | "flaky" | "degraded" | "storm";

export interface Scenario {
  seed: number;
  app: AppManifest;
  variant: Record<string, unknown>;
  patterns: string[];
  family: string;
  chaos: Chaos;
  clean: boolean;
  net: NetProfile;
  steps: Step[];
  recover: Step[][];
  external: ExternalEvent[];
  warmup: number;
  tUser: number;
  tEnd: number;
  budget: number;
  modelMs: number;
  explore: number;
  vocab: { diagnoses?: Record<string, string>; actions?: Record<string, string> } | null;
  split: "train" | "dev" | "test";
  epoch: number;
  askTimes: number[];
}

// --------------------------------------------------------------------------------------------- splits
/** Frameworks held out entirely (test only). */
export const TEST_FRAMEWORKS = new Set(["lit"]);
/** Apps held out entirely (test only), besides manifests with `heldOut` and the held-out frameworks/libraries. Alpine
 * is a TRAIN framework (other Alpine apps train); only this one Alpine app and one raw-XHR app are held out. */
export const TEST_APPS = new Set(["swr-status", "alpine-tasks", "xhr-autocomplete"]);
/** Libraries held out entirely (test only): every app that uses one of them. */
export const TEST_LIBS = new Set(["swr"]);
/** Flag patterns held out (test only), app/flag:value. */
export const TEST_PATTERNS = new Set<string>(["react-search/guard:reqid", "vue-editor/save:serialize", "zustand-board/push:version-check"]);

export function splitOf(app: AppManifest, patterns: string[]): "train" | "dev" | "test" {
  if (app.heldOut || TEST_APPS.has(app.name) || TEST_FRAMEWORKS.has(app.framework) || app.libs.some((l) => TEST_LIBS.has(l.toLowerCase().split(/[@ (]/)[0]!)) || patterns.some((p) => TEST_PATTERNS.has(p))) return "test";
  return hashAll("realapps-dev-v1", app.name, ...patterns) % 100 < 4 ? "dev" : "train";
}

// ------------------------------------------------------------------------------------------- vocabulary
// Mirrors sim/src/world/scenario.ts (diagVocab / actionVocab): 50% default wording, otherwise paraphrases.
/** The runtime's own default diagnosis vocabulary (same labels and wording as the build in use). */
export const DEFAULT_DIAGNOSES: Record<string, string> = { ...(RT_DEFAULT_DIAGNOSES as Record<string, string>) };
const DIAG_PARA: Record<string, string[]> = {
  expected: ["everything is working as intended", "nothing unusual: this is normal app behaviour", "no problem here; the app behaves normally"],
  stale: ["data from an older request or state would overwrite something newer", "this is out of date: newer information already exists", "an earlier operation finishing late would replace more recent state"],
  conflict: ["two in-progress operations are fighting over the same data", "simultaneous changes from different sources collide", "competing updates target the same record at the same time"],
  duplicate: ["this repeats an action or request that already happened, with no new intent", "the same work is being done twice by accident", "a repeated submission of something already sent"],
  inconsistent: ["state values disagree with each other", "derived values no longer match the data they come from", "the app's state is internally contradictory"],
  failing: ["requests keep failing in a pattern", "the service is erroring repeatedly", "an operation is failing again and again"],
  slow: ["this is taking much longer than it normally does", "latency is far above its usual level", "the request is unusually slow"],
  overload: ["too much work is being triggered, far above the usual rate", "requests are being fired in a storm", "the app is hammering the service much more than normal"],
  unusual: ["this operation behaved differently from its usual pattern", "the result has an unexpected shape compared with previous runs", "a normally consistent operation produced an atypical outcome"],
  transient: ["an isolated failure that should work if retried", "a momentary glitch, not a pattern; trying again would likely succeed", "a single failed attempt that a retry would probably fix"],
};

function diagVocab(rng: Rng): Record<string, string> | undefined {
  if (rng.bool(0.5)) return undefined;
  const out: Record<string, string> = {};
  // The label set always equals the runtime's default vocabulary (paraphrased wording only): production apps offer
  // every label, and a row whose gold label was dropped would lose its diagnosis. (The draw is kept so the RNG
  // stream, and every other choice of the scenario, stays the same.)
  rng.bool(0.3);
  const drop = new Set<string>();
  for (const [k, v] of Object.entries(DEFAULT_DIAGNOSES)) {
    if (drop.has(k)) continue;
    out[k] = rng.bool(0.6) && DIAG_PARA[k] ? rng.pick(DIAG_PARA[k]!) : v;
  }
  return out;
}

function actionVocab(rng: Rng): Record<string, string> | undefined {
  if (rng.bool(0.5)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, ps] of Object.entries(ACTION_PARA)) if (rng.bool(0.6)) out[k] = rng.pick(ps);
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------------------------- chaos

function lat(rng: Rng, lo: number, hi: number, s0: number, s1: number): Lat {
  return { median: rng.float(lo, hi), sigma: rng.float(s0, s1) };
}

export function makeNet(rng: Rng, chaos: Chaos, app: AppManifest, warmup: number, tUser: number): NetProfile {
  const eps = endpointsOf(app.server);
  const m = chaos === "calm" ? 0.5 : chaos === "normal" ? 1 : chaos === "flaky" ? 1.5 : 2;
  const P: NetProfile = {
    ideal: false,
    latency: {},
    byKind: {
      read: lat(rng, 50 * m, 220 * m, 0.25, 0.7),
      write: lat(rng, 90 * m, 380 * m, 0.25, 0.7),
      auth: lat(rng, 80 * m, 300 * m, 0.2, 0.5),
      bulk: lat(rng, 200 * m, 900 * m, 0.3, 0.7),
    },
    spikeP: chaos === "calm" ? 0.005 : rng.float(0.01, chaos === "normal" ? 0.04 : 0.1),
    spikeMul: [3, rng.float(6, 25)],
    transientP: chaos === "calm" ? 0 : chaos === "normal" ? rng.float(0, 0.015) : rng.float(0.02, 0.12),
    postCommitP: rng.float(0.2, 0.7),
    netErrP: chaos === "calm" ? 0 : rng.float(0, chaos === "normal" ? 0.004 : 0.03),
    gatewayMs: rng.int(8000, 30000),
    outages: [],
    slow: [],
    rateLimits: {},
    bugs: [],
    push: { median: rng.float(20, 150), sigma: rng.float(0.2, 0.8) },
    wsDrops: [],
  };
  // endpoints the session actually uses are unknown in advance; choose among all of the app's endpoints
  const sigs = eps.map((e) => e.sig);
  for (const e of eps) if (rng.bool(0.25)) P.latency[e.sig] = lat(rng, 100 * m, 1200 * m, 0.25, 0.8);
  const span = Math.max(1000, tUser - warmup);
  const win = (minLen: number, maxLen: number) => {
    const len = rng.float(minLen, maxLen);
    const start = warmup + rng.float(0, Math.max(1, span - len * 0.5));
    return { start, end: start + len };
  };
  const reads = eps.filter((e) => e.kind === "read").map((e) => e.sig);
  const pickEps = (): string[] | "*" => (rng.bool(0.4) ? "*" : rng.sample(sigs, rng.int(1, Math.max(1, Math.min(3, sigs.length)))));
  if (chaos === "degraded" || chaos === "storm" || (chaos === "flaky" && rng.bool(0.4))) {
    const n = rng.int(1, 2);
    for (let i = 0; i < n; i++) {
      const mode: OutageMode = rng.weighted([["503", 4], ["500", 2], ["502", 2], ["neterr", 2], ["hang", 1], ["empty", 2]] as const);
      P.outages.push({ ...win(1500, 9000), endpoints: pickEps(), mode });
    }
  }
  if (chaos !== "calm" && rng.bool(chaos === "normal" ? 0.25 : 0.6)) P.slow.push({ ...win(2000, 10000), endpoints: pickEps(), mul: rng.float(3, 15) });
  if (chaos === "storm" || (chaos === "degraded" && rng.bool(0.4))) P.capacity = { perSec: rng.int(4, 14), mode: rng.weighted([["503", 2], ["429", 2], ["latency", 1]] as const) };
  if (chaos !== "calm" && rng.bool(0.25) && sigs.length) P.rateLimits[rng.pick(sigs)] = { perSec: rng.int(2, 6), retryAfter: rng.bool(0.6) };
  if (chaos !== "calm" && rng.bool(0.15)) P.replicaLag = { ms: rng.int(300, 2500), p: rng.float(0.1, 0.5) };
  if (reads.length && rng.bool(chaos === "calm" ? 0.05 : 0.18)) {
    P.bugs.push({ ...win(2000, 8000), endpoint: rng.pick(reads), kind: rng.weighted([["drop-field", 2], ["null-field", 2], ["empty-list", 3], ["html", 1]] as const), field: rng.pick(["total", "count", "name", "title", "price", "status", "items", "text", "qty"]) });
  }
  const live = app.server.collections.some((c) => c.live) || (app.server.docs ?? []).some((d) => d.live) || (app.server.counters ?? []).some((c) => c.live);
  if (live && chaos !== "calm" && rng.bool(chaos === "normal" ? 0.2 : 0.55)) {
    const n = rng.int(1, 2);
    for (let i = 0; i < n; i++) P.wsDrops.push({ t: warmup + rng.float(0, span), downMs: rng.float(500, 6000) });
  }
  return P;
}

// -------------------------------------------------------------------------------------------- session

interface Persona {
  thinkMs: number;
  typeMs: number;
  typoP: number;
  dbl: number;
  impatient: number;
  idleP: number;
}

function persona(rng: Rng): Persona {
  return { thinkMs: rng.float(500, 2200), typeMs: rng.float(55, 210), typoP: rng.float(0, 0.06), dbl: rng.weighted([[0, 3], [1, 4], [2.5, 2]] as const), impatient: rng.weighted([[0, 3], [1, 4], [2.5, 2]] as const), idleP: rng.float(0, 0.12) };
}

export function buildSession(app: AppManifest, rng: Rng, p: Persona, t0: number, tUser: number): { steps: Step[]; recover: Step[][] } {
  let steps: Step[] = [];
  const main = steps;
  let indexBase = 0;
  const used = new Set<string>();
  const byId = new Map(app.affordances.map((a) => [a.id, a]));
  let t = t0;
  const push = (s: Omit<Step, "i">): Step => {
    const st = { ...s, i: indexBase + steps.length } as Step;
    steps.push(st);
    return st;
  };
  let chainHead: number | undefined;
  const one = (aid: string, r: Rng): number => {
    const a = byId.get(aid);
    if (!a) return 0;
    used.add(a.id);
    for (const x of a.resets ?? []) used.delete(x);
    const head = (a.sameNth || a.sameText) && chainHead !== undefined ? steps[chainHead - indexBase] : undefined;
    const own = a.text?.length ? r.pick(a.text) : undefined;
    const text = a.sameText ? head?.text ?? own : own ?? (a.sameNth ? head?.text : undefined);
    const nth = a.sameNth && head?.nth !== undefined ? head.nth : a.nth ? r.int(0, a.nth - 1) : undefined;
    const value = a.values?.length ? r.pick(a.values) : undefined;
    const key = `${a.key ?? a.id}${a.intent === "text" && text ? `:${text}` : a.intent === "nth" && nth !== undefined ? `:${nth}` : a.intent === "value" && value ? `:${value}` : ""}`;
    const intent = { key, mode: a.mode, affordance: a.id };
    const base = { kind: a.kind, sel: a.sel, intent, ...(text ? { text } : {}), ...(nth !== undefined ? { nth } : {}), ...(a.waitMs ? { waitMs: a.waitMs } : {}), ...(a.requires ? { requires: a.requires } : {}), ...(a.requiresText ? { requiresText: a.requiresText } : {}), ...(a.after?.length ? { after: a.after } : {}), ...(a.resets?.length ? { resets: a.resets } : {}), ...(chainHead !== undefined ? { head: chainHead } : {}), ...(a.kind === "key" && value !== undefined ? { key: value } : {}) };
    if (a.kind === "type") {
      const v = value ?? "";
      let typed = "";
      const keyMs: number[] = [];
      for (const ch of v) {
        if (p.typoP > 0 && r.bool(p.typoP) && /[a-z]/.test(ch)) {
          typed += String.fromCharCode(97 + r.int(0, 25)) + "\b";
          keyMs.push(r.lognormal(p.typeMs, 0.45), r.lognormal(p.typeMs * 1.6, 0.4));
        }
        typed += ch;
        keyMs.push(ch === " " ? r.lognormal(p.typeMs * 1.5, 0.5) : r.lognormal(p.typeMs, 0.5));
      }
      push({ ...base, t, value: typed, keyMs, ...(a.clear ? { clear: true } : {}), ...(a.enter ? { enter: true } : {}) });
      return keyMs.reduce((x, y) => x + y, 0) + 60;
    }
    const first = push({ ...base, t, ...(value !== undefined ? { value } : {}) });
    let dur = 40;
    if (a.dblclickP && r.bool(Math.min(0.6, a.dblclickP * p.dbl))) {
      const d = r.float(60, 160);
      push({ ...base, t: t + d, accidental: true, repeatOf: first.i, ...(value !== undefined ? { value } : {}) });
      dur = d + 20;
    } else if (a.impatientP && r.bool(Math.min(0.6, a.impatientP * p.impatient))) {
      const d = r.float(500, 2500);
      push({ ...base, t: t + d, accidental: true, repeatOf: first.i, when: "inflight", ...(value !== undefined ? { value } : {}) });
      dur = d + 20;
    }
    if (a.burst) {
      const n = r.int(a.burst[0], a.burst[1]);
      for (let i = 0; i < n; i++) {
        dur += r.float(150, 600);
        push({ ...base, t: t + dur, ...(value !== undefined ? { value } : {}) });
      }
    }
    return dur;
  };
  // alternatives for a step the ideal user cannot take: other simple affordances (no chains), drawn up front
  const altFor = (r: Rng, not: string): Omit<Step, "i" | "t" | "alts">[] => {
    // ordinary actions only (not session-ending ones such as sign-out), drawn by the affordances' weights
    let pool = app.affordances.filter((a) => !a.followOnly && !a.recover && !a.then?.length && !a.resets?.length && a.id !== not && a.kind !== "type" && a.weight > 0);
    const picks: typeof pool = [];
    while (picks.length < 2 && pool.length) {
      const a = r.weighted(pool.map((x) => [x, x.weight] as const));
      picks.push(a);
      pool = pool.filter((x) => x !== a);
    }
    const out: Omit<Step, "i" | "t" | "alts">[] = [];
    const saveSteps = steps;
    const saveBase = indexBase;
    for (const a of picks) {
      steps = [];
      indexBase = -1000000;
      one(a.id, r.fork("alt", a.id));
      const st = steps[0];
      if (st) {
        const { i: _i, t: _t, ...rest } = st;
        void _i;
        void _t;
        out.push(rest);
      }
    }
    steps = saveSteps;
    indexBase = saveBase;
    return out;
  };
  let guard = 0;
  while (t < tUser && guard++ < 2000) {
    const cands = app.affordances.filter((a) => !a.followOnly && !a.recover && !(a.once && used.has(a.id)) && (!a.after || a.after.some((x) => used.has(x))));
    if (!cands.length) break;
    const a = rng.weighted(cands.map((c) => [c, c.weight] as const));
    const r = rng.fork("step", steps.length);
    chainHead = undefined;
    const headIndex = steps.length;
    const usedBefore = new Set(used);
    t += one(a.id, r);
    // a single-step pick gets alternatives (the "used" bookkeeping is the main pick's)
    if (!a.then?.length && steps[headIndex] && !steps[headIndex]!.accidental) {
      const alts = altFor(r.fork("alts"), a.id);
      used.clear();
      for (const x of usedBefore) used.add(x);
      used.add(a.id);
      for (const x of a.resets ?? []) used.delete(x);
      if (alts.length) steps[headIndex]!.alts = alts;
    }
    chainHead = a.then?.length ? headIndex : undefined;
    for (const f of a.then ?? []) {
      t += r.lognormal(Math.min(900, p.thinkMs * 0.5), 0.5);
      t += one(f, r.fork(f));
    }
    chainHead = undefined;
    t += rng.lognormal(p.thinkMs, 0.6);
    if (rng.bool(p.idleP)) t += rng.float(3000, 10000);
  }
  // recovery chains (performed at run time whenever their precondition holds)
  const recover: Step[][] = [];
  app.affordances
    .filter((a) => a.recover)
    .forEach((a, j) => {
      steps = [];
      indexBase = 100000 + j * 100;
      const r = rng.fork("recover", a.id);
      chainHead = undefined;
      one(a.id, r);
      chainHead = a.then?.length ? indexBase : undefined;
      for (const f of a.then ?? []) one(f, r.fork(f));
      chainHead = undefined;
      recover.push(steps.map((x) => ({ ...x, t: 0 })));
    });
  steps = main;
  indexBase = 0;
  return { steps: steps.filter((s) => s.t < tUser), recover };
}

function external(app: AppManifest, rng: Rng, tUser: number): ExternalEvent[] {
  const out: ExternalEvent[] = [];
  for (const [i, e] of (app.external ?? []).entries()) {
    const r = rng.fork("ext", i);
    if (e.perMin <= 0) continue;
    let t = r.float(500, 4000);
    while (t < tUser) {
      const ev: ExternalEvent = { t, kind: e.kind, target: e.target, index: r.int(0, 1000), ...(e.where ? { where: e.where } : {}) };
      if (e.data?.length) ev.data = r.pick(e.data);
      if (e.verb) ev.verb = e.verb;
      if (e.by !== undefined) ev.by = e.by;
      out.push(ev);
      t += -Math.log(1 - r.next()) * (60000 / e.perMin);
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------------------------- build

export function buildScenario(seed: number, apps: AppManifest[], opts: { app?: string; chaos?: Chaos; clean?: boolean } = {}): Scenario {
  const R = new Rng(hashAll("realapps-scenario-v1", seed));
  const app = opts.app ? apps.find((a) => a.name === opts.app)! : R.fork("app").pick(apps);
  if (!app) throw new Error(`unknown app ${opts.app}`);
  const rv = R.fork("variant");
  const variant: Record<string, unknown> = {};
  const patterns: string[] = [];
  const clean = opts.clean ?? R.fork("clean").bool(0.08);
  for (const [k, vals] of Object.entries(app.variants ?? {})) {
    // clean runs use the first option (the app's default, guarded wording where the manifest lists it first)
    const v = clean ? vals[0]! : rv.pick(vals);
    variant[k] = v;
    patterns.push(`${app.name}/${k}:${v}`);
  }
  if (app.localStorage) variant.__localStorage = app.localStorage;
  if (app.cookies) variant.__cookies = app.cookies;
  const rT = R.fork("timing");
  const [lo, hi] = app.sessionMs ?? [20000, 60000];
  const tUser = rT.bool(0.1) ? rT.float(Math.max(hi, 90000), Math.max(hi, 90000) + 60000) : rT.float(lo, hi);
  const warmup = tUser * rT.float(0.3, 0.6);
  const tEnd = tUser + rT.float(2500, 5000);
  const chaos: Chaos = opts.chaos ?? (clean ? "calm" : R.fork("chaos").weighted([["calm", 2], ["normal", 3], ["flaky", 3], ["degraded", 3], ["storm", 1]] as const));
  const net = makeNet(R.fork("net"), chaos, app, warmup, tUser);
  if (clean) {
    net.transientP = 0;
    net.netErrP = 0;
    net.outages = [];
    net.bugs = [];
    net.wsDrops = [];
    net.replicaLag = undefined;
  }
  const P = persona(R.fork("persona"));
  if (clean) {
    P.dbl = 0;
    P.impatient = 0;
  }
  const { steps, recover } = buildSession(app, R.fork("session"), P, app.startMs ?? rT.float(600, 1800), tUser);
  const ext = external(app, R.fork("external"), tUser);
  const vd = diagVocab(R.fork("vocab"));
  const va = actionVocab(R.fork("action-vocab"));
  const vocab = vd || va ? { ...(vd ? { diagnoses: vd } : {}), ...(va ? { actions: va } : {}) } : null;
  return {
    seed,
    app,
    variant,
    patterns,
    family: app.name,
    chaos,
    clean,
    net,
    steps,
    recover,
    external: ext,
    warmup,
    tUser,
    tEnd,
    budget: R.fork("budget").weighted([[3200, 40], [2000, 30], [1000, 30]] as const),
    modelMs: R.fork("model").float(6, 25),
    explore: clean ? 0 : R.fork("explore").weighted([[0, 4], [0.08, 3], [0.2, 2]] as const),
    vocab,
    split: splitOf(app, patterns),
    epoch: Date.UTC(2026, 3, 1, 9, 0, 0) + (seed % 1000) * 86400000,
    askTimes: (() => {
      const rA = R.fork("ask");
      const xs: number[] = [];
      for (let i = rA.int(1, 3); i > 0; i--) xs.push(rA.float(warmup * 0.5, tEnd - 200));
      return xs.sort((a, b) => a - b);
    })(),
  };
}
