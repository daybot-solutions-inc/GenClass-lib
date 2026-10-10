// The zero-code start shared by @genclass/runtime/auto and /auto/{observe,guard,heal}. Owner: INSTALL.

import { GenClass } from "../index.js";
import type { InitOptions, Runtime } from "../types.js";
import { devtoolsOptions, isKilled, mergeConfig, readMetaConfig, readWindowConfig, splitConfig, whenBody } from "./config.js";

/** What the zero-code entries add to GenClass.init()'s defaults. */
export const AUTO_DEFAULTS: InitOptions = { autoState: true };

/**
 * GenClass.init() with `defaults`, overridden by <meta name="genclass"> and window.GENCLASS_CONFIG; mounts the
 * devtools overlay when the page config asks for it. Outside a browser: GenClass.init()'s inert runtime.
 */
export function startAuto(defaults: InitOptions = {}): Runtime {
  const g = globalThis as unknown as { window?: unknown; document?: unknown; location?: Location; localStorage?: Storage; console?: Console };
  if (typeof g.window !== "object" || typeof g.document !== "object" || !g.document) return GenClass.init(defaults);
  const doc = g.document as Document;
  // automatic state discovery is on by default here (installed now, before the framework's modules run)
  const { init, devtools } = splitConfig(mergeConfig(AUTO_DEFAULTS, defaults, readMetaConfig(doc), readWindowConfig(g.window)));
  const rt = GenClass.init(init);
  const dt = devtoolsOptions(devtools, g.location);
  if (dt && !isKilled(g)) {
    whenBody(doc, () => {
      import("../devtools/index.js").then(
        (m) => m.mountDevtools(rt, dt),
        (e: unknown) => g.console?.warn?.("[GenClass] Could not load the devtools overlay:", e),
      );
    });
  }
  return rt;
}
