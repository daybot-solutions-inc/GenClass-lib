// Errors observer: uncaught errors and unhandled promise rejections become `error` triggers.

interface ErrorSink {
  reportError(error: unknown, info?: { source?: string }): void;
}

export function installErrors(g: Record<string, unknown>, sink: ErrorSink): (() => void) | null {
  const t = g as unknown as EventTarget;
  if (typeof t.addEventListener !== "function") return null;
  const onError = (e: Event) => {
    const ev = e as ErrorEvent;
    if (typeof ev.message !== "string" && !ev.error) return; // resource load errors
    const source = ev.filename ? `${ev.filename.split("/").pop()}:${ev.lineno ?? 0}` : undefined;
    sink.reportError(ev.error ?? ev.message, source ? { source } : {});
  };
  const onRejection = (e: Event) => {
    sink.reportError((e as PromiseRejectionEvent).reason, { source: "unhandledrejection" });
  };
  t.addEventListener("error", onError);
  t.addEventListener("unhandledrejection", onRejection);
  return () => {
    t.removeEventListener("error", onError);
    t.removeEventListener("unhandledrejection", onRejection);
  };
}
