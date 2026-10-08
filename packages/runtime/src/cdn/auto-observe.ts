// @genclass/runtime/auto/observe: `import "@genclass/runtime/auto";` in observe mode (page config and ?genclass= still win).
import { GenClass } from "../index.js";
import type { Runtime } from "../types.js";
import { startAuto } from "./auto-start.js";

const runtime: Runtime = startAuto({ mode: "observe" });

export { GenClass };
export default runtime;
