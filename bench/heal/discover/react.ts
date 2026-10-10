// bench/heal discovery build: useGenClassState is plain React state (not registered with GenClass); the rest of the
// React bindings are the real ones.
import { useState } from "react";

export * from "@genclass-real/runtime/react";

export function useGenClassState<T>(_name: string, initial: T | (() => T), _opts?: unknown): [T, (next: T | ((prev: T) => T)) => void] {
  return useState<T>(initial);
}
