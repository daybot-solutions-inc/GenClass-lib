// Per-program naming: route prefixes and casing, store names, field-name synonyms, UI labels. Two programs from
// the same domain and feature set still look different to the runtime (store paths, signatures, labels).

import type { Rng } from "../rng.js";

export type Casing = "camel" | "snake" | "kebab";

const SYN: Record<string, string[]> = {
  list: ["items", "results", "rows", "list", "entries", "records", "data", "hits"],
  loading: ["loading", "isLoading", "pending", "busy", "fetching", "inFlight"],
  error: ["error", "errorMessage", "lastError", "err", "failure", "problem"],
  query: ["query", "q", "term", "searchText", "text", "keyword"],
  total: ["total", "count", "totalCount", "numResults", "size", "matches"],
  saving: ["saving", "isSaving", "syncing", "pendingSave", "writing"],
  saved: ["saved", "isSaved", "synced", "upToDate", "clean", "persisted"],
  savedAt: ["savedAt", "lastSaved", "syncedAt", "lastSync"],
  selected: ["selected", "current", "active", "focused", "detail", "open"],
  version: ["version", "rev", "revision", "etag"],
  status: ["status", "state", "phase", "health"],
  updated: ["updatedAt", "lastUpdated", "refreshedAt", "asOf", "fetchedAt"],
  page: ["page", "pageIndex", "cursor", "offset"],
  hasMore: ["hasMore", "more", "hasNext", "canLoadMore"],
  sum: ["total", "sum", "grandTotal", "amountDue", "subtotal"],
  qty: ["qty", "quantity", "count", "units", "n"],
  draft: ["draft", "form", "input", "values", "fields"],
  submitting: ["submitting", "isSubmitting", "sending", "placing", "posting"],
  messages: ["messages", "log", "feed", "entries", "history"],
  unread: ["unread", "unreadCount", "badge", "newCount"],
  filter: ["filter", "filters", "facet", "view"],
  sort: ["sort", "sortBy", "order", "orderBy"],
  metrics: ["metrics", "stats", "kpis", "numbers", "gauges"],
  token: ["session", "auth", "credentials", "login"],
  selection: ["selection", "selectedIds", "checked", "picked"],
  value: ["value", "values", "prefs", "settings", "options"],
};

export function camel(words: string[]): string {
  return words
    .map((w, i) => {
      const c = w.replace(/[^A-Za-z0-9]/g, "");
      return i === 0 ? c.charAt(0).toLowerCase() + c.slice(1) : c.charAt(0).toUpperCase() + c.slice(1);
    })
    .join("");
}

export function splitWords(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function cased(s: string, c: Casing): string {
  const w = splitWords(s);
  if (c === "camel") return camel(w);
  if (c === "snake") return w.join("_");
  return w.join("-");
}

export function title(s: string): string {
  const w = splitWords(s);
  return w.map((x, i) => (i === 0 ? x.charAt(0).toUpperCase() + x.slice(1) : x)).join(" ");
}

export class Naming {
  readonly routeCase: Casing;
  readonly prefix: string;
  readonly storeCase: "camel" | "snake";
  readonly fieldCase: "camel" | "snake";
  private used = new Set<string>();
  private fieldPick = new Map<string, string>();

  constructor(private readonly rng: Rng, appSlug: string) {
    this.routeCase = rng.weighted([["kebab", 5], ["snake", 2], ["camel", 1]] as const);
    this.prefix = rng.weighted([
      ["/api", 5],
      ["/api/v1", 3],
      ["/api/v2", 1],
      ["/v1", 2],
      ["/rest", 1],
      [`/svc/${cased(appSlug, "kebab")}`, 1],
      ["", 1],
    ] as const);
    this.storeCase = rng.bool(0.8) ? "camel" : "snake";
    this.fieldCase = rng.bool(0.82) ? "camel" : "snake";
  }

  /** A field name for a role, consistent within the program (e.g. always "items" for lists). */
  field(role: keyof typeof SYN | string, scope = ""): string {
    const k = `${role}|${scope}`;
    const prev = this.fieldPick.get(k);
    if (prev) return prev;
    const opts = SYN[role] ?? [role];
    const pick = this.rng.pick(opts);
    const out = this.fieldCase === "snake" ? cased(pick, "snake") : pick;
    this.fieldPick.set(k, out);
    return out;
  }

  /** A raw field word (domain-specific), cased. */
  word(s: string): string {
    return this.fieldCase === "snake" ? cased(s, "snake") : cased(s, "camel");
  }

  /** Unique store name from words. */
  store(...words: string[]): string {
    let base = this.storeCase === "snake" ? cased(words.join(" "), "snake") : camel(words.flatMap(splitWords));
    if (!base) base = "store";
    let name = base;
    let i = 2;
    while (this.used.has(name)) name = `${base}${this.storeCase === "snake" ? "_" : ""}${i++}`;
    this.used.add(name);
    return name;
  }

  /** Feature currently being built (set by the scenario builder): routes are unique per owner. */
  owner = "";
  private routeOwner = new Map<string, string>();
  private static readonly SCOPES = ["shop", "admin", "team", "my", "app", "store", "hub", "desk"];

  /** Route path from segments; segments starting with ':' are kept as params. Paths never collide across features. */
  route(...segs: string[]): string {
    const parts = segs.filter((x) => x !== "").map((s) => (s.startsWith(":") ? s : cased(s, this.routeCase)));
    let path = `${this.prefix}/${parts.join("/")}`;
    const key = (p: string) => p.replace(/:[^/]+/g, ":");
    // Any route whose shape could match another feature's route (same length, params anywhere) gets a scope.
    const clash = (p: string) => {
      const k = key(p).split("/");
      for (const [other, owner] of this.routeOwner) {
        if (owner === this.owner) continue;
        const o = other.split("/");
        if (o.length !== k.length) continue;
        if (o.every((seg, i) => seg === k[i] || seg === ":" || k[i] === ":")) return true;
      }
      return false;
    };
    let i = 0;
    while (clash(path) && i < 16) {
      const scope = Naming.SCOPES[(hashLite(this.owner) + i) % Naming.SCOPES.length]!;
      path = `${this.prefix}/${cased(scope, this.routeCase)}${i >= Naming.SCOPES.length ? i : ""}/${parts.join("/")}`;
      i++;
    }
    this.routeOwner.set(key(path), this.owner);
    return path;
  }
}

function hashLite(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
