// The "[GenClass] Model ready" status line (runtime.ts -> the decider's onStatus listener). The model host notifies
// again while it stays ready (src/model/host.ts -> recordLatency: after the first decision, then every 5 s), and the
// compat matrix (compat/, 2026-10-10) found the line printed again after the first decision in every React app with
// discovered state. It is printed once per transition into ready.
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import type { DecisionProvider, ModelStatus } from "../src/types.js";
import { FakeClock, FakeServer, makeGlobal } from "./helpers.js";

class StatusDecider implements DecisionProvider {
  status: ModelStatus = { state: "loading" };
  private fns = new Set<(s: ModelStatus) => void>();
  ready = () => Promise.resolve();
  evaluate = () => Promise.reject(new Error("no model"));
  onStatus(fn: (s: ModelStatus) => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  set(s: ModelStatus) {
    this.status = s;
    for (const f of this.fns) f(s);
  }
}

function run() {
  const clock = new FakeClock();
  const lines: string[] = [];
  const events: ModelStatus[] = [];
  const decider = new StatusDecider();
  const rt = createRuntime({ clock, global: makeGlobal(new FakeServer(clock)), decider, report: (r) => lines.push(r.message), telemetry: false });
  rt.on("status", (s) => events.push(s));
  return { decider, lines, events };
}

const READY: ModelStatus = { state: "ready", model: "genclass-runtime-r17", device: "wasm", variant: "q8", loadMs: 780 };
const readyLines = (lines: string[]) => lines.filter((l) => l.includes("[GenClass] Model ready"));

describe("status report: Model ready (CONTRACT §10, model status)", () => {
  it("is printed once when the model becomes ready, not on later status updates while it stays ready", () => {
    const { decider, lines, events } = run();
    decider.set(READY);
    decider.set({ ...READY, latency: { p50: 40, p90: 60, n: 1, tokensP50: 300, msPerToken: 0.13, source: "evaluations" } } as ModelStatus);
    decider.set({ ...READY, latency: { p50: 42, p90: 70, n: 9, tokensP50: 310, msPerToken: 0.13, source: "evaluations" } } as ModelStatus);
    expect(readyLines(lines)).toEqual(["[GenClass] Model ready (genclass-runtime-r17, wasm, q8, 0.78s). Mode: observe."]);
    // every update still reaches status listeners (devtools)
    expect(events.length).toBe(3);
  });

  it("is printed again after the model reloads (ready, then not ready, then ready)", () => {
    const { decider, lines } = run();
    decider.set(READY);
    decider.set({ state: "loading" });
    decider.set(READY);
    expect(readyLines(lines).length).toBe(2);
  });

  it("errors keep their own lines", () => {
    const { decider, lines } = run();
    decider.set({ state: "error", error: "bad model" });
    expect(lines.join("\n")).toContain("Model unavailable (bad model); observing only.");
    expect(readyLines(lines)).toEqual([]);
  });
});
