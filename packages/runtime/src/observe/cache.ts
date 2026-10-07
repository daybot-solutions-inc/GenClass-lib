// Response buffering for coalesce/serve_cached (CONTRACT §7): the last good response per GET identity
// (≤ 256 KB each, ≤ 64 entries, memory only) and, for coalescing, the buffered result of identical requests that
// are in flight or finished within the last 2 s (≤ 64 entries and ≤ 4 MB, expired entries dropped). The app always
// reads its own Response object; we read a clone, so no body is ever consumed twice. Opaque / status-0 responses
// (no readable body) are shared as clones. A body still streaming after 1 s is not shared.

import type { Clock } from "../types.js";
import type { OpRec } from "../trace/ops.js";

export const MAX_BODY = 256 * 1024;
export const MAX_ENTRIES = 64;
export const COALESCE_WINDOW_MS = 2000;
/** A response body that is still streaming after this long is not buffered (not shareable). */
export const BUFFER_WAIT_MS = 1000;
const MAX_RECENT = 64;
const MAX_RECENT_BYTES = 4 * 1024 * 1024;

export type Buffered =
  | { kind: "body"; status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer; url: string; t: number }
  | { kind: "opaque"; res: Response; status: number; t: number };

export interface RecentEntry {
  op: OpRec;
  /** Resolves with the buffered response, or null when it could not be buffered / failed. */
  body: Promise<Buffered | null>;
  settledAt?: number;
  bytes: number;
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

export class ResponseCache {
  private good = new Map<string, Buffered>();
  private recent = new Map<string, RecentEntry[]>();

  constructor(private readonly clock: Clock) {}

  /** Last good GET response for an identity. */
  get(identity: string): Buffered | undefined {
    const b = this.good.get(identity);
    if (b) {
      this.good.delete(identity);
      this.good.set(identity, b);
    }
    return b;
  }

  peek(identity: string): Buffered | undefined {
    return this.good.get(identity);
  }

  put(identity: string, b: Buffered): void {
    if (b.kind !== "body") return;
    this.good.delete(identity);
    this.good.set(identity, b);
    while (this.good.size > MAX_ENTRIES) {
      const first = this.good.keys().next().value;
      if (first === undefined) break;
      this.good.delete(first);
    }
  }

  /** Drop expired coalescing entries and keep the rest within the entry and byte bounds. */
  prune(now: number): void {
    let count = 0;
    let bytes = 0;
    const settled: { id: string; e: RecentEntry }[] = [];
    for (const [id, list] of this.recent) {
      const keep = list.filter((e) => e.settledAt === undefined || now - e.settledAt <= COALESCE_WINDOW_MS);
      if (keep.length) this.recent.set(id, keep);
      else this.recent.delete(id);
      for (const e of keep) {
        count++;
        bytes += e.bytes;
        if (e.settledAt !== undefined) settled.push({ id, e });
      }
    }
    settled.sort((a, b) => a.e.settledAt! - b.e.settledAt!);
    for (const { id, e } of settled) {
      if (count <= MAX_RECENT && bytes <= MAX_RECENT_BYTES) break;
      const list = this.recent.get(id);
      if (!list) continue;
      const i = list.indexOf(e);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) this.recent.delete(id);
      count--;
      bytes -= e.bytes;
    }
  }

  /** Register a request whose response may be shared. */
  track(identity: string, op: OpRec, body: Promise<Buffered | null>): RecentEntry {
    this.prune(this.clock.now());
    const e: RecentEntry = { op, body, bytes: 0 };
    body.then((b) => {
      e.bytes = b && b.kind === "body" ? b.body.byteLength : 0;
    });
    const list = this.recent.get(identity) ?? [];
    list.push(e);
    if (list.length > 8) list.shift();
    this.recent.set(identity, list);
    return e;
  }

  /** The newest identical request that is in flight or settled within the coalescing window. */
  shareable(identity: string, selfId: number, now: number): RecentEntry | undefined {
    this.prune(now);
    const list = this.recent.get(identity);
    if (!list) return undefined;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.op.id >= selfId) continue;
      if (e.settledAt === undefined || now - e.settledAt <= COALESCE_WINDOW_MS) return e;
    }
    return undefined;
  }

  clear(): void {
    this.good.clear();
    this.recent.clear();
  }
}

/** Whether a response has no readable body to buffer (opaque, opaqueredirect, error, status 0). */
export function isOpaque(res: Response): boolean {
  const t = (res as { type?: string }).type;
  return t === "opaque" || t === "opaqueredirect" || t === "error" || res.status === 0 || res.status < 200 || res.status > 599;
}

/** Read a clone of `res` into memory (bounded in size and time). Never throws. */
export async function bufferResponse(res: Response, clock: Clock): Promise<Buffered | null> {
  try {
    if (isOpaque(res)) return { kind: "opaque", res: res.clone(), status: res.status, t: clock.now() };
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) return null;
    const len = Number(res.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(len) && len > MAX_BODY) return null;
    const clone = res.clone();
    const stream = clone.body as ReadableStream<Uint8Array> | null;
    let body: ArrayBuffer;
    if (stream && typeof stream.getReader === "function") {
      const reader = stream.getReader();
      let timedOut = false;
      const timer = clock.setTimeout(() => {
        timedOut = true;
        reader.cancel().catch(() => undefined);
      }, BUFFER_WAIT_MS);
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (timedOut) return null;
          if (done) break;
          if (value) {
            total += value.byteLength;
            if (total > MAX_BODY) {
              await reader.cancel().catch(() => undefined);
              return null;
            }
            chunks.push(value);
          }
        }
      } finally {
        clock.clearTimeout(timer);
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      body = out.buffer;
    } else {
      body = await clone.arrayBuffer();
      if (body.byteLength > MAX_BODY) return null;
    }
    const headers: [string, string][] = [];
    res.headers.forEach((v, k) => headers.push([k, v]));
    return { kind: "body", status: res.status, statusText: res.statusText, headers, body, url: res.url, t: clock.now() };
  } catch {
    return null;
  }
}

/** A fresh Response from a buffered one, marked with `x-genclass` (opaque responses are cloned unmarked). */
export function makeResponse(R: typeof Response, b: Buffered, mark: string): Response {
  if (b.kind === "opaque") return b.res.clone();
  const h = new Headers(b.headers);
  h.set("x-genclass", mark);
  const res = new R(NULL_BODY.has(b.status) ? null : b.body.slice(0), { status: b.status, statusText: b.statusText, headers: h });
  try {
    Object.defineProperty(res, "url", { value: b.url, configurable: true });
  } catch {
    /* ignore */
  }
  return res;
}

export function blockedResponse(R: typeof Response): Response {
  return new R(null, { status: 503, statusText: "Blocked by GenClass", headers: { "x-genclass": "blocked" } });
}
