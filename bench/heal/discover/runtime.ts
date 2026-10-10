// bench/heal discovery build (GENCLASS_DISCOVER=1, demos/vite.config.ts): @genclass/runtime with autoState on, as
// `import "@genclass/runtime/auto"` would give. Everything else is the real package.
import { GenClass as Real } from "@genclass-real/runtime";
import type { InitOptions, Runtime } from "@genclass-real/runtime";

export * from "@genclass-real/runtime";

export const GenClass = {
  init(o: InitOptions = {}): Runtime {
    return Real.init({ ...o, autoState: true });
  },
  get runtime(): Runtime | null {
    return Real.runtime;
  },
  destroy(): void {
    Real.destroy();
  },
};
export default GenClass;
