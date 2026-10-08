// Batch 6: data-derived gate thresholds. The model ships `gate` in meta.json (the model host passes it through in its
// ready status); effective threshold = the app's policy.thresholds override, else the model's gate for the trigger
// kind, else its tier default, else the defaults (guard 0.9, heal 0.8, report 0.6). The threshold used is in the
// decision record and the explanation.
import { describe, expect, it } from "vitest";
import { effectiveGates, parseGate, policyConfig } from "../src/decide/policy.js";
import { createModelHost, type WorkerLike } from "../src/model/host.js";
import type { FromWorker, ToWorker } from "../src/model/protocol.js";
import type { Answer, EvaluateRequest, ModelGate, ModelStatus } from "../src/types.js";
import { FakeClock, choice, setup } from "./helpers.js";

const GATE: ModelGate = { report: 0.4, guard: { default: 0.6, byTrigger: { delivery: 0.5, request: 0.7 } }, heal: { default: 0.55 } };

/** Answers every trigger with the first non-passive action at probability p (diagnosis stale). */
function soft(p: number) {
  return (req: EvaluateRequest): Record<string, Answer> => {
    const out: Record<string, Answer> = {};
    const dq = req.questions.diagnosis;
    if (dq && dq.type === "choice") out.diagnosis = choice("stale", Object.keys(dq.criteria), 0.6);
    const aq = req.questions.action;
    if (aq && aq.type === "choice") {
      const labels = Object.keys(aq.criteria);
      out.action = choice(labels[1] ?? labels[0], labels, p);
    }
    return out;
  };
}

describe("gate thresholds", () => {
  it("parseGate validates meta.json `gate` (numbers in [0, 1], known trigger kinds, a bare number = the default)", () => {
    expect(parseGate(GATE)).toEqual(GATE);
    expect(parseGate({ guard: 0.7, heal: { default: 2, byTrigger: { delivery: 0.4, bogus: 0.1, stall: -1 } }, report: "x" })).toEqual({ guard: { default: 0.7 }, heal: { byTrigger: { delivery: 0.4 } } });
    expect(parseGate(null)).toBeUndefined();
    expect(parseGate({ guard: {} })).toBeUndefined();
  });

  it("precedence: policy override, then the model's per-trigger value, then its default, then the defaults", () => {
    const none = policyConfig(undefined);
    expect(effectiveGates(none, undefined, "delivery")).toEqual({ kind: "mass", aggressiveness: 0.5, level: "balanced", levelSource: "scaled", trigger: "delivery", report: 0.6, guard: 0.9, heal: 0.8, source: { report: "default", guard: "default", heal: "default" } });
    expect(effectiveGates(none, GATE, "delivery")).toMatchObject({ guard: 0.5, heal: 0.55, report: 0.4, source: { guard: "model", heal: "model", report: "model" } });
    expect(effectiveGates(none, GATE, "mutation")).toMatchObject({ guard: 0.6, heal: 0.55 });
    expect(effectiveGates(none, GATE)).toMatchObject({ guard: 0.6, heal: 0.55 });
    const app = policyConfig({ thresholds: { guard: 0.95 } });
    expect(effectiveGates(app, GATE, "delivery")).toMatchObject({ guard: 0.95, heal: 0.55, report: 0.4, source: { guard: "policy", heal: "model", report: "model" } });
    expect(effectiveGates(policyConfig({ thresholds: { heal: 0.3 } }), { guard: { byTrigger: { stall: 0.2 } } }, "request")).toMatchObject({ guard: 0.9, heal: 0.3, source: { guard: "default", heal: "policy" } });
  });

  it("the runtime gates with the model's thresholds and records the threshold used; app overrides win", async () => {
    const run = async (thresholds?: { guard?: number }) => {
      const s = setup({ mode: "guard", triage: "always", script: soft(0.62), ...(thresholds ? { policy: { thresholds } } : {}) });
      s.decider.status = { state: "ready", model: "m", gate: GATE } as ModelStatus;
      s.server.on("GET", "/api/x", { body: 1, latency: 10 });
      void s.fetch("/api/x").catch(() => undefined);
      await s.clock.advance(400);
      const a = s.rt.atom("a", 0);
      void s.rt.op("w", () => a.set(1));
      await s.clock.flush();
      return s;
    };
    const s = await run();
    expect(s.rt.gates("request")).toMatchObject({ guard: 0.7, source: { guard: "model" } });
    const req = s.rt.decisions().find((d) => d.trigger === "request")!;
    expect(req).toMatchObject({ threshold: 0.7, thresholdSource: "model", executed: false });
    expect(req.reason).toMatch(/is below the guard threshold 0\.7$/);
    const mut = s.rt.decisions().find((d) => d.trigger === "mutation")!;
    expect(mut).toMatchObject({ threshold: 0.6, thresholdSource: "model", executed: true, action: "discard" }); // 0.62 ≥ the model's 0.6
    expect(s.rt.explain(mut.id)!.gates).toMatchObject({ trigger: "mutation", guard: 0.6, report: 0.4 });
    // the app's override wins over the model's gate
    const o = await run({ guard: 0.9 });
    const m2 = o.rt.decisions().find((d) => d.trigger === "mutation")!;
    expect(m2).toMatchObject({ threshold: 0.9, thresholdSource: "policy", executed: false });
    // no model gate: the defaults
    const plain = setup({ mode: "guard", triage: "always", script: soft(0.62) });
    expect(plain.rt.gates("mutation")).toMatchObject({ guard: 0.9, heal: 0.8, report: 0.6, source: { guard: "default" } });
  });

  it("the model host passes meta.json's gate (in its ready status) through to the runtime", async () => {
    class W implements WorkerLike {
      private fns: Array<(ev: { data: FromWorker }) => void> = [];
      postMessage(_m: ToWorker): void {}
      terminate(): void {}
      addEventListener(type: string, fn: (ev: any) => void): void {
        if (type === "message") this.fns.push(fn);
      }
      emit(m: FromWorker): void {
        for (const f of this.fns) f({ data: m });
      }
    }
    const w = new W();
    const clock = new FakeClock();
    const host = createModelHost({ baseUrl: "https://models.example/genclass/", clock, preload: "eager", workerFactory: () => w });
    await clock.flush();
    w.emit({ type: "hello" });
    w.emit({ type: "status", status: { state: "ready", device: "wasm", variant: "q8", model: "m", gate: GATE } });
    expect(host.status.gate).toEqual(GATE);
    const s = setup({ decider: host });
    expect(s.rt.gates("delivery")).toMatchObject({ guard: 0.5, heal: 0.55, report: 0.4, source: { guard: "model" } });
    host.dispose?.();
  });
});

describe("stall without a latency baseline", () => {
  it("a hung request with no baseline raises a stall after 10 s in flight (detection; GET may hedge)", async () => {
    const s = setup({ triage: "salient" });
    s.server.on("POST", "/api/upload", { status: 200, body: {}, latency: 60_000 });
    void s.fetch("/api/upload", { method: "POST", body: "{}" }).catch(() => undefined);
    await s.clock.advance(9_900);
    expect(s.decider.calls.filter((c) => c.trigger === "stall")).toHaveLength(0);
    await s.clock.advance(200);
    const st = s.decider.calls.filter((c) => c.trigger === "stall");
    expect(st).toHaveLength(1);
    const facts = (st[0].state.facts as string[]).join("\n");
    expect(facts).toMatch(/^The request #\d+ has been in flight for 10\.0s\./);
    expect(facts).toMatch(/POST \/api\/upload has no latency baseline yet \(0 completed requests\); requests without one are checked after 10\.0s in flight\./);
    await s.clock.advance(60_000);
  });
});

describe("gain gate (meta.json gate.kind = \"gain\")", () => {
  const GAIN: ModelGate = { kind: "gain", tauGain: 2, guard: { default: 1, byTrigger: { request: 3 } }, heal: { default: 2 } };

  /** Answer every trigger with fixed action probabilities (diagnosis stale unless given). */
  const probs = (p: Record<string, number>, diagnosis = "stale") => (req: EvaluateRequest): Record<string, Answer> => {
    const out: Record<string, Answer> = {};
    const dq = req.questions.diagnosis;
    if (dq && dq.type === "choice") out.diagnosis = choice(diagnosis, Object.keys(dq.criteria), 0.7);
    const aq = req.questions.action;
    if (aq && aq.type === "choice") {
      const labels = Object.keys(aq.criteria);
      const probabilities: Record<string, number> = {};
      for (const l of labels) if (p[l] !== undefined) probabilities[l] = p[l];
      const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
      out.action = { type: "choice", choice: top, confidence: 0.5, probabilities };
    }
    return out;
  };

  async function write(script: (req: EvaluateRequest) => Record<string, Answer>, gate: ModelGate | undefined, extra: Record<string, unknown> = {}) {
    const s = setup({ mode: "heal", triage: "always", script, policy: { holdWrites: true, ...(extra.policy as object) } });
    s.decider.status = { state: "ready", model: "m", ...(gate ? { gate } : {}) } as ModelStatus;
    const a = s.rt.atom("a", 0);
    void s.rt.op("w", () => a.set(1));
    await s.clock.flush();
    return { s, a, d: s.rt.decisions().find((x) => x.trigger === "mutation")! };
  }

  it("parses kind, τ and margins (any finite number); mass stays the default when meta has no kind", () => {
    expect(parseGate(GAIN)).toEqual(GAIN);
    expect(parseGate({ kind: "gain", tauGain: -1, guard: 4.5 })).toEqual({ kind: "gain", guard: { default: 4.5 } });
    expect(parseGate({ guard: 4.5 })).toBeUndefined(); // a mass gate ignores margins outside [0, 1]
    const c = policyConfig(undefined);
    expect(effectiveGates(c, { guard: { default: 0.6 } }, "mutation")).toMatchObject({ kind: "mass", guard: 0.6 });
    expect(effectiveGates(c, undefined)).toMatchObject({ kind: "mass", guard: 0.9, heal: 0.8 });
    expect(effectiveGates(c, GAIN, "request")).toMatchObject({ kind: "gain", tauGain: 2, guard: 3, heal: 2, source: { guard: "model" } });
    expect(effectiveGates(c, { kind: "gain" }, "mutation")).toMatchObject({ kind: "gain", tauGain: 1, guard: 2, heal: 2, source: { guard: "default" } });
    // the app's overrides are read in the active kind
    expect(effectiveGates(policyConfig({ thresholds: { guard: 0.5 } }), GAIN, "request")).toMatchObject({ kind: "gain", guard: 0.5, source: { guard: "policy" } });
  });

  it("acts when the best permitted action's gain clears its tier margin; records gateKind, gain and margin", async () => {
    // discard 0.5 vs apply 0.25: ĝ = 2 · ln 2 ≈ 1.39 > guard margin 1 → discard runs (the mass gate would need 0.9)
    const r = await write(probs({ apply: 0.25, discard: 0.5, defer: 0.25 }), GAIN);
    expect(r.d).toMatchObject({ gateKind: "gain", action: "discard", executed: true, margin: 1, thresholdSource: "model" });
    expect(r.d.gain).toBeCloseTo(2 * Math.log(2), 6);
    expect(r.d.threshold).toBeUndefined();
    expect(r.a.get()).toBe(0);
    expect(r.s.rt.explain(r.d.id)!.gates).toMatchObject({ kind: "gain", tauGain: 2, guard: 1 });
    // a smaller lead: ĝ = 2 · ln(0.4 / 0.35) ≈ 0.27 ≤ 1 → passive, with the reason
    const low = await write(probs({ apply: 0.35, discard: 0.4, defer: 0.25 }), GAIN);
    expect(low.d).toMatchObject({ gateKind: "gain", executed: false, ran: "apply", margin: 1 });
    expect(low.d.reason).toMatch(/^gain 0\.27 of discard over apply is not above the guard margin 1$/);
    expect(low.a.get()).toBe(1);
  });

  it("the default mass gate is unchanged when meta has no kind", async () => {
    const r = await write(probs({ apply: 0.25, discard: 0.5, defer: 0.25 }), { guard: { default: 0.9 } });
    expect(r.d).toMatchObject({ gateKind: "mass", executed: false, threshold: 0.9 }); // mass 0.75 < 0.9
    expect(r.d.gain).toBeUndefined();
    const none = await write(probs({ apply: 0.25, discard: 0.5, defer: 0.25 }), undefined);
    expect(none.d).toMatchObject({ gateKind: "mass", threshold: 0.9, thresholdSource: "default" });
  });

  it("an app override wins and is read as a margin under the gain gate", async () => {
    const r = await write(probs({ apply: 0.25, discard: 0.5, defer: 0.25 }), GAIN, { policy: { thresholds: { guard: 1.5 } } });
    expect(r.d).toMatchObject({ gateKind: "gain", executed: false, margin: 1.5, thresholdSource: "policy" }); // 1.39 ≤ 1.5
  });

  it("missing passive probability: the mass the model left over (clamped to ≥ 1e-6); still needs a non-expected diagnosis", async () => {
    // no probability for apply: p(apply) = 1 − 0.6 − 0.3 = 0.1 → ĝ = 2 · ln 6 ≈ 3.58
    const r = await write(probs({ discard: 0.6, defer: 0.3 }), GAIN);
    expect(r.d).toMatchObject({ gateKind: "gain", executed: true, action: "discard" });
    expect(r.d.gain).toBeCloseTo(2 * Math.log(6), 6);
    // everything on non-passive actions: p(apply) clamps to 1e-6 (finite gain)
    const all = await write(probs({ discard: 0.7, defer: 0.3 }), GAIN);
    expect(Number.isFinite(all.d.gain)).toBe(true);
    // a large gain with the diagnosis "expected" does not act (requireDiagnosis)
    const exp = await write(probs({ discard: 0.6, defer: 0.3 }, "expected"), GAIN);
    expect(exp.d).toMatchObject({ executed: false, reason: "the model's diagnosis is expected" });
  });
});

describe("aggressiveness (batch 11)", () => {
  const P: ModelGate = {
    profiles: {
      cautious: { report: 0.7, guard: { default: 0.95 }, heal: { default: 0.9 } },
      balanced: { report: 0.6, guard: { default: 0.8, byTrigger: { delivery: 0.7 } }, heal: { default: 0.7 } },
      eager: { report: 0.5, guard: { default: 0.6 }, heal: { default: 0.5 } },
    },
  };
  it("parses profiles and names levels", async () => {
    const { aggressivenessLevel } = await import("../src/decide/policy.js");
    expect(parseGate(P)?.profiles?.eager).toEqual({ report: 0.5, guard: { default: 0.6 }, heal: { default: 0.5 } });
    expect([aggressivenessLevel("cautious"), aggressivenessLevel("eager"), aggressivenessLevel(0.3), aggressivenessLevel("0.8"), aggressivenessLevel("x"), aggressivenessLevel(7)]).toEqual([0, 1, 0.3, 0.8, 0.5, 1]);
  });
  it("named levels pick their profile; numbers interpolate between neighbours (report too)", () => {
    const c = policyConfig(undefined);
    expect(effectiveGates(c, P, "delivery", 0.5)).toMatchObject({ guard: 0.7, level: "balanced", levelSource: "profiles" });
    expect(effectiveGates(c, P, "mutation", 1)).toMatchObject({ guard: 0.6, heal: 0.5, report: 0.5, level: "eager" });
    const g = effectiveGates(c, P, "mutation", 0.25);
    expect(g.guard).toBeCloseTo(0.875, 9);
    expect(g.heal).toBeCloseTo(0.8, 9);
    expect(g.report).toBeCloseTo(0.65, 9);
    expect(g.level).toBeUndefined();
  });
  it("without profiles the single gate (or defaults) is shifted: ±0.05 thresholds, ±1 margins, clamped", () => {
    const c = policyConfig(undefined);
    expect(effectiveGates(c, undefined, "mutation", 0)).toMatchObject({ guard: 0.95, levelSource: "scaled" });
    expect(effectiveGates(c, { guard: { default: 0.98 } }, "mutation", 0).guard).toBe(1);
    expect(effectiveGates(c, undefined, "mutation", 1).guard).toBeCloseTo(0.85, 9);
    expect(effectiveGates(c, { kind: "gain", guard: { default: 0.5 } }, "mutation", 1)).toMatchObject({ kind: "gain", guard: 0 });
    expect(effectiveGates(c, { kind: "gain" }, "mutation", 0).guard).toBe(3);
  });
  it("explicit policy.thresholds still win", () => {
    expect(effectiveGates(policyConfig({ thresholds: { guard: 0.99 } }), P, "mutation", 1)).toMatchObject({ guard: 0.99, source: { guard: "policy" } });
  });
  it("option, URL override and setAggressiveness; exposed in status, gates and explain", async () => {
    const s = setup({ aggressiveness: "cautious" });
    expect(s.rt.aggressiveness).toBe(0);
    expect(s.rt.gates()).toMatchObject({ level: "cautious", guard: 0.95 });
    s.rt.setAggressiveness("eager");
    expect(s.rt.status.aggressiveness).toBe(1);
    expect(s.rt.gates().guard).toBeCloseTo(0.85, 9);
    const u = setup({ aggressiveness: "cautious", extraGlobal: { location: { href: "http://app.test/?genclass-aggr=eager", pathname: "/", search: "?genclass-aggr=eager" } } });
    // URL overrides only demote (OPTIONS-SPEC §3), unless debug
    expect(u.rt.aggressiveness).toBe(0);
    const d = setup({ aggressiveness: "cautious", debug: true, extraGlobal: { location: { href: "http://app.test/?genclass-aggr=eager", pathname: "/", search: "?genclass-aggr=eager" } } });
    expect(d.rt.aggressiveness).toBe(1);
  });
});
