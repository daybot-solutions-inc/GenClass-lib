// @genclass/runtime/auto/guard: `import "@genclass/runtime/auto";` in guard mode (page config and ?genclass= still win).
import { GenClass } from "../index.js";
import type { Runtime } from "../types.js";
import { startAuto } from "./auto-start.js";

const runtime: Runtime = startAuto({ mode: "guard" });

export { GenClass };
export default runtime;
