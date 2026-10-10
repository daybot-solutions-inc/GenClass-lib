// @genclass/runtime/discover: automatic state discovery (InitOptions.autoState) for GenClass.init() setups. The
// zero-code entries (`@genclass/runtime/auto*`, the script tag) include it already.
//
//   import "@genclass/runtime/discover";            // first, before React / Redux / Zustand are imported
//   import { GenClass } from "@genclass/runtime";
//   ...
//   GenClass.init({ autoState: true });             // may run later, after the framework loaded (but before it renders)
//
// Evaluating this module installs the React DevTools hook and the Redux DevTools shims right away, in a browser (not
// with the `?genclass=off` kill switch); they record nothing and pass everything through until a runtime with
// `autoState` attaches. Redux stores created before that are observed only (no holds or drops on them).

import { registerDiscovery } from "./index.js";

registerDiscovery({ early: true });

export { registerDiscovery };
export type { AutoStateOptions, StoreInfo } from "../types.js";
