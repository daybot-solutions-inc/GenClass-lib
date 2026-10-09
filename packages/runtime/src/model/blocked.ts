// Why the model could not load, when the reason is that the browser never let a download through: a
// Content-Security-Policy (connect-src / worker-src), an extension or the network. The model host collects the page's
// and the worker's `securitypolicyviolation` events while it loads and runs blockedFetch() on the final load error,
// so the runtime can print one warning that names the blocked origin and the fix instead of a bare "Failed to fetch".

/** A download the browser blocked (ModelStatus.blocked). */
export interface BlockedFetch {
  /** The URL that was blocked (from the CSP violation, else from the load error). */
  url: string;
  /** Its origin ("https://cdn.jsdelivr.net"). */
  origin: string;
  /** true when a securitypolicyviolation event confirmed a CSP block; false when it only looks like one. */
  csp: boolean;
  /** The violated CSP directive, when known ("connect-src"). */
  directive?: string;
}

/** What the host keeps of a securitypolicyviolation event. */
export interface CspViolation {
  blockedURI: string;
  directive: string;
}

/** What browsers say when fetch() never got a response: Chromium, Firefox, Safari (and a CSP block). */
const NETWORK_RE = /Failed to fetch|NetworkError|(?<!\w)Load failed|[Nn]etwork error|Content Security Policy|violates the following/;
const URL_RE = /https?:\/\/[^\s'"<>]+?(?=:\s|[\s'"<>,;)]|$)/g;

function originOf(u: string, base?: string): string | null {
  try {
    const o = new URL(u, base).origin;
    return o && o !== "null" ? o : null;
  } catch {
    return null;
  }
}

/** Keeps the fields we use; ignores events about inline code (blockedURI "inline", "eval", ...). */
export function violationOf(ev: unknown): CspViolation | null {
  const e = ev as { blockedURI?: unknown; effectiveDirective?: unknown; violatedDirective?: unknown } | null;
  const uri = typeof e?.blockedURI === "string" ? e.blockedURI : "";
  if (!/^https?:/i.test(uri)) return null;
  const d = typeof e?.effectiveDirective === "string" && e.effectiveDirective ? e.effectiveDirective : typeof e?.violatedDirective === "string" ? e.violatedDirective : "";
  return { blockedURI: uri, directive: d.split(/\s/)[0] ?? "" };
}

/**
 * The blocked download behind a load error, or null when the error is something else (an HTTP status, a bad
 * checksum, a WebGPU failure, a same-origin URL that failed). A CSP violation whose origin appears in the error (or
 * any violation, when the error names no URL) wins; otherwise a network-type error on a cross-origin URL counts as
 * a probable block.
 */
export function blockedFetch(error: string | undefined, violations: readonly CspViolation[], pageOrigin?: string | null): BlockedFetch | null {
  const msg = String(error ?? "");
  const urls = msg.match(URL_RE) ?? [];
  const origins = new Set(urls.map((u) => originOf(u)).filter((o): o is string => !!o));
  const vs = violations.filter((v) => !!originOf(v.blockedURI) && originOf(v.blockedURI) !== pageOrigin);
  const v = vs.find((x) => origins.has(originOf(x.blockedURI)!)) ?? (origins.size === 0 || NETWORK_RE.test(msg) ? vs[0] : undefined);
  if (v) return { url: v.blockedURI, origin: originOf(v.blockedURI)!, csp: true, ...(v.directive ? { directive: v.directive } : {}) };
  if (!NETWORK_RE.test(msg)) return null;
  // the URL the network error was about: the one right before it ("... failed for <url>: Failed to fetch")
  const at = msg.search(NETWORK_RE);
  const before = urls.filter((u) => msg.indexOf(u) < at);
  const url = before[before.length - 1] ?? urls[0];
  const origin = url ? originOf(url) : null;
  if (!url || !origin || origin === pageOrigin) return null;
  return { url, origin, csp: false };
}

/** The one warning the runtime prints for a blocked model download. */
export function blockedMessage(b: BlockedFetch): string {
  const why = b.csp
    ? `was blocked by this page's Content-Security-Policy${b.directive ? ` (${b.directive})` : ""}`
    : "could not be fetched (most likely a Content-Security-Policy connect-src without it; an extension or the network can also block it)";
  return (
    `The model could not load: ${b.origin} ${why}. GenClass keeps running without a model (observing only). ` +
    `Fix: self-host the model and ONNX Runtime files (npx @genclass/runtime fetch-model public/genclass-model, then ` +
    `GenClass.init({ model: { baseUrl: "/genclass-model/", ortWasmPaths: "/genclass-model/ort/" } })), or allow ${b.origin} in the CSP's connect-src. ` +
    `Blocked: ${b.url}`
  );
}
