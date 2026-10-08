// Trial harness inside a trial page (iframe or Playwright tab): exposes window.__trial with the scripted steps,
// runs them (synthetic driver) or lets Playwright run them with real input, then scores the trial with the demo's
// oracle. The oracle reads the DOM and the server truth through the control channel; GenClass never sees it.
import type { Chaos } from "./chaos.ts";
import type { DemoDefinition, Oracle, OracleContext } from "./demo-def.ts";
import { runSteps } from "./driver.ts";
import { collectStats, type GcSession } from "./genclass.ts";
import { epochNow, wait, type ServerLink } from "./server.ts";
import type { TrialParams } from "./settings.ts";
import type { Scenario, Score, Step, TrialResult } from "./types.ts";

export class TrialHarness {
  readonly steps: Step[];
  readonly scenario: Scenario;
  readonly timeouts: string[] = [];
  private oracle: Oracle;
  private ctx: OracleContext;
  private started = false;

  constructor(
    private def: DemoDefinition,
    private gcs: GcSession,
    private link: ServerLink,
    scenario: Scenario,
    private params: TrialParams,
    appEl: HTMLElement,
  ) {
    this.scenario = scenario;
    this.steps = scenario.steps;
    this.ctx = { link, doc: document, el: appEl, scenario, marks: new Map(), t0: epochNow(), tEnd: 0 };
    this.oracle = def.oracle(this.ctx);
  }

  start(): void {
    this.oracle.start?.();
  }

  check(cond: string): boolean {
    try {
      return this.oracle.check?.(cond) ?? false;
    } catch {
      return false;
    }
  }

  async chaos(patch: Partial<Chaos>): Promise<void> {
    await this.link.setChaos(patch);
  }

  async server(action: string, args?: unknown): Promise<void> {
    await this.link.world(action, args);
  }

  mark(name: string): void {
    this.ctx.marks.set(name, epochNow());
  }

  begin(): void {
    if (this.started) return;
    this.started = true;
    this.ctx.t0 = epochNow();
  }

  async finish(driver: "synthetic" | "playwright"): Promise<TrialResult> {
    this.ctx.tEnd = epochNow();
    let score: Score;
    let error: string | undefined;
    try {
      await this.link.world("freeze").catch(() => null);
      const s = this.def.settle ?? { idleMs: 700, timeoutMs: 20000 };
      if (s) await this.link.quiet(s.idleMs, s.timeoutMs, s.ignoreStreams);
      // Let writes GenClass is still holding apply (the hold budget can reach 800 ms) and late reverts happen
      // (up to ~2 s after a held write applied) before the oracle looks. Same wait in every mode.
      await wait(s ? 2500 : 350);
      score = await this.oracle.finish();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      score = { bug: false, reasons: ["oracle failed"], metrics: {} };
    }
    if (this.timeouts.length) score.metrics.untilTimeouts = this.timeouts.length;
    return {
      demo: this.def.id,
      mode: this.params.mode,
      kind: this.params.kind,
      seed: this.params.seed,
      label: this.scenario.label,
      durationMs: Math.round(this.ctx.tEnd - this.ctx.t0),
      gc: collectStats(this.gcs),
      driver,
      error,
      ...score,
      ...(this.gcs.trace ? { trace: this.gcs.trace } : {}),
    };
  }

  async runSynthetic(): Promise<TrialResult> {
    this.begin();
    await runSteps(document, this.steps, {
      chaos: (p) => this.chaos(p),
      server: (a, args) => this.server(a, args),
      mark: (n) => this.mark(n),
      check: (c) => this.check(c),
      onTimeout: (c) => this.timeouts.push(c),
    });
    return this.finish("synthetic");
  }
}

declare global {
  interface Window {
    __trial?: TrialHarness;
    __trialReady?: Promise<TrialHarness>;
    __trialError?: string;
  }
}
