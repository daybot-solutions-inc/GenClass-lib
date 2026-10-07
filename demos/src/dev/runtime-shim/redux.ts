// Development stand-in for @genclass/runtime/redux (see index.ts): an identity store enhancer.
import type { Runtime } from "../../../../packages/runtime/src/types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function genclassEnhancer(_runtime: Runtime, _opts: { name: string }): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (createStore: any) => (reducer: any, preloaded?: any) => createStore(reducer, preloaded);
}
