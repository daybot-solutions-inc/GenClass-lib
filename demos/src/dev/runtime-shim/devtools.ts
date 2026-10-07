// Development stand-in for @genclass/runtime/devtools (see index.ts): no overlay.
import type { Runtime } from "../../../../packages/runtime/src/types.ts";

export function mountDevtools(_runtime: Runtime, _opts?: Record<string, unknown>): () => void {
  return () => {};
}
