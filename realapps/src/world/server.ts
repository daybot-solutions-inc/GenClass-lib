// In-page mock backend: generic REST resources (collections, docs, counters), auth with rotating refresh tokens,
// cart echo, Idempotency-Key replay, optimistic-concurrency versions (409), relative non-idempotent actions, bulk
// ops with per-item results, versioned history (replica-lag reads), live-update publishing, server extensions.
// Item ids are content-derived (collection + content + occurrence), so the same intent gets the same id in every
// run and an accidental duplicate gets a new one.

import { endpointsOf, matchEndpoint, type Endpoint } from "../shared/routes.js";
import type { CollectionSpec, Envelope, ServerSnap, ServerSpec } from "../shared/types.js";
import { conduitHandler } from "./ext/conduit.js";

export type Item = Record<string, unknown>;

export interface SReq {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
  raw: string;
}

export interface SRes {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** The request changed server state. */
  wrote: boolean;
  /** List response (for empty-list bugs / outages). */
  list?: boolean;
}

export interface Publish {
  topic: string;
  msg: Record<string, unknown>;
}

const VOLATILE = new Set(["id", "version", "rev", "updatedAt", "updated_at", "createdAt", "created_at", "clientId", "client_id", "tempId", "pending", "seq", "_seq"]);

export function canonical(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x) ?? "null";
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  const keys = Object.keys(x as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function contentKey(x: unknown): string {
  if (x && typeof x === "object" && !Array.isArray(x)) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as object)) if (!VOLATILE.has(k)) o[k] = v;
    return canonical(o);
  }
  return canonical(x);
}

export function hash32(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function hashAll(...parts: (string | number | boolean | undefined)[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) h = hash32(String(p), h ^ 0x5bd1e995);
  return h >>> 0;
}

interface Row {
  id: string;
  seq: number;
  hist: { t: number; v: Item | null }[];
}

/** `where` filter of external events: { field: value } or { field: { $gt, $gte, $lt, $lte, $ne, $in } }. */
export function matchesWhere(it: Item, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const x = it[k];
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      const n = Number(x);
      if ("$gt" in c && !(n > Number(c.$gt))) return false;
      if ("$gte" in c && !(n >= Number(c.$gte))) return false;
      if ("$lt" in c && !(n < Number(c.$lt))) return false;
      if ("$lte" in c && !(n <= Number(c.$lte))) return false;
      if ("$ne" in c && x === c.$ne) return false;
      if ("$in" in c && !(Array.isArray(c.$in) && (c.$in as unknown[]).includes(x))) return false;
      return true;
    }
    return x === cond;
  });
}

export class Coll {
  rows = new Map<string, Row>();
  order: Row[] = [];
  private seqN = 0;
  constructor(readonly spec: CollectionSpec) {}
  get(id: string, asOf = Infinity): Item | null {
    const r = this.rows.get(id);
    if (!r) return null;
    for (let i = r.hist.length - 1; i >= 0; i--) if (r.hist[i]!.t <= asOf) return r.hist[i]!.v;
    return null;
  }
  put(id: string, v: Item | null, t: number): void {
    let r = this.rows.get(id);
    if (!r) {
      r = { id, seq: this.seqN++, hist: [] };
      this.rows.set(id, r);
      this.order.push(r);
    }
    r.hist.push({ t, v });
    if (r.hist.length > 12) r.hist.splice(0, r.hist.length - 12);
  }
  list(asOf = Infinity): Item[] {
    const out: Item[] = [];
    for (const r of this.order) {
      const v = this.get(r.id, asOf);
      if (v) out.push(v);
    }
    return out;
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
}

export class MockServer {
  readonly eps: Endpoint[];
  readonly B: string;
  colls = new Map<string, Coll>();
  docs = new Map<string, { hist: { t: number; v: Item }[]; spec: NonNullable<ServerSpec["docs"]>[number] }>();
  counters = new Map<string, number>();
  private occ = new Map<string, number>();
  private idem = new Map<string, SRes>();
  private tokens = new Map<string, number>();
  private refresh = new Map<string, "valid" | "used">();
  private tokN = 0;
  writes = 0;
  /** Published live updates (the network delivers them to subscribed sockets). */
  onPublish: ((p: Publish) => void) | null = null;
  /** Extension state. */
  ext: Record<string, unknown> = {};
  /** Ids that fail inside the current bulk request (set by the network from its keyed draws). */
  bulkFail: Set<string> | null = null;
  now: () => number = () => 0;
  epoch = 0;

  constructor(readonly spec: ServerSpec, readonly seedKey: string) {
    this.eps = endpointsOf(spec);
    this.B = spec.base.replace(/\/$/, "");
    for (const c of spec.collections) {
      const coll = new Coll(c);
      this.colls.set(c.path ?? c.name, coll);
      for (const it of c.seed) {
        const id = it.id !== undefined ? String(it.id) : this.newId(c, it);
        const v: Item = { ...it, id: it.id ?? this.idValue(c, id) };
        if (c.versioned && v.version === undefined) v.version = 1;
        coll.put(id, v, -1);
      }
    }
    for (const d of spec.docs ?? []) this.docs.set(d.name, { hist: [{ t: -1, v: { ...d.init, ...(d.versioned ? { version: (d.init.version as number) ?? 1 } : {}) } }], spec: d });
    for (const c of spec.counters ?? []) this.counters.set(c.name, c.init);
  }

  private iso(t: number): string {
    return new Date(this.epoch + Math.max(0, t)).toISOString();
  }

  private idValue(c: CollectionSpec, id: string): unknown {
    return (c.idStyle ?? "num") === "num" ? Number(id) : id;
  }

  newId(c: CollectionSpec, body: Item): string {
    const ck = `${c.name}|${contentKey(body)}`;
    const n = (this.occ.get(ck) ?? 0) + 1;
    this.occ.set(ck, n);
    const h = hashAll(this.seedKey, ck, n);
    switch (c.idStyle ?? "num") {
      case "num":
        return String(1000 + (h % 900000));
      case "uuid": {
        const hx = (hashAll(h, 1).toString(16).padStart(8, "0") + hashAll(h, 2).toString(16).padStart(8, "0") + hashAll(h, 3).toString(16).padStart(8, "0") + hashAll(h, 4).toString(16).padStart(8, "0")).slice(0, 32);
        return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-4${hx.slice(13, 16)}-a${hx.slice(17, 20)}-${hx.slice(20, 32)}`;
      }
      case "slug": {
        const base = slugify(String(body.title ?? body.name ?? body.text ?? c.name));
        return `${base || c.name}-${h.toString(36).slice(0, 4)}`;
      }
      default:
        return `${c.name.slice(0, 3)}_${h.toString(36)}`;
    }
  }

  snapshot(): ServerSnap {
    const collections: ServerSnap["collections"] = {};
    for (const [name, c] of this.colls) {
      const o: Record<string, unknown> = {};
      for (const r of c.order) {
        const v = c.get(r.id);
        if (v) o[r.id] = v;
      }
      collections[name] = o;
    }
    const docs: ServerSnap["docs"] = {};
    for (const [n, d] of this.docs) docs[n] = d.hist[d.hist.length - 1]!.v;
    const counters: ServerSnap["counters"] = {};
    for (const [n, v] of this.counters) counters[n] = v;
    if (this.ext.conduit) Object.assign(collections, (this.ext.conduit as { snapshot(): Record<string, Record<string, unknown>> }).snapshot());
    return { collections, docs, counters };
  }

  match(method: string, path: string) {
    return matchEndpoint(this.eps, method, path);
  }

  private publish(topic: string, msg: Record<string, unknown>): void {
    this.onPublish?.({ topic, msg });
  }

  private tokenValid(h: Record<string, string>): boolean {
    const a = h["authorization"] ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(a);
    if (!m) return false;
    const exp = this.tokens.get(m[1]!);
    return exp !== undefined && exp > this.now();
  }

  private issue(): { token: string; refreshToken: string; expiresIn: number } {
    const n = ++this.tokN;
    const token = `tok_${hashAll(this.seedKey, "tok", n).toString(36)}`;
    const refreshToken = `rt_${hashAll(this.seedKey, "rt", n).toString(36)}`;
    const ttl = this.spec.auth?.ttlMs ?? 60000;
    this.tokens.set(token, this.now() + ttl);
    this.refresh.set(refreshToken, "valid");
    return { token, refreshToken, expiresIn: Math.round(ttl / 1000) };
  }

  private envelope(c: CollectionSpec | undefined, items: Item[], total: number, page: number): unknown {
    const env: Envelope = c?.envelope ?? this.spec.envelope ?? "items";
    switch (env) {
      case "bare":
        return items;
      case "data":
        return { data: items, meta: { total, page } };
      case "results":
        return { results: items, count: total };
      default:
        return { items, total, page };
    }
  }

  private cartView(coll: Coll): Item {
    const items = coll.list();
    let total = 0;
    let count = 0;
    for (const it of items) {
      const q = Number(it.qty ?? 1);
      total += Number(it.price ?? 0) * q;
      count += q;
    }
    return { items, count, total: Math.round(total * 100) / 100 };
  }

  /**
   * Handle a request at server time `t` (reads see the state as of `asOf`, for replica lag). Pure function of the
   * server state and the request (deterministic).
   */
  handle(req: SReq, asOf: number): SRes {
    const t = this.now();
    const m = this.match(req.method, req.path);
    if (!m) return { status: 404, body: { error: "not found" }, wrote: false };
    const { ep, params } = m;
    const sig = ep.sig;
    const idemKey = req.headers["idempotency-key"];
    if (idemKey && req.method !== "GET") {
      const prev = this.idem.get(`${sig}|${idemKey}`);
      if (prev) return { ...prev, wrote: false, headers: { ...(prev.headers ?? {}), "idempotent-replayed": "true" } };
    }
    const res = this.route(ep, params, req, t, asOf);
    if (res.wrote) this.writes++;
    if (idemKey && req.method !== "GET" && res.status < 500) this.idem.set(`${sig}|${idemKey}`, res);
    return res;
  }

  private route(ep: Endpoint, params: Record<string, string>, req: SReq, t: number, asOf: number): SRes {
    const B = this.B;
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Item;
    // extensions
    if (this.spec.ext?.includes("conduit") && /^\/(users|user|profiles|articles|tags)(\/|$)/.test(ep.pattern.slice(B.length))) {
      return conduitHandler(this, ep, params, req, t, asOf);
    }
    // auth
    if (ep.pattern === `${B}/auth/login`) {
      if (!body.username || !body.password) return { status: 422, body: { error: "username and password required" }, wrote: false };
      return { status: 200, body: { ...this.issue(), user: { username: body.username } }, wrote: true };
    }
    if (ep.pattern === `${B}/auth/refresh`) {
      const rtok = String(body.refreshToken ?? "");
      const st = this.refresh.get(rtok);
      if (st !== "valid") return { status: 401, body: { error: "invalid refresh token" }, wrote: false };
      if (this.spec.auth?.rotate) this.refresh.set(rtok, "used");
      return { status: 200, body: this.issue(), wrote: true };
    }
    if (ep.pattern === `${B}/auth/me`) {
      if (!this.tokenValid(req.headers)) return { status: 401, body: { error: "token expired" }, wrote: false };
      return { status: 200, body: { username: "demo" }, wrote: false };
    }
    // docs
    if (ep.pattern.startsWith(`${B}/docs/`)) {
      const name = ep.pattern.slice(`${B}/docs/`.length);
      const d = this.docs.get(name)!;
      if (d.spec.protected && !this.tokenValid(req.headers)) return { status: 401, body: { error: "token expired" }, wrote: false };
      const cur = d.hist[d.hist.length - 1]!.v;
      if (req.method === "GET") {
        let v = cur;
        for (let i = d.hist.length - 1; i >= 0; i--)
          if (d.hist[i]!.t <= asOf) {
            v = d.hist[i]!.v;
            break;
          }
        return { status: 200, body: v, wrote: false };
      }
      if (d.spec.versioned) {
        const want = body.version ?? (req.headers["if-match"] ? Number(req.headers["if-match"]) : undefined);
        if (want !== undefined && Number(want) !== Number(cur.version)) return { status: 409, body: { error: "version conflict", current: cur }, wrote: false };
      }
      const patch = { ...body };
      delete patch.version;
      const next: Item = req.method === "PUT" ? { ...patch } : { ...cur, ...patch };
      if (d.spec.versioned) next.version = Number(cur.version ?? 0) + 1;
      next.updatedAt = this.iso(t);
      d.hist.push({ t, v: next });
      if (d.hist.length > 12) d.hist.splice(0, d.hist.length - 12);
      if (d.spec.live) this.publish(`docs/${name}`, { type: "updated", doc: name, item: next });
      return { status: 200, body: next, wrote: true };
    }
    // counters
    if (ep.pattern.startsWith(`${B}/counters/`)) {
      const rest = ep.pattern.slice(`${B}/counters/`.length);
      const name = rest.replace(/\/incr$/, "");
      const cur = this.counters.get(name) ?? 0;
      const spec = this.spec.counters?.find((c) => c.name === name);
      if (req.method === "GET") return { status: 200, body: { name, value: cur }, wrote: false };
      const next = rest.endsWith("/incr") ? cur + Number(body.by ?? 1) : Number(body.value ?? cur);
      this.counters.set(name, next);
      if (spec?.live) this.publish(`counters/${name}`, { type: "updated", counter: name, value: next });
      return { status: 200, body: { name, value: next }, wrote: true };
    }
    // cart summary
    if (this.spec.cart && ep.pattern === `${B}/${this.spec.cart.collection}/summary`) {
      const coll = this.colls.get(this.spec.cart.collection)!;
      return { status: 200, body: this.cartView(coll), wrote: false };
    }
    // collections
    const segs = ep.pattern.slice(B.length + 1).split("/");
    const coll = this.colls.get(segs[0]!);
    if (!coll) return { status: 404, body: { error: "not found" }, wrote: false };
    const c = coll.spec;
    if (c.protected && !this.tokenValid(req.headers)) return { status: 401, body: { error: "token expired" }, wrote: false };
    const isCart = this.spec.cart?.collection === (c.path ?? c.name);
    const echo = (item: Item | null, status = 200): SRes => ({ status, body: isCart ? this.cartView(coll) : item, wrote: true });
    const live = (type: string, id: string, item: Item | null) => {
      if (c.live) this.publish(c.name, { type, collection: c.name, id: this.idValue(c, id), item });
    };
    const id = params.id;
    if (segs.length === 1) {
      if (req.method === "GET") {
        let items = coll.list(asOf);
        const q = req.query.get("q") ?? req.query.get("search") ?? req.query.get("query");
        if (q) {
          const ql = q.toLowerCase();
          const fields = c.search ?? ["name", "title", "text"];
          items = items.filter((it) => fields.some((f) => String(it[f] ?? "").toLowerCase().includes(ql)));
        }
        for (const f of c.filters ?? []) {
          const v = req.query.get(f);
          if (v !== null && v !== "" && v !== "all") items = items.filter((it) => String(it[f]) === v);
        }
        // generic operators on any field: f__in=a,b  f__gt / __gte / __lt / __lte (numeric or ISO strings)
        // f__ne=v  f__empty=true|false (null, undefined, "" or [])
        for (const [key, raw] of req.query.entries()) {
          const m = /^(.+)__(in|gt|gte|lt|lte|ne|empty)$/.exec(key);
          if (!m) continue;
          const [, f, op] = m as unknown as [string, string, string];
          const isEmpty = (x: unknown) => x === undefined || x === null || x === "" || (Array.isArray(x) && x.length === 0);
          const cmp = (x: unknown): number => {
            const a = Number(x);
            const b = Number(raw);
            if (!Number.isNaN(a) && !Number.isNaN(b) && raw.trim() !== "") return a - b;
            return String(x ?? "") < raw ? -1 : String(x ?? "") > raw ? 1 : 0;
          };
          items = items.filter((it) => {
            const x = it[f!];
            switch (op) {
              case "in":
                return raw.split(",").includes(String(x));
              case "ne":
                return String(x) !== raw;
              case "empty":
                return (raw === "true" || raw === "1") === isEmpty(x);
              case "gt":
                return !isEmpty(x) && cmp(x) > 0;
              case "gte":
                return !isEmpty(x) && cmp(x) >= 0;
              case "lt":
                return !isEmpty(x) && cmp(x) < 0;
              default:
                return !isEmpty(x) && cmp(x) <= 0;
            }
          });
        }
        const sort = req.query.get("sort");
        if (sort) {
          const desc = sort.startsWith("-");
          const k = desc ? sort.slice(1) : sort;
          items = items.slice().sort((a, b) => {
            const x = a[k] as never;
            const y = b[k] as never;
            return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1);
          });
        }
        const total = items.length;
        const size = Number(req.query.get("limit") ?? req.query.get("pageSize") ?? c.pageSize ?? 20) || 20;
        // cursor pagination: ?cursor=<id of the last item seen> (or ?after=); the response carries nextCursor
        const cursor = req.query.get("cursor") ?? req.query.get("after");
        if (cursor !== null && !isCart) {
          // keyset: the items that come after the cursor item in this ordering, even if that item has since been
          // filtered out or deleted (it is located in the whole collection, deleted rows included)
          const seqOf = (id: string) => coll.rows.get(id)?.seq ?? -1;
          const sortKey = req.query.get("sort");
          const desc = !!sortKey && sortKey.startsWith("-");
          const k = sortKey ? (desc ? sortKey.slice(1) : sortKey) : null;
          let start = 0;
          if (cursor !== "") {
            const row = coll.rows.get(cursor);
            if (!row) start = items.length;
            else {
              const cv = row.hist.length ? [...row.hist].reverse().find((h) => h.v)?.v ?? null : null;
              const after = (it: Item): boolean => {
                if (k && cv) {
                  const x = it[k] as never;
                  const y = cv[k] as never;
                  if (x !== y) return desc ? x < y : x > y;
                }
                return seqOf(String(it.id)) > row.seq;
              };
              start = items.findIndex(after);
              if (start < 0) start = items.length;
            }
          }
          const pageItems = items.slice(start, start + size);
          const last = pageItems[pageItems.length - 1];
          const nextCursor = start + size < items.length && last ? String(last.id) : null;
          const body = this.envelope(c, pageItems, total, 0);
          const withCursor = Array.isArray(body) ? body : { ...(body as Record<string, unknown>), nextCursor };
          return { status: 200, body: withCursor, wrote: false, list: true, ...(Array.isArray(body) && nextCursor ? { headers: { "x-next-cursor": nextCursor } } : {}) };
        }
        let page = Number(req.query.get("page") ?? 0);
        let off = Number(req.query.get("offset") ?? 0);
        if (page > 0) off = (page - 1) * size;
        else page = Math.floor(off / size) + 1;
        if (isCart && !req.query.has("page")) return { status: 200, body: this.cartView(coll), wrote: false, list: true };
        return { status: 200, body: this.envelope(c, items.slice(off, off + size), total, page), wrote: false, list: true };
      }
      // create
      const fresh: Item = { ...body };
      delete fresh.id;
      const missing = (c.required ?? []).filter((f) => fresh[f] === undefined || fresh[f] === null || fresh[f] === "");
      if (missing.length) return { status: 422, body: { error: "validation failed", errors: Object.fromEntries(missing.map((f) => [f, "is required"])) }, wrote: false };
      const clash = (c.unique ?? []).find((f) => fresh[f] !== undefined && coll.list().some((it) => String(it[f]).toLowerCase() === String(fresh[f]).toLowerCase()));
      if (clash) return { status: 409, body: { error: `${clash} is already taken`, errors: { [clash]: "is already taken" } }, wrote: false };
      const nid = this.newId(c, fresh);
      const item: Item = { ...fresh, id: this.idValue(c, nid), createdAt: this.iso(t) };
      if (c.versioned) item.version = 1;
      if (isCart) {
        // adding a product already in the cart increments its quantity
        const existing = coll.list().find((it) => it.productId !== undefined && it.productId === fresh.productId);
        if (existing) {
          const next = { ...existing, qty: Number(existing.qty ?? 1) + Number(fresh.qty ?? 1) };
          coll.put(String(existing.id), next, t);
          live("updated", String(existing.id), next);
          return echo(next, 200);
        }
      }
      coll.put(nid, item, t);
      live("created", nid, item);
      return echo(item, 201);
    }
    if (segs[1] === "bulk") {
      const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(String) : [];
      const failed = this.bulkFail ?? new Set<string>();
      const results: Item[] = [];
      for (const bid of ids) {
        const cur = coll.get(bid);
        if (!cur) {
          results.push({ id: this.idValue(c, bid), ok: false, status: 404 });
          continue;
        }
        if (failed.has(bid)) {
          results.push({ id: this.idValue(c, bid), ok: false, status: 503 });
          continue;
        }
        if (body.op === "delete") {
          coll.put(bid, null, t);
          live("deleted", bid, null);
        } else {
          const next = { ...cur, ...((body.patch as Item) ?? {}) };
          if (c.versioned) next.version = Number(cur.version ?? 0) + 1;
          coll.put(bid, next, t);
          live("updated", bid, next);
        }
        results.push({ id: this.idValue(c, bid), ok: true, status: 200 });
      }
      return { status: results.some((r) => !r.ok) ? 207 : 200, body: { results }, wrote: results.some((r) => r.ok) };
    }
    const cur = id !== undefined ? coll.get(id, req.method === "GET" ? asOf : Infinity) : null;
    if (!cur) return { status: 404, body: { error: "not found" }, wrote: false };
    if (req.method === "GET" && segs.length === 2) return { status: 200, body: cur, wrote: false };
    if (req.method === "DELETE") {
      coll.put(id!, null, t);
      live("deleted", id!, null);
      return { ...echo(null, isCart ? 200 : 204), body: isCart ? this.cartView(coll) : null };
    }
    if (segs.length === 3 && req.method === "POST") {
      const a = c.actions?.[segs[2]!];
      if (!a) return { status: 404, body: { error: "unknown action" }, wrote: false };
      const next: Item = { ...cur };
      if (a.inc) next[a.inc] = Number(cur[a.inc] ?? 0) + (a.by ?? Number(body.by ?? 1));
      if (a.toggle) next[a.toggle] = !cur[a.toggle];
      if (a.set) Object.assign(next, a.set);
      if (c.versioned) next.version = Number(cur.version ?? 0) + 1;
      next.updatedAt = this.iso(t);
      coll.put(id!, next, t);
      live("updated", id!, next);
      return echo(next);
    }
    // PUT / PATCH
    if (c.versioned) {
      const want = body.version ?? (req.headers["if-match"] ? Number(req.headers["if-match"]) : undefined);
      if (want !== undefined && Number(want) !== Number(cur.version)) return { status: 409, body: { error: "version conflict", current: cur }, wrote: false };
    }
    const patch = { ...body };
    delete patch.id;
    delete patch.version;
    const clash2 = (c.unique ?? []).find((f) => patch[f] !== undefined && coll.list().some((it) => it.id !== cur.id && String(it[f]).toLowerCase() === String(patch[f]).toLowerCase()));
    if (clash2) return { status: 409, body: { error: `${clash2} is already taken`, errors: { [clash2]: "is already taken" } }, wrote: false };
    const next: Item = req.method === "PUT" ? { ...patch, id: cur.id, createdAt: cur.createdAt } : { ...cur, ...patch };
    if (c.versioned) next.version = Number(cur.version ?? 0) + 1;
    next.updatedAt = this.iso(t);
    coll.put(id!, next, t);
    live("updated", id!, next);
    return echo(next);
  }

  // ---------------------------------------------------------------------------------- external events
  /** Another user's change (external event), applied directly to server state and published. */
  external(kind: string, target: string, index: number | undefined, data: Item | undefined, verb?: string, by?: number, where?: Record<string, unknown>): void {
    const t = this.now();
    if (kind === "counter") {
      const v = (this.counters.get(target) ?? 0) + (by ?? 1);
      this.counters.set(target, v);
      const spec = this.spec.counters?.find((c) => c.name === target);
      if (spec?.live) this.publish(`counters/${target}`, { type: "updated", counter: target, value: v, by: "other" });
      this.writes++;
      return;
    }
    if (kind === "doc") {
      const d = this.docs.get(target);
      if (!d) return;
      const cur = d.hist[d.hist.length - 1]!.v;
      const next: Item = { ...cur, ...(data ?? {}) };
      if (d.spec.versioned) next.version = Number(cur.version ?? 0) + 1;
      d.hist.push({ t, v: next });
      if (d.spec.live) this.publish(`docs/${target}`, { type: "updated", doc: target, item: next, by: "other" });
      this.writes++;
      return;
    }
    if (this.ext.conduit) {
      (this.ext.conduit as { external(k: string, i: number | undefined, d: Item | undefined): void }).external(kind, index, data);
      return;
    }
    const coll = this.colls.get(target);
    if (!coll) return;
    const c = coll.spec;
    const all = coll.list();
    const items = where ? all.filter((it) => matchesWhere(it, where)) : all;
    if (kind === "create") {
      const fresh: Item = { ...(data ?? {}) };
      if (this.spec.cart?.collection === (c.path ?? c.name) && fresh.productId !== undefined) {
        const existing = items.find((it) => it.productId === fresh.productId);
        if (existing) {
          const merged = { ...existing, qty: Number(existing.qty ?? 1) + Number(fresh.qty ?? 1), updatedAt: this.iso(t) };
          coll.put(String(existing.id), merged, t);
          if (c.live) this.publish(c.name, { type: "updated", collection: c.name, id: existing.id, item: merged, by: "other" });
          this.writes++;
          return;
        }
      }
      if ((c.unique ?? []).some((f) => fresh[f] !== undefined && items.some((it) => String(it[f]).toLowerCase() === String(fresh[f]).toLowerCase()))) return;
      const nid = this.newId(c, fresh);
      const item: Item = { ...fresh, id: this.idValue(c, nid), createdAt: this.iso(t) };
      if (c.versioned) item.version = 1;
      coll.put(nid, item, t);
      if (c.live) this.publish(c.name, { type: "created", collection: c.name, id: item.id, item, by: "other" });
      this.writes++;
      return;
    }
    if (!items.length) return;
    const cur = items[(index ?? 0) % items.length]!;
    const id = String(cur.id);
    if (kind === "delete") {
      coll.put(id, null, t);
      if (c.live) this.publish(c.name, { type: "deleted", collection: c.name, id: cur.id, item: null, by: "other" });
    } else {
      const next: Item = { ...cur, ...(data ?? {}) };
      if (kind === "action" && verb && c.actions?.[verb]) {
        const a = c.actions[verb]!;
        if (a.inc) next[a.inc] = Number(cur[a.inc] ?? 0) + (a.by ?? by ?? 1);
        if (a.toggle) next[a.toggle] = !cur[a.toggle];
        if (a.set) Object.assign(next, a.set);
      }
      if (c.versioned) next.version = Number(cur.version ?? 0) + 1;
      next.updatedAt = this.iso(t);
      coll.put(id, next, t);
      if (c.live) this.publish(c.name, { type: "updated", collection: c.name, id: cur.id, item: next, by: "other" });
    }
    this.writes++;
  }
}
