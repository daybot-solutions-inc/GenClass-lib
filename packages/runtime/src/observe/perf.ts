// Performance observer: long tasks (where supported) become `perf` events.

export function installPerf(g: Record<string, unknown>, cb: (name: string, duration: number) => void): (() => void) | null {
  const PO = g.PerformanceObserver as (new (fn: (list: { getEntries(): { duration: number }[] }) => void) => PerformanceObserver) | undefined;
  if (typeof PO !== "function") return null;
  const supported = (PO as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes;
  if (supported && !supported.includes("longtask")) return null;
  let obs: PerformanceObserver;
  try {
    obs = new PO((list) => {
      for (const e of list.getEntries()) cb("long task", e.duration);
    });
    obs.observe({ type: "longtask", buffered: false } as PerformanceObserverInit);
  } catch {
    return null;
  }
  return () => obs.disconnect();
}
