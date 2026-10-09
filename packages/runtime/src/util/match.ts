// Request and route matchers (OPTIONS-SPEC §3). A string containing `*` is a glob over the absolute URL (or over the
// path when it starts with "/"); any other string is a prefix, matched against the absolute URL and, when it starts
// with "/", also against the path. RegExps are used as given. Predicates run in try/catch: `onThrow` says whether a
// throw counts as a match (protect) or not (ignore, labels, routes). Results are cached (LRU, 256 entries).

export type Channel = "fetch" | "xhr" | "ws" | "sse";
export interface MatchInput {
  url: string;
  method: string;
  channel: Channel;
}
export type RequestMatcherLike = string | RegExp | ((r: MatchInput) => boolean);

function globRe(g: string): RegExp {
  return new RegExp("^" + g.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}

function pathOf(url: string): string {
  try {
    const u = new URL(url, "http://x.invalid/");
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

type Test = (r: MatchInput, path: string) => boolean;

function compileOne(m: RequestMatcherLike, onThrow: "match" | "nomatch"): Test | null {
  if (typeof m === "string") {
    if (!m) return null;
    if (m.includes("*")) {
      const re = globRe(m);
      return (r, path) => re.test(r.url) || (m.startsWith("/") && re.test(path));
    }
    return (r, path) => r.url.startsWith(m) || (m.startsWith("/") && path.startsWith(m));
  }
  if (m instanceof RegExp) return (r, path) => { m.lastIndex = 0; const a = m.test(r.url); m.lastIndex = 0; return a || m.test(path); };
  if (typeof m === "function")
    return (r) => {
      try {
        return !!m(r);
      } catch {
        return onThrow === "match";
      }
    };
  return null;
}

export interface CompiledMatcher<T = true> {
  /** The first matching entry's value, or undefined. */
  match(r: MatchInput): T | undefined;
  readonly size: number;
  /** Cache hits (tests). */
  hits: number;
}

export function compileMatchers(list: RequestMatcherLike[] | undefined, onThrow: "match" | "nomatch"): CompiledMatcher<true> {
  return compileValued((list ?? []).map((m) => ({ match: m, value: true as const })), onThrow);
}

export function compileValued<T>(list: { match: RequestMatcherLike; value: T }[] | undefined, onThrow: "match" | "nomatch"): CompiledMatcher<T> {
  const tests: { t: Test; v: T }[] = [];
  for (const e of list ?? []) {
    const t = compileOne(e.match, onThrow);
    if (t) tests.push({ t, v: e.value });
  }
  const cache = new Map<string, { v: T | undefined }>();
  const out: CompiledMatcher<T> = {
    size: tests.length,
    hits: 0,
    match(r) {
      if (!tests.length) return undefined;
      const key = `${r.channel} ${String(r.method ?? "GET").toUpperCase()} ${r.url}`;
      const c = cache.get(key);
      if (c) {
        out.hits++;
        cache.delete(key);
        cache.set(key, c);
        return c.v;
      }
      const path = pathOf(r.url);
      let v: T | undefined;
      for (const x of tests)
        if (x.t(r, path)) {
          v = x.v;
          break;
        }
      cache.set(key, { v });
      if (cache.size > 256) cache.delete(cache.keys().next().value!);
      return v;
    },
  };
  return out;
}

/** Route matching: exact path or glob string, RegExp, or predicate (a throw is no match). */
export function routeMatches(m: string | RegExp | ((route: string) => boolean), route: string): boolean {
  try {
    if (typeof m === "string") return m.includes("*") ? globRe(m).test(route) : m === route;
    if (m instanceof RegExp) {
      m.lastIndex = 0;
      return m.test(route);
    }
    if (typeof m === "function") return !!m(route);
  } catch {
    return false;
  }
  return false;
}

/** Labels: names only. [A-Za-z0-9 _-], ≤ 5 words, ≤ 40 chars. */
export function sanitizeLabel(s: string): { label: string; changed: boolean } {
  const cleaned = String(s).replace(/[^A-Za-z0-9 _-]+/g, " ").replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean).slice(0, 5).join(" ").slice(0, 40).trim();
  return { label: words, changed: words !== s };
}

/** FNV-1a 32-bit of a string as an unsigned number (sample buckets, sink sampling). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
