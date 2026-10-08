// Endpoint signatures of a ServerSpec (both sides: the harness picks chaos targets from them, the in-page server
// matches requests against them).

import type { ServerSpec } from "./types.js";

export type EndpointKind = "read" | "write" | "auth" | "bulk";

export interface Endpoint {
  method: string;
  /** Path pattern with :params, e.g. "/api/products/:id". */
  pattern: string;
  sig: string;
  kind: EndpointKind;
  idempotent: boolean;
}

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

export function endpointsOf(spec: ServerSpec): Endpoint[] {
  const out: Endpoint[] = [];
  const add = (method: string, pattern: string, kind: EndpointKind) => out.push({ method, pattern, sig: `${method} ${pattern}`, kind, idempotent: IDEMPOTENT.has(method) });
  const B = spec.base.replace(/\/$/, "");
  for (const c of spec.collections) {
    const p = `${B}/${c.path ?? c.name}`;
    add("GET", p, "read");
    add("POST", p, "write");
    add("POST", `${p}/bulk`, "bulk");
    add("GET", `${p}/:id`, "read");
    add("PUT", `${p}/:id`, "write");
    add("PATCH", `${p}/:id`, "write");
    add("DELETE", `${p}/:id`, "write");
    for (const verb of Object.keys(c.actions ?? {})) add("POST", `${p}/:id/${verb}`, "write");
  }
  for (const d of spec.docs ?? []) {
    add("GET", `${B}/docs/${d.name}`, "read");
    add("PUT", `${B}/docs/${d.name}`, "write");
    add("PATCH", `${B}/docs/${d.name}`, "write");
  }
  for (const c of spec.counters ?? []) {
    add("GET", `${B}/counters/${c.name}`, "read");
    add("POST", `${B}/counters/${c.name}/incr`, "write");
    add("PUT", `${B}/counters/${c.name}`, "write");
  }
  if (spec.auth) {
    add("POST", `${B}/auth/login`, "auth");
    add("POST", `${B}/auth/refresh`, "auth");
    add("GET", `${B}/auth/me`, "read");
  }
  if (spec.cart) add("GET", `${B}/${spec.cart.collection}/summary`, "read");
  if (spec.ext?.includes("conduit")) {
    for (const [m, p, k] of CONDUIT_ROUTES) add(m, `${B}${p}`, k);
  }
  // more specific patterns first (static segments beat params)
  out.sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
  return out;
}

function specificity(p: string): number {
  const segs = p.split("/").filter(Boolean);
  return segs.length * 10 + segs.filter((s) => !s.startsWith(":")).length;
}

export const CONDUIT_ROUTES: [string, string, EndpointKind][] = [
  ["POST", "/users/login", "auth"],
  ["POST", "/users", "auth"],
  ["GET", "/user", "read"],
  ["PUT", "/user", "write"],
  ["GET", "/profiles/:username", "read"],
  ["POST", "/profiles/:username/follow", "write"],
  ["DELETE", "/profiles/:username/follow", "write"],
  ["GET", "/articles", "read"],
  ["GET", "/articles/feed", "read"],
  ["GET", "/articles/:slug", "read"],
  ["POST", "/articles", "write"],
  ["PUT", "/articles/:slug", "write"],
  ["DELETE", "/articles/:slug", "write"],
  ["GET", "/articles/:slug/comments", "read"],
  ["POST", "/articles/:slug/comments", "write"],
  ["DELETE", "/articles/:slug/comments/:id", "write"],
  ["POST", "/articles/:slug/favorite", "write"],
  ["DELETE", "/articles/:slug/favorite", "write"],
  ["GET", "/tags", "read"],
];

/** Match a path against the endpoints: the endpoint and its params. */
export function matchEndpoint(eps: Endpoint[], method: string, path: string): { ep: Endpoint; params: Record<string, string> } | null {
  const segs = path.split("/").filter(Boolean);
  for (const ep of eps) {
    if (ep.method !== method) continue;
    const ps = ep.pattern.split("/").filter(Boolean);
    if (ps.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      const s = segs[i]!;
      if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(s);
      else if (p !== s) {
        ok = false;
        break;
      }
    }
    if (ok) return { ep, params };
  }
  return null;
}
