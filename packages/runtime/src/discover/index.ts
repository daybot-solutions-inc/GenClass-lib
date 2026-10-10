// Automatic state discovery (InitOptions.autoState): registration for the zero-code entries (src/cdn/auto-start.ts,
// src/cdn/global.ts) and for `@genclass/runtime/discover` (src/discover/entry.ts, which also installs early).

import { isKilled } from "../cdn/config.js";
import type { ReduxDiscoveryHost } from "./redux.js";
import { installReactDiscovery } from "./react.js";
import { installReduxDiscovery } from "./redux.js";
import { discoveryRegistry, type SwitchHost } from "./registry.js";
import type { Captured } from "./types.js";

/** Make InitOptions.autoState work (the zero-code entries call it; `early`: also install now, before any runtime). */
export function registerDiscovery(o: { early?: boolean } = {}): void {
  discoveryRegistry.installers ??= { react: installReactDiscovery, redux: installReduxDiscovery };
  if (!o.early || discoveryRegistry.early) return;
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.window !== "object" || typeof g.document !== "object" || !g.document || isKilled(g as never)) return;
  try {
    const host = switchHost(g);
    discoveryRegistry.early = {
      host,
      react: installReactDiscovery(host),
      redux: installReduxDiscovery(host, { redux: true, connect: true }),
    };
  } catch {
    /* discovery is optional: never break the page */
  }
}

const NOBODY: Captured = { amb: null, user: false, seq: 0 };

function switchHost(g: Record<string, unknown>): SwitchHost {
  let cur: ReduxDiscoveryHost | null = null;
  const perf = g.performance as { now?: () => number } | undefined;
  return {
    global: g,
    clock: { now: () => (cur ? cur.clock.now() : typeof perf?.now === "function" ? perf.now() : 0) },
    get runtime() {
      return cur?.runtime ?? null;
    },
    get attached() {
      return cur !== null;
    },
    attach(h) {
      cur = h;
    },
    detach(h) {
      if (cur === h) cur = null;
    },
    capture: () => (cur ? cur.capture() : NOBODY),
    observed: (base, initial, source) => (cur ? cur.observed(base, initial, source) : null),
    freeName: (base) => (cur ? cur.freeName(base) : null),
    tag: (name, source) => cur?.tag(name, source),
    log: (m, e) => cur?.log(m, e),
  };
}

