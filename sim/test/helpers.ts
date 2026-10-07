import type { UserStep } from "../src/app/feature.js";
import type { Outage } from "../src/net/network.js";
import { createFakeRuntime } from "../src/run/fake-runtime.js";
import type { RuntimeFactory } from "../src/run/rt.js";
import { realRuntimeFactory } from "../src/run/rt.js";
import { runScenario, type DecisionRec, type RunResult } from "../src/run/runner.js";
import { buildScenario, type Scenario } from "../src/world/scenario.js";

/** The runtime used by oracle tests: real when SIM_RUNTIME=real (and available), else the fake test double. */
export async function testFactory(): Promise<{ factory: RuntimeFactory; name: string }> {
  if (process.env.SIM_RUNTIME === "real") return { factory: await realRuntimeFactory(), name: "real" };
  return { factory: createFakeRuntime, name: "fake" };
}

export interface MiniOpts {
  steps: UserStep[];
  latency?: (method: string, path: string, occurrence: number) => number | undefined;
  outages?: Outage[];
  duration?: number;
  domain?: string;
}

/** A one-feature scenario with a calm, fully controlled network and a scripted session. */
export function mini(kind: string, patch: Record<string, unknown>, o: MiniOpts): Scenario {
  const s = buildScenario(4242, { kinds: [kind], chaos: "calm", duration: o.duration ?? 6000, domain: o.domain ?? "commerce" });
  Object.assign(s.features[0]!.spec, patch);
  s.steps = o.steps.slice().sort((a, b) => a.t - b.t);
  s.external = [];
  s.askTimes = [];
  s.diagnoses = null;
  s.actionWords = null;
  s.tEnd = (o.duration ?? 6000) + 3000;
  s.net = {
    ...s.net,
    spikeP: 0,
    transientP: 0,
    netErrP: 0,
    outages: o.outages ?? [],
    slow: [],
    bugs: [],
    rateLimits: {},
    latency: {},
    byKind: { read: { median: 80, sigma: 0 }, write: { median: 120, sigma: 0 }, auth: { median: 80, sigma: 0 }, upload: { median: 300, sigma: 0 }, bulk: { median: 200, sigma: 0 } },
    ...(o.latency ? { latencyFn: o.latency } : {}),
  };
  delete s.net.capacity;
  delete s.net.replicaLag;
  return s;
}

export function step(t: number, action: string, ui: UserStep["ui"], intent: Partial<UserStep["intent"]> & { key: string }, args?: Record<string, unknown>): UserStep {
  const st: UserStep = { t, feature: "f0", action, ui, intent: { kind: intent.kind ?? action, key: intent.key, mode: intent.mode ?? "accumulate", accidental: intent.accidental ?? false } };
  if (args) st.args = args;
  return st;
}

export async function runBoth(scn: Scenario, factory: RuntimeFactory): Promise<{ ideal: RunResult; base: RunResult }> {
  const ideal = await runScenario(scn, { ideal: true, serverTimeline: true });
  const base = await runScenario(scn, { ideal: false, factory, record: true });
  return { ideal, base };
}

export function argmin(c: Record<string, number>): string {
  return Object.entries(c).sort((a, b) => a[1] - b[1])[0]![0];
}

export function find(base: RunResult, pred: (d: DecisionRec) => boolean): DecisionRec | undefined {
  return base.decisions.find(pred);
}
