// useReducer backed by a GenClass atom: the same contract as React's useReducer, but the state lives in the runtime
// atom `name` (useGenClassState), so every dispatch is traced and async dispatches go through GenClass's pipeline.
import { useCallback } from "react";
import { useGenClassState } from "@genclass/runtime/react";

export function useGenClassReducer<S, A>(name: string, reducer: (s: S, a: A) => S, initial: S): [S, (a: A) => void] {
  const [state, setState] = useGenClassState<S>(name, initial);
  const dispatch = useCallback((a: A) => setState((s) => reducer(s, a)), [setState, reducer]);
  return [state, dispatch];
}
