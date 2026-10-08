// @genclass/runtime/auto: zero-code setup. Owner: INSTALL.
//
//   import "@genclass/runtime/auto";                 // first import of your entry file: GenClass.init() with defaults
//   import genclass from "@genclass/runtime/auto";   // the same, and the runtime it started (genclass.atom(...))
//   import "@genclass/runtime/auto/observe";         // ... in observe mode (also /auto/guard, /auto/heal)
//
// It initialises while your entry's imports are still being evaluated (put it first), so stores created at import
// time already see GenClass.runtime. Optional configuration, read once:
//   <meta name="genclass" content="mode=observe, devtools=local">
//   window.GENCLASS_CONFIG = { mode: "observe", devtools: true };   // set before this module runs; any InitOptions
//
// The URL kill switch (`?genclass=off|observe|guard|heal`, `localStorage.genclass`) works as with GenClass.init().
// Outside a browser (SSR, Node, workers) nothing is read or installed: the default export is GenClass.init()'s
// inert runtime (no observers, no model).

import { startAuto } from "./cdn/auto-start.js";
import { GenClass } from "./index.js";
import type { Runtime } from "./types.js";

const runtime: Runtime = startAuto();

export { GenClass };
export default runtime;
