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
    expect(effectiveGates(none, undefined, "delivery")).toEqual({ trigger: "delivery", report: 0.6, guard: 0.9, heal: 0.8, source: { report: "default", guard: "default", heal: "default" } });
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
