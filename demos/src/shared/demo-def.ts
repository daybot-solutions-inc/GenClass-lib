import type { Plugin, Runtime } from "@genclass/runtime";
import type { ServerLink } from "./server.ts";
import type { DemoId, GcMode, Scenario, Score, TrialKind } from "./types.ts";

/** What an app gets. Deliberately no access to the mock server's control channel or the oracle. */
export interface AppContext {
  gc: Runtime;
  el: HTMLElement;
  mode: GcMode;
  embed: boolean;
}

/** What an oracle gets (test code only; never passed to GenClass or the app). */
export interface OracleContext {
  link: ServerLink;
  doc: Document;
  el: HTMLElement;
  scenario: Scenario;
  /** Epoch ms of each `mark` step. */
  marks: Map<string, number>;
  /** Epoch ms when the scripted session started / ended. */
  t0: number;
  tEnd: number;
}

export interface Oracle {
  /** After the app mounted and loaded, before the session starts. */
  start?(): void;
  /** Named conditions for `until` steps. */
  check?(cond: string): boolean;
  /** After the session and quiescence. */
  finish(): Promise<Score>;
}

export interface DemoDefinition {
  id: DemoId;
  /** Fake address shown in the app's window chrome. */
  host: string;
  mount(ctx: AppContext): void | Promise<void>;
  scenario(seed: number, kind: TrialKind): Scenario;
  oracle(ctx: OracleContext): Oracle;
  /** Demo-specific controls under the chaos sliders (server-side scenario knobs). */
  chaosExtras?(link: ServerLink): HTMLElement;
  /** Highlighted integration snippet (HTML). */
  code: string;
  plugins?(): Plugin[];
  /** How to wait for quiescence after a session (false: do not wait, e.g. continuous polling). */
  settle?: { idleMs: number; timeoutMs: number; ignoreStreams?: boolean } | false;
  /** Server world parameters for the interactive page. */
  serverParams?: Record<string, unknown>;
  /** Condition the harness waits for after mounting, before the session (default: network quiet). */
  loaded?: string;
}
