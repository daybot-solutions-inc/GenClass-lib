// Virtual server: resources (collections, versioned documents, counters, key-value settings, sessions) and routed
// endpoints with realistic semantics. Handlers run synchronously at the virtual instant the request reaches the
// server; latency/failures are applied by the network layer (net/network.ts).
//
// Item ids are content-derived: id = f(collection, canonical create body, how many identical bodies were created
// before). The same intent therefore gets the same id in the ideal run and in every counterfactual run, while a
// duplicate create gets a fresh id (it is a real extra item). This keeps state comparison across runs exact.

import { hashAll } from "../rng.js";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Item = Record<string, Json>;

export interface ServerRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Map<string, string>;
  body: unknown;
  rawBody: string;
  t: number;
  identity: string;
  params: Record<string, string>;
}

export interface ServerResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Server-side outcome note for the sim's knowledge (never sent). */
  note?: string;
}

export type Handler = (req: ServerRequest) => ServerResponse;

export interface RouteMeta {
  /** Feature that owns the endpoint. */
  feature: string;
  /** Endpoint kind for latency defaults and labels: read | write | auth | upload | bulk | push. */
  kind: "read" | "write" | "auth" | "upload" | "bulk";
  idempotent: boolean;
  /** Resource keys the handler reads/writes, for replica-lag modelling. */
  resource?: string;
}

interface Route {
  method: string;
  segs: string[];
  signature: string;
  handler: Handler;
  meta: RouteMeta;
}

export type IdStyle = "num" | "uuid" | "prefixed" | "slug";

export interface Collection {
  name: string;
  items: Map<string, Item>;
  order: string[];
  createCount: Map<string, number>;
  prefix: string;
}

export interface Doc {
  id: string;
  version: number;
  fields: Item;
}

export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const keys = Object.keys(v as object).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
}

export function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

const HEX = "0123456789abcdef";

export class Db {
  collections = new Map<string, Collection>();
  docs = new Map<string, Doc>();
  counters = new Map<string, number>();
  kv = new Map<string, Json>();
  /** Write history per resource key for replica lag: [t, snapshot-before]. */
  history = new Map<string, { t: number; before: string }[]>();
  idStyle: IdStyle;
  salt: string;

  constructor(idStyle: IdStyle, salt: string) {
    this.idStyle = idStyle;
    this.salt = salt;
  }

  collection(name: string, prefix = name.slice(0, 3)): Collection {
    let c = this.collections.get(name);
    if (!c) {
      c = { name, items: new Map(), order: [], createCount: new Map(), prefix };
      this.collections.set(name, c);
    }
    return c;
  }

  makeId(c: Collection, key: string): string {
    const n = c.createCount.get(key) ?? 0;
    c.createCount.set(key, n + 1);
    let salt = 0;
    for (;;) {
      const h = hashAll(this.salt, c.name, key, n, salt);
      let id: string;
      switch (this.idStyle) {
        case "num":
          id = String(1000 + (h % 899000));
          break;
        case "uuid": {
          let s = "";
          let x = h;
          for (let i = 0; i < 32; i++) {
            s += HEX[x & 15];
            x = i % 7 === 6 ? hashAll(h, i) : x >>> 4;
          }
          id = `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
          break;
        }
        case "prefixed":
          id = `${c.prefix}_${h.toString(36).padStart(7, "0").slice(0, 7)}`;
          break;
        default:
          id = `${c.prefix}-${(h % 46656).toString(36)}${(hashAll(h, 1) % 1296).toString(36)}`;
      }
      if (!c.items.has(id)) return id;
      salt++;
    }
  }

  /** Insert an item. `key` identifies the create intent (canonical body) for content-derived ids. */
  insert(cname: string, fields: Item, key?: string, t = 0): Item {
    const c = this.collection(cname);
    const id = this.makeId(c, key ?? canonical(fields));
    const item: Item = { id, ...fields };
    if (!("version" in item)) item.version = 1;
    this.recordWrite(`c:${cname}`, t);
    c.items.set(id, item);
    c.order.push(id);
    return item;
  }

  get(cname: string, id: string): Item | undefined {
    return this.collection(cname).items.get(id);
  }

  list(cname: string): Item[] {
    const c = this.collection(cname);
    const out: Item[] = [];
    for (const id of c.order) {
      const it = c.items.get(id);
      if (it) out.push(it);
    }
    return out;
  }

  update(cname: string, id: string, patch: Item, t = 0): Item | undefined {
    const c = this.collection(cname);
    const it = c.items.get(id);
    if (!it) return undefined;
    this.recordWrite(`c:${cname}`, t);
    const next: Item = { ...it, ...patch, id, version: (Number(it.version) || 0) + 1 };
    c.items.set(id, next);
    return next;
  }

  remove(cname: string, id: string, t = 0): boolean {
    const c = this.collection(cname);
    if (!c.items.has(id)) return false;
    this.recordWrite(`c:${cname}`, t);
    c.items.delete(id);
    c.order = c.order.filter((x) => x !== id);
    return true;
  }

  doc(name: string, init?: Item): Doc {
    let d = this.docs.get(name);
    if (!d) {
      d = { id: name, version: 1, fields: init ? clone(init) : {} };
      this.docs.set(name, d);
    }
    return d;
  }

  writeDoc(name: string, fields: Item, t = 0): Doc {
    const d = this.doc(name);
    this.recordWrite(`d:${name}`, t);
    d.fields = { ...d.fields, ...clone(fields) };
    d.version += 1;
    return d;
  }

  counter(name: string, init = 0): number {
    if (!this.counters.has(name)) this.counters.set(name, init);
    return this.counters.get(name)!;
  }

  addCounter(name: string, delta: number, t = 0): number {
    this.recordWrite(`n:${name}`, t);
    const v = this.counter(name) + delta;
    this.counters.set(name, v);
    return v;
  }

  setCounter(name: string, v: number, t = 0): number {
    this.recordWrite(`n:${name}`, t);
    this.counters.set(name, v);
    return v;
  }

  /** Incremented on every write (server-state timeline). */
  writes = 0;

  private recordWrite(key: string, t: number): void {
    this.writes++;
    // Snapshot before the write so lagging replicas can serve the old value.
    const before = this.snapshotKey(key);
    let h = this.history.get(key);
    if (!h) {
      h = [];
      this.history.set(key, h);
    }
    h.push({ t, before });
    if (h.length > 64) h.shift();
  }

  snapshotKey(key: string): string {
    const [kind, name] = [key.slice(0, 1), key.slice(2)];
    if (kind === "c") return JSON.stringify(this.list(name));
    if (kind === "d") return JSON.stringify(this.docs.get(name) ?? null);
    return JSON.stringify(this.counters.get(name) ?? 0);
  }

  /** The value of a resource as a replica lagging by `lagMs` would see it at time t (JSON string). */
  laggedKey(key: string, t: number, lagMs: number): string | undefined {
    const h = this.history.get(key);
    if (!h || h.length === 0) return undefined;
    // Earliest write after (t - lag): the replica has the state before it.
    for (const w of h) if (w.t > t - lagMs && w.t <= t) return w.before;
    return undefined;
  }

  /** Full canonical server state (for final divergence). */
  snapshot(): ServerSnapshot {
    const collections: Record<string, Record<string, Item>> = {};
    for (const [name, c] of this.collections) {
      const m: Record<string, Item> = {};
      for (const id of c.order) {
        const it = c.items.get(id);
        if (it) m[id] = stripVolatile(it);
      }
      collections[name] = m;
    }
    const docs: Record<string, Item> = {};
    for (const [name, d] of this.docs) docs[name] = stripVolatile(d.fields);
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters) counters[k] = v;
    const kv: Record<string, Json> = {};
    for (const [k, v] of this.kv) kv[k] = v;
    return { collections, docs, counters, kv };
  }
}

export interface ServerSnapshot {
  collections: Record<string, Record<string, Item>>;
  docs: Record<string, Item>;
  counters: Record<string, number>;
  kv: Record<string, Json>;
}

const VOLATILE = new Set(["version", "updatedAt", "updated_at", "rev", "etag", "seq"]);
function stripVolatile(it: Item): Item {
  const o: Item = {};
  for (const [k, v] of Object.entries(it)) if (!VOLATILE.has(k)) o[k] = v;
  return o;
}

export interface ServerLogEntry {
  t: number;
  signature: string;
  method: string;
  identity: string;
  status: number;
  committed: boolean;
  feature: string;
  note?: string;
}

export class VirtualServer {
  readonly db: Db;
  private routes: Route[] = [];
  readonly log: ServerLogEntry[] = [];
  /** Responses remembered per Idempotency-Key. */
  private idem = new Map<string, ServerResponse>();
  /** Session tokens: token -> expiry time. */
  sessions = new Map<string, number>();
  /** Topic publishers (live channel); wired by the network layer. */
  publish: (topic: string, msg: unknown) => void = () => {};
  now: () => number = () => 0;

  constructor(db: Db) {
    this.db = db;
  }

  route(method: string, pattern: string, handler: Handler, meta: RouteMeta): string {
    const segs = pattern.split("/").filter(Boolean);
    const signature = `${method} /${segs.join("/")}`;
    this.routes.push({ method, segs, signature, handler, meta });
    return signature;
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = path.split("/").filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.segs.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const s = r.segs[i]!;
        const p = decodeURIComponent(parts[i]!);
        if (s.startsWith(":")) params[s.slice(1)] = p;
        else if (s !== p) {
          ok = false;
          break;
        }
      }
      if (ok) return { route: r, params };
    }
    return undefined;
  }

  meta(method: string, path: string): (RouteMeta & { signature: string }) | undefined {
    const m = this.match(method, path);
    return m ? { ...m.route.meta, signature: m.route.signature } : undefined;
  }

  /** Process a request now (side effects happen here). */
  handle(req: Omit<ServerRequest, "params">): { res: ServerResponse; signature: string; meta?: RouteMeta } {
    const m = this.match(req.method, req.path);
    if (!m) {
      const res = { status: 404, body: { error: "not_found" } };
      this.log.push({ t: req.t, signature: `${req.method} ${req.path}`, method: req.method, identity: req.identity, status: 404, committed: false, feature: "?" });
      return { res, signature: `${req.method} ${req.path}` };
    }
    const full: ServerRequest = { ...req, params: m.params };
    const key = req.headers.get("idempotency-key");
    let res: ServerResponse;
    let replayed = false;
    if (key && this.idem.has(`${m.route.signature}|${key}`)) {
      res = clone(this.idem.get(`${m.route.signature}|${key}`)!);
      replayed = true;
    } else {
      try {
        res = m.route.handler(full);
      } catch (e) {
        res = { status: 500, body: { error: "internal", message: String((e as Error)?.message ?? e) } };
      }
      if (key && res.status < 500) this.idem.set(`${m.route.signature}|${key}`, clone(res));
    }
    this.log.push({
      t: req.t,
      signature: m.route.signature,
      method: req.method,
      identity: req.identity,
      status: res.status,
      committed: !replayed && res.status < 400,
      feature: m.route.meta.feature,
      note: replayed ? "idempotent-replay" : res.note,
    });
    return { res, signature: m.route.signature, meta: m.route.meta };
  }
}

/** Response envelope styles: programs differ in how lists and objects are wrapped. */
export interface ApiStyle {
  name: string;
  list(items: unknown[], extra?: Record<string, unknown>): unknown;
  unlist(body: unknown): { items: Item[]; extra: Record<string, unknown> };
  one(item: unknown): unknown;
  unone(body: unknown): Item;
  error(code: string, message: string): unknown;
}

export const API_STYLES: ApiStyle[] = [
  {
    name: "items",
    list: (items, extra) => ({ items, ...(extra ?? {}) }),
    unlist: (b) => {
      const o = (b ?? {}) as Record<string, unknown>;
      const { items, ...extra } = o;
      return { items: (Array.isArray(items) ? items : []) as Item[], extra };
    },
    one: (it) => it,
    unone: (b) => (b ?? {}) as Item,
    error: (code, message) => ({ error: code, message }),
  },
  {
    name: "data",
    list: (items, extra) => ({ data: items, meta: extra ?? {} }),
    unlist: (b) => {
      const o = (b ?? {}) as Record<string, unknown>;
      return { items: (Array.isArray(o.data) ? o.data : []) as Item[], extra: (o.meta ?? {}) as Record<string, unknown> };
    },
    one: (it) => ({ data: it }),
    unone: (b) => ((b as Record<string, unknown>)?.data ?? {}) as Item,
    error: (code, message) => ({ errors: [{ code, detail: message }] }),
  },
  {
    name: "bare",
    list: (items) => items,
    unlist: (b) => ({ items: (Array.isArray(b) ? b : []) as Item[], extra: {} }),
    one: (it) => it,
    unone: (b) => (b ?? {}) as Item,
    error: (code, message) => ({ code, message }),
  },
  {
    name: "results",
    list: (items, extra) => ({ results: items, count: items.length, ...(extra ?? {}) }),
    unlist: (b) => {
      const o = (b ?? {}) as Record<string, unknown>;
      const { results, ...extra } = o;
      return { items: (Array.isArray(results) ? results : []) as Item[], extra };
    },
    one: (it) => ({ result: it }),
    unone: (b) => ((b as Record<string, unknown>)?.result ?? {}) as Item,
    error: (code, message) => ({ ok: false, error: { code, message } }),
  },
];
