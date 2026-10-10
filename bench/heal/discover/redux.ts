// bench/heal discovery build: instead of GenClass's enhancer, what a plain Redux app passes to createStore: the Redux
// DevTools enhancer when the page has one (`window.__REDUX_DEVTOOLS_EXTENSION__`), named like the store.
export const GENCLASS_REPLACE = "@@genclass/REPLACE";

export function genclassEnhancer(_runtime: unknown, o: { name: string }): (next: unknown) => unknown {
  const ext = (globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: (o: unknown) => (next: unknown) => unknown }).__REDUX_DEVTOOLS_EXTENSION__;
  return ext ? ext({ name: o.name }) : (next) => next;
}
