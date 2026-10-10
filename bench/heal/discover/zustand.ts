// bench/heal discovery build: instead of GenClass's middleware, what a plain Zustand app uses: zustand's devtools()
// (default options: off in a production Vite build, as in a real app).
import { devtools } from "zustand/middleware";

export function genclass(_runtime: unknown, name: string, _opts?: unknown) {
  return (creator: unknown) => (devtools as unknown as (c: unknown, o: unknown) => unknown)(creator, { name });
}
