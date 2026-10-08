// The app's GenClass integration: one line in production (`GenClass.init()`). The harness passes its options
// (recording decider, policy, hooks, situation budget) through `window.__GENCLASS_INIT__`, the way a test setup
// configures an SDK; feature flags come from `window.__RW_VARIANT` (the app's own flag service in production).
import { GenClass } from "@genclass/runtime";

const g = globalThis as unknown as { __GENCLASS_INIT__?: Record<string, unknown>; __RW_VARIANT?: Record<string, unknown> };

export const rt = GenClass.init((g.__GENCLASS_INIT__ ?? {}) as Parameters<typeof GenClass.init>[0]);

/** A feature flag (latent bug or guard variant of this app). */
export function flag<T>(name: string, dflt: T): T {
  const v = g.__RW_VARIANT?.[name];
  return v === undefined ? dflt : (v as T);
}
