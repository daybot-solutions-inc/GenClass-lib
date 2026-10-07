// Development stand-in for @genclass/runtime/zustand (see index.ts): an identity middleware.
import type { Runtime } from "../../../../packages/runtime/src/types.ts";

export function genclass(_runtime: Runtime, _name: string, _opts?: { resync?: () => unknown }) {
  return <F>(stateCreator: F): F => stateCreator;
}
