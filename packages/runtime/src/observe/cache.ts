// Response buffering for coalesce/serve_cached (CONTRACT §7): the last good response per GET identity
// (≤ 256 KB each, ≤ 64 entries, memory only) and, for coalescing, the buffered result of identical requests that
// are in flight or finished within the last 2 s. The app always reads its own Response object; we read a clone,
// so no body is ever consumed twice.

import type { OpRec } from "../trace/ops.js";

export const MAX_BODY = 256 * 1024;
export const MAX_ENTRIES = 64;
export const COALESCE_WINDOW_MS = 2000;

export interface Buffered {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer;
  url: string;
  t: number;
}

interface RecentEntry {
  op: OpRec;
  /** Resolves with the buffered response, or null when it could not be buffered / failed. */
  body: Promise<Buffered | null>;
  settledAt?: number;
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

export class ResponseCache {
  private good = new Map<string, Buffered>();
  private recent = new Map<string, RecentEntry[]>();

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
    this.good.delete(identity);
    this.good.set(identity, b);
    while (this.good.size > MAX_ENTRIES) {
      const first = this.good.keys().next().value;
      if (first === undefined) break;
      this.good.delete(first);
    }
  }

  /** Register an in-flight request whose response may be shared. */
  track(identity: string, op: OpRec, body: Promise<Buffered | null>): RecentEntry {
    const e: RecentEntry = { op, body };
    const list = this.recent.get(identity) ?? [];
    list.push(e);
    if (list.length > 8) list.shift();
    this.recent.set(identity, list);
    if (this.recent.size > 256) {
      const first = this.recent.keys().next().value;
      if (first !== undefined) this.recent.delete(first);
    }
    return e;
  }

  /** The newest identical request that is in flight or settled within the coalescing window. */
  shareable(identity: string, selfId: number, now: number): RecentEntry | undefined {
    const list = this.recent.get(identity);
    if (!list) return undefined;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.op.id === selfId || e.op.id > selfId) continue;
      if (e.settledAt === undefined || now - e.settledAt <= COALESCE_WINDOW_MS) return e;
    }
    return undefined;
  }

  clear(): void {
    this.good.clear();
    this.recent.clear();
  }
}

/** Read a clone of `res` into memory (bounded). Never throws. */
export async function bufferResponse(res: Response, now: () => number): Promise<Buffered | null> {
  try {
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) return null;
    const len = Number(res.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(len) && len > MAX_BODY) return null;
    const clone = res.clone();
    let body: ArrayBuffer;
    const stream = clone.body as ReadableStream<Uint8Array> | null;
    if (stream && typeof stream.getReader === "function") {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
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
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      body = out.buffer;
    } else if (stream === null && typeof clone.arrayBuffer === "function") {
      body = await clone.arrayBuffer();
      if (body.byteLength > MAX_BODY) return null;
    } else {
      body = await clone.arrayBuffer();
      if (body.byteLength > MAX_BODY) return null;
    }
    const headers: [string, string][] = [];
    res.headers.forEach((v, k) => headers.push([k, v]));
    return { status: res.status, statusText: res.statusText, headers, body, url: res.url, t: now() };
  } catch {
    return null;
  }
}

/** A fresh Response from a buffered one, marked with `x-genclass`. */
export function makeResponse(R: typeof Response, b: Buffered, mark: string): Response {
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
