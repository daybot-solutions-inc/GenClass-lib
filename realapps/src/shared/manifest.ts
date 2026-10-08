// App manifest: everything the harness knows about an app (Node side). The app's code never sees it except the
// server spec (served by the in-page mock backend) and the chosen feature flags.

import type { ExternalEvent, ServerSpec, StepKind } from "./types.js";

export interface Affordance {
  id: string;
  kind: StepKind;
  sel: string;
  /** Pick one of these texts to filter matching elements by. */
  text?: string[];
  /** Pick a random match index in [0, nth). */
  nth?: number;
  /** type: candidate texts; select: option values/labels. */
  values?: string[];
  weight: number;
  mode: "replace" | "accumulate";
  /** Intent key base shared by several affordances that replace the same thing (default: the id). */
  key?: string;
  /** How the intent key is built: affordance id plus the chosen text / index / value. */
  intent?: "aff" | "text" | "nth" | "value";
  clear?: boolean;
  enter?: boolean;
  /** Accidental double click probability (second click = accidental step). */
  dblclickP?: number;
  /** Impatient re-click while a request is in flight. */
  impatientP?: number;
  /** Intentional repeats: [min, max] extra clicks 150-600 ms apart (e.g. +1 three times). */
  burst?: [number, number];
  /** Only after one of these affordances has been used. */
  after?: string[];
  /** Typing in prefixes of the value (typeahead) instead of the whole value at once. */
  waitMs?: number;
  /** Follow-up affordance ids performed right after this one (e.g. type then click Save). */
  then?: string[];
  /** Never chosen on its own (only as a follow-up). */
  followOnly?: boolean;
  /** Using this affordance makes these ones unavailable again for `after` (e.g. sign out resets sign in). */
  resets?: string[];
  /** CSS selector that must match a visible element when the step runs; otherwise the step is skipped at once
   * (a precondition the user checks by looking, e.g. "the wizard is on step 2"). Not a blocked intent. */
  requires?: string;
  /** With `requires`: a matching element must also contain this text. */
  requiresText?: string;
}

export interface ExternalSpec {
  kind: ExternalEvent["kind"];
  target: string;
  /** Mean events per minute. */
  perMin: number;
  data?: Record<string, unknown>[];
  verb?: string;
  by?: number;
}

export interface Relation {
  name: string;
  /** "store.field" paths; the first is the derived field charged when the relation is violated. */
  fields: string[];
  check: (s: Record<string, any>) => boolean;
}

export interface AppManifest {
  name: string;
  title: string;
  framework: "react" | "preact" | "vue" | "svelte" | "solid" | "lit" | "vanilla" | "jquery" | "alpine" | "mobx-react" | string;
  libs: string[];
  domain: string;
  /** Entry file relative to the app dir (or the OSS checkout for oss apps). */
  entry: string;
  integration: "stores" | "observe";
  server: ServerSpec;
  /** Feature flags: name -> options (latent bugs and guards). */
  variants?: Record<string, (string | number | boolean)[]>;
  affordances: Affordance[];
  /** Initial-load wait: steps start after this (ms). */
  startMs?: number;
  external?: ExternalSpec[];
  /** Divergence weights per "store" or "store.field" (default 1; error-message fields should be 0). */
  weights?: Record<string, number>;
  relations?: Relation[];
  domRoot?: string;
  errorSelector?: string;
  /** Weight of the visible-DOM-text divergence (default 1). */
  domWeight?: number;
  /** Test-only app (held out of train/dev). */
  heldOut?: boolean;
  /** Open-source origin. */
  source?: { repo: string; commit?: string; license: string; dir?: string };
  localStorage?: Record<string, string>;
  /** Cookies set before the app loads (e.g. a session token), path "/". */
  cookies?: Record<string, string>;
  /** Session length range (ms). */
  sessionMs?: [number, number];
  /** Build options. */
  build?: {
    jsx?: "react" | "preact" | "solid-html" | "none";
    /** "automatic" (default) or "transform" (classic React.createElement). */
    jsxMode?: "automatic" | "transform";
    /** .js files contain JSX. */
    jsxInJs?: boolean;
    svelte?: boolean;
    vueCompiler?: boolean;
    /** Built by realapps/corpus/prepare_oss.sh with Vite (not by build.mjs). */
    vite?: boolean;
    /** Built by realapps/corpus/prepare_oss.sh with the app's own toolchain (not by build.mjs). */
    prebuilt?: boolean;
    loader?: Record<string, string>;
    define?: Record<string, string>;
    alias?: Record<string, string>;
    rootId?: string;
  };
}
