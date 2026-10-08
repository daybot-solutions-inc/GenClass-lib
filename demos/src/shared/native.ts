// Native timers, captured when this module loads (before GenClass.init wraps the globals). Test code (oracles,
// the trial harness, the synthetic driver, the server link) uses these so it never shows up in GenClass's view of
// the app: no "interval 0.05s" ops in its timeline, and no test timer ever becomes the cause of an app write.
// App code keeps using the normal globals, which GenClass observes as usual.
const g = globalThis as typeof globalThis;

export const nativeSetTimeout: typeof setTimeout = g.setTimeout.bind(g);
export const nativeClearTimeout: typeof clearTimeout = g.clearTimeout.bind(g);
export const nativeSetInterval: typeof setInterval = g.setInterval.bind(g);
export const nativeClearInterval: typeof clearInterval = g.clearInterval.bind(g);

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => nativeSetTimeout(r, Math.max(0, ms)));
}
