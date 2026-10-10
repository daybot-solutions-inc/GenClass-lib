// protect(): the function-specific way to use GenClass (InitOptions.scope "functions").
//
//   import { GenClass, protect } from "@genclass/runtime";
//   GenClass.init({ token: "gc_...", scope: "functions" });
//   export const submitOrder = protect("checkout submit", async (cart) => { ... });
//
// Each call runs inside a "task" op named `name` (like runtime.op), so the fetches, state writes, timers and errors
// it causes are attributed to it, and decisions about them carry `fn: name`. Invariants:
// - Safe at module-import time: the runtime is looked up on every call (GenClass.runtime). No runtime: fn is called
//   directly (one check of overhead).
// - Same signature: `this`, arguments, return value and thrown errors pass through; sync stays sync. An async
//   function's promise is replaced by one that settles the same way (as runtime.op does). Other thenables are
//   returned as they are.
// - Never throws on its own (a missing name: a console warning and fn.name is used; not a function: a warning and
//   the value is returned unchanged).

import type { RuntimeImpl } from "./runtime.js";

let resolve: () => RuntimeImpl | null = () => null;

/** Where protect() finds the runtime (src/index.ts: GenClass.runtime). Internal; tests point it at their runtime. */
export function setProtectResolver(fn: () => RuntimeImpl | null): void {
  resolve = fn;
}

const MAX_NAME = 80;

function warn(msg: string): void {
  try {
    (globalThis as { console?: Console }).console?.warn?.(`[GenClass] ${msg}`);
  } catch {
    /* ignore */
  }
}

/**
 * Wrap `fn` so each call is tracked as the protected function `name`. Returns a function with the same signature.
 * Decisions about what the call causes (duplicate submits, overlapping or out-of-order calls, failures) are reported
 * under `name`; with `GenClass.init({ scope: "functions" })` only those are decided.
 */
export function protect<F extends (...args: never[]) => unknown>(name: string, fn: F): F {
  if (typeof fn !== "function") {
    warn(`protect(${JSON.stringify(String(name))}) needs a function; got ${fn === null ? "null" : typeof fn}.`);
    return fn;
  }
  let label = typeof name === "string" ? name.trim() : "";
  if (!label) {
    label = fn.name || "anonymous";
    warn(`protect() needs a name; using ${JSON.stringify(label)}.`);
  }
  if (label.length > MAX_NAME) label = label.slice(0, MAX_NAME);
  const call = fn as unknown as (...a: unknown[]) => unknown;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    let rt: RuntimeImpl | null = null;
    try {
      rt = resolve();
    } catch {
      rt = null;
    }
    if (!rt || typeof rt.runProtected !== "function") return call.apply(this, args);
    return rt.runProtected(label, call, this, args);
  };
  try {
    Object.defineProperty(wrapped, "name", { value: fn.name, configurable: true });
    Object.defineProperty(wrapped, "length", { value: fn.length, configurable: true });
  } catch {
    /* cosmetic only */
  }
  return wrapped as unknown as F;
}
