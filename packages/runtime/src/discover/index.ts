// @genclass/runtime/discover: registers automatic state discovery (InitOptions.autoState) for GenClass.init() setups.
// The zero-code entries (`@genclass/runtime/auto*`, the script tag) include it already.
//
//   import "@genclass/runtime/discover";            // first, before React / Redux / Zustand are imported
//   GenClass.init({ autoState: true });

import { installReactDiscovery } from "./react.js";
import { installReduxDiscovery } from "./redux.js";
import { discoveryRegistry } from "./registry.js";

/** Make InitOptions.autoState work (called by the zero-code entries; a named import, so no bundler drops it). */
export function registerDiscovery(): void {
  discoveryRegistry.installers ??= { react: installReactDiscovery, redux: installReduxDiscovery };
}

registerDiscovery();

export type { AutoStateOptions, StoreInfo } from "../types.js";
