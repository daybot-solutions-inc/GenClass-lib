// Scenario = one random app program + one user session + one network/chaos profile + external events.
// Everything is derived from a single seed through keyed RNG forks, so a scenario can be rebuilt identically for
// every run (ideal, base, counterfactuals).

import { FEATURES, FEATURE_WEIGHTS } from "../app/features/index.js";
import { randomPersona, UserModel, type ExternalEvent, type FeatureCtx, type Persona, type UserStep } from "../app/feature.js";
import { Naming, cased } from "../app/naming.js";
import { DOMAINS, type Domain } from "../app/vocab.js";
import type { Lat, NetProfile, Outage, OutageMode, ServerBug, SlowPeriod } from "../net/network.js";
import { API_STYLES, type IdStyle } from "../net/server.js";
import { hashAll, Rng } from "../rng.js";
import { ACTION_PARA } from "../run/transform.js";

export interface FeatureInst {
  kind: string;
  id: string;
  route: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spec: any;
  pattern: string[];
}

export type Chaos = "calm" | "normal" | "flaky" | "degraded" | "storm";

export interface Scenario {
  seed: number;
  domain: string;
  appTitle: string;
  family: string;
  patterns: string[];
  features: FeatureInst[];
  idStyle: IdStyle;
  api: string;
  chaos: Chaos;
  net: NetProfile;
  persona: Persona;
  steps: UserStep[];
  external: ExternalEvent[];
  warmup: number;
  tUser: number;
  tEnd: number;
  askTimes: number[];
  /** Runtime diagnosis vocabulary override (paraphrases/subset), or null for the default. */
  diagnoses: Record<string, string> | null;
  /** Runtime action-description overrides (paraphrases), or null for the default wording. */
  actionWords: Record<string, string> | null;
  /** Model latency (virtual ms) median for the recording decider. */
  modelMs: number;
  /** Situation size in characters (runtime `situation.budget`): 3,200 WebGPU, 2,000 WASM ≥4 threads, 1,000 WASM 1 thread. */
  budget: number;
}

// ------------------------------------------------------------------------------------------------- splits

/** Held-out domains (test only): 10 of 55 = 18%. */
export const TEST_DOMAINS = new Set(["weather", "legal", "pets", "auction", "farm", "permits", "music", "hotel", "payroll", "survey"]);
/** Held-out combinator patterns (test only). */
export const TEST_PATTERNS = new Set(["search/guard:check", "settings/serialize", "toggle/pending-guard", "list/guard:abort", "cart/recompute:items-only-qty", "editor/echo:version-only", "poll/fail:throw"]);
/** Family hold-out: families whose hash falls in the first 17% go to test. */
export function familyHeldOut(family: string): boolean {
  return hashAll("family-split-v1", family) % 100 < 17;
}
export function splitOf(s: { domain: string; family: string; patterns: string[] }): "train" | "dev" | "test" {
  if (TEST_DOMAINS.has(s.domain) || familyHeldOut(s.family) || s.patterns.some((p) => TEST_PATTERNS.has(p))) return "test";
  return hashAll("dev-split-v1", s.family) % 100 < 3 ? "dev" : "train";
}

// ------------------------------------------------------------------------------------------ vocabulary

export const DEFAULT_DIAGNOSES: Record<string, string> = {
  expected: "normal behaviour, nothing is wrong",
  stale: "outdated data or an older operation is about to replace newer state",
  conflict: "concurrent operations are competing over the same state or resource",
  duplicate: "the same change or request is happening again without a new intent",
  inconsistent: "the state contradicts itself or relationships it normally keeps",
  failing: "an operation keeps failing or its failures follow a pattern",
  slow: "an operation is far slower than usual",
  overload: "work is being triggered far more often than usual",
  unusual: "this differs from how the same operation normally behaves",
  transient: "a one-off failure that is likely to succeed if tried again",
};

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

function diagVocab(rng: Rng): Record<string, string> | null {
  if (rng.bool(0.5)) return null;
  const out: Record<string, string> = {};
  const drop = rng.bool(0.3) ? new Set(rng.sample(["conflict", "slow", "overload", "unusual", "inconsistent", "duplicate", "transient"], rng.int(1, 2))) : new Set<string>();
  for (const [k, v] of Object.entries(DEFAULT_DIAGNOSES)) {
    if (drop.has(k)) continue;
    out[k] = rng.bool(0.6) ? rng.pick(DIAG_PARA[k]!) : v;
  }
  return out;
}

function actionVocab(rng: Rng): Record<string, string> | null {
  if (rng.bool(0.5)) return null;
  const out: Record<string, string> = {};
  for (const [k, ps] of Object.entries(ACTION_PARA)) if (rng.bool(0.6)) out[k] = rng.pick(ps);
  return Object.keys(out).length ? out : null;
}

// ----------------------------------------------------------------------------------------------- network

function lat(rng: Rng, lo: number, hi: number, s0: number, s1: number): Lat {
  return { median: rng.float(lo, hi), sigma: rng.float(s0, s1) };
}

function makeNet(rng: Rng, chaos: Chaos, sigs: { sig: string; kind: string }[], warmup: number, tUser: number): NetProfile {
  const m = chaos === "calm" ? 0.5 : chaos === "normal" ? 1 : chaos === "flaky" ? 1.5 : 2;
  const P: NetProfile = {
    ideal: false,
    latency: {},
    byKind: {
      read: lat(rng, 50 * m, 220 * m, 0.25, 0.7),
      write: lat(rng, 90 * m, 380 * m, 0.25, 0.7),
      auth: lat(rng, 80 * m, 300 * m, 0.2, 0.5),
      upload: lat(rng, 300 * m, 1500 * m, 0.3, 0.8),
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
    bugs: [],
    rateLimits: {},
    push: { median: rng.float(20, 150), sigma: rng.float(0.2, 0.8) },
  };
  // Per-endpoint personality: some endpoints are much slower than others.
  for (const { sig } of sigs) if (rng.bool(0.25)) P.latency[sig] = lat(rng, 100 * m, 1200 * m, 0.25, 0.8);
  const span = Math.max(1000, tUser - warmup);
  const win = (minLen: number, maxLen: number) => {
    const len = rng.float(minLen, maxLen);
    const start = warmup + rng.float(0, Math.max(1, span - len * 0.5));
    return { start, end: start + len };
  };
  const pickEps = (): string[] | "*" => (rng.bool(0.4) ? "*" : rng.sample(sigs.map((s) => s.sig), rng.int(1, Math.max(1, Math.min(3, sigs.length)))));
  if (chaos === "degraded" || chaos === "storm" || (chaos === "flaky" && rng.bool(0.4))) {
    const n = rng.int(1, 2);
    for (let i = 0; i < n; i++) {
      const mode: OutageMode = rng.weighted([["503", 4], ["500", 2], ["502", 2], ["neterr", 2], ["hang", 1], ["empty", 2]] as const);
      const o: Outage = { ...win(1500, 9000), endpoints: pickEps(), mode };
      P.outages.push(o);
    }
  }
  if (chaos !== "calm" && rng.bool(chaos === "normal" ? 0.25 : 0.6)) {
    const s: SlowPeriod = { ...win(2000, 10000), endpoints: pickEps(), mul: rng.float(3, 15) };
    P.slow.push(s);
  }
  if (chaos === "storm" || (chaos === "degraded" && rng.bool(0.4))) {
    P.capacity = { perSec: rng.int(4, 14), mode: rng.weighted([["503", 2], ["429", 2], ["latency", 1]] as const) };
  }
  if (chaos !== "calm" && rng.bool(0.25)) {
    const ep = rng.pick(sigs);
    P.rateLimits[ep.sig] = { perSec: rng.int(2, 6), retryAfter: rng.bool(0.6) };
  }
  if (chaos !== "calm" && rng.bool(0.15)) P.replicaLag = { ms: rng.int(300, 2500), p: rng.float(0.1, 0.5) };
  if (rng.bool(chaos === "calm" ? 0.05 : 0.18)) {
    const reads = sigs.filter((s) => s.kind === "read");
    if (reads.length) {
      const b: ServerBug = { ...win(2000, 8000), endpoint: rng.pick(reads).sig, kind: rng.weighted([["drop-field", 2], ["null-field", 2], ["empty-list", 3], ["stale-replica", 1], ["html", 1]] as const) };
      b.field = rng.pick(["total", "count", "name", "title", "price", "status", "items", "data"]);
      P.bugs.push(b);
    }
  }
  return P;
}

// ----------------------------------------------------------------------------------------------- build

export interface BuildOptions {
  /** Force feature kinds (tests). */
  kinds?: string[];
  chaos?: Chaos;
  duration?: number;
  domain?: string;
}

export function buildScenario(seed: number, opts: BuildOptions = {}): Scenario {
  const R = new Rng(hashAll("scenario-v1", seed));
  const domain: Domain = opts.domain ? DOMAINS.find((d) => d.name === opts.domain)! : R.fork("domain").pick(DOMAINS);
  const rP = R.fork("program");
  const appTitle = rP.pick(domain.titles);
  const naming = new Naming(rP.fork("naming"), appTitle);
  const api = rP.fork("api").pick(API_STYLES);
  const idStyle: IdStyle = rP.fork("ids").weighted([["num", 4], ["uuid", 2], ["prefixed", 2], ["slug", 1]] as const);
  // Features.
  let kinds: string[];
  if (opts.kinds) kinds = opts.kinds;
  else {
    const n = rP.weighted([[1, 35], [2, 45], [3, 20]] as const);
    kinds = [];
    const pool = Object.entries(FEATURE_WEIGHTS).filter(([k]) => k !== "benign");
    const rk = rP.fork("kinds");
    while (kinds.length < n) {
      const k = rk.weighted(pool.filter(([x]) => !kinds.includes(x)) as [string, number][]);
      kinds.push(k);
    }
    if (rk.bool(0.3)) kinds.push("benign");
  }
  const features: FeatureInst[] = [];
  kinds.forEach((kind, i) => {
    const def = FEATURES[kind];
    if (!def) throw new Error(`unknown feature ${kind}`);
    const rf = rP.fork("feature", i, kind);
    const entity = rf.pick(domain.entities);
    const id = `f${i}`;
    const route = `/${cased(rf.pick([entity.p, kind === "editor" ? "editor" : entity.p, rf.pick(["app", "home", "workspace"])]), "kebab")}`;
    naming.owner = id;
    const ctx: FeatureCtx = { rng: rf.fork("make"), domain, entity, naming, api, id, route };
    const spec = def.make(ctx);
    features.push({ kind, id, route, spec, pattern: def.pattern(spec).map((p) => `${kind}/${p}`) });
  });
  const family = [...new Set(kinds)].sort().join("+");
  const patterns = features.flatMap((f) => f.pattern);
  // Timing.
  const rT = R.fork("timing");
  // 15% long sessions (2-5 min) so transition profiles (>= 20 completions per op) are reached more often.
  const tUser = opts.duration ?? (rT.bool(0.15) ? rT.float(120000, 300000) : rT.float(20000, 75000));
  const warmup = tUser * rT.float(0.3, 0.6);
  const tEnd = tUser + rT.float(2500, 5000);
  // Chaos.
  const chaos: Chaos = opts.chaos ?? R.fork("chaos").weighted([["calm", 2], ["normal", 3], ["flaky", 3], ["degraded", 3], ["storm", 1]] as const);
  // Collect endpoint signatures by registering routes on a scratch server.
  const sigs = scratchSignatures(features, idStyle);
  const net = makeNet(R.fork("net"), chaos, sigs, warmup, tUser);
  // User session.
  const persona = randomPersona(R.fork("persona"));
  const steps: UserStep[] = [];
  const external: ExternalEvent[] = [];
  features.forEach((f, i) => {
    const def = FEATURES[f.kind]!;
    const ru = R.fork("session", i);
    const cover = ru.float(0.45, 1);
    const len = tUser * cover;
    const t0 = ru.float(0, tUser - len);
    const user = new UserModel(ru.fork("user"), persona, f.id);
    const mine = def.session(f.spec, user, { t0, t1: t0 + len }).filter((st) => st.t < tUser);
    steps.push(...mine);
    if (def.external) for (const ev of def.external(f.spec, R.fork("external", i), { t0: 0, t1: tUser }, mine)) external.push(ev);
  });
  steps.sort((a, b) => a.t - b.t);
  external.sort((a, b) => a.t - b.t);
  const rA = R.fork("ask");
  const askTimes: number[] = [];
  const nAsk = rA.int(1, 3);
  for (let i = 0; i < nAsk; i++) askTimes.push(rA.float(warmup * 0.5, tEnd - 200));
  askTimes.sort((a, b) => a - b);
  return {
    seed,
    domain: domain.name,
    appTitle,
    family,
    patterns,
    features,
    idStyle,
    api: api.name,
    chaos,
    net,
    persona,
    steps,
    external,
    warmup,
    tUser,
    tEnd,
    askTimes,
    diagnoses: diagVocab(R.fork("vocab")),
    actionWords: actionVocab(R.fork("action-vocab")),
    modelMs: R.fork("model").float(6, 25),
    budget: R.fork("budget").weighted([[3200, 40], [2000, 30], [1000, 30]] as const),
  };
}

import { Db, VirtualServer } from "../net/server.js";

function scratchSignatures(features: FeatureInst[], idStyle: IdStyle): { sig: string; kind: string }[] {
  const db = new Db(idStyle, "scratch");
  const srv = new VirtualServer(db);
  const sigs: { sig: string; kind: string }[] = [];
  const orig = srv.route.bind(srv);
  srv.route = (method, pattern, handler, meta) => {
    const sig = orig(method, pattern, handler, meta);
    sigs.push({ sig, kind: meta.kind });
    return sig;
  };
  for (const f of features) FEATURES[f.kind]!.server(f.spec, srv, db);
  return sigs;
}
