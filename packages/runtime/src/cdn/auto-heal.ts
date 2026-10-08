// @genclass/runtime/auto/heal: `import "@genclass/runtime/auto";` in heal mode (page config and ?genclass= still win).
import { GenClass } from "../index.js";
import type { Runtime } from "../types.js";
import { startAuto } from "./auto-start.js";

const runtime: Runtime = startAuto({ mode: "heal" });

export { GenClass };
export default runtime;
