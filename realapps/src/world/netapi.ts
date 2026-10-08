// Browser-facing network classes on top of Network: fetch (with a pass-through accessor that lets the probe
// correlate the runtime's ops with the requests that reach the mock server), XMLHttpRequest and WebSocket.

import { makeResponseClass, type Network, type Outcome, type VWebSocketLike } from "./net.js";

type AnyFn = (...a: unknown[]) => unknown;

function bodyToString(b: unknown): string {
  if (b === undefined || b === null) return "";
  if (typeof b === "string") return b;
  if (b instanceof URLSearchParams) return b.toString();
  if (typeof FormData !== "undefined" && b instanceof FormData) {
    const p = new URLSearchParams();
    b.forEach((v, k) => p.append(k, typeof v === "string" ? v : `[file ${(v as File).name}]`));
    return p.toString();
  }
  if (b instanceof ArrayBuffer) return new TextDecoder().decode(b);
  if (ArrayBuffer.isView(b)) return new TextDecoder().decode(b as Uint8Array);
  if (typeof Blob !== "undefined" && b instanceof Blob) return `[blob ${b.size}]`;
  return String(b);
}

export interface NetApi {
  /** The init object of the fetch call in progress (outer accessor), for op correlation. */
  currentInit(): object | null;
  MockResponse: typeof Response;
}

export function installNetApi(w: Window & typeof globalThis, net: Network): NetApi {
  const g = w as unknown as Record<string, unknown>;
  const MockResponse = makeResponseClass(w.Response);
  g.Response = MockResponse;
  const origin = w.location.origin;

  // ------------------------------------------------------------------------------------------------ fetch
  function mockFetch(this: unknown, input: unknown, init?: RequestInit): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      let method = "GET";
      let url = "";
      const headers: Record<string, string> = {};
      let signal: AbortSignal | undefined;
      let reqBody: Promise<string> | null = null;
      let raw = "";
      if (typeof Request !== "undefined" && input instanceof Request) {
        method = input.method;
        url = input.url;
        input.headers.forEach((v, k) => (headers[k] = v));
        signal = input.signal;
        if (!(init && "body" in init) && method !== "GET" && method !== "HEAD" && input.body) reqBody = input.clone().text();
      } else url = input instanceof URL ? input.href : String(input);
      if (init) {
        if (init.method) method = String(init.method);
        if (init.headers) new Headers(init.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
        if ("body" in init) raw = bodyToString(init.body);
        if (init.signal) signal = init.signal;
      }
      const abs = new URL(url, origin + "/").href;
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      const go = () => {
        const deliver = (o: Outcome) => {
          signal?.removeEventListener("abort", onAbort);
          if (o.kind === "response") resolve(new (MockResponse as unknown as new (b: BodyInit | null, i: ResponseInit, u: string) => Response)(o.body, { status: o.status, statusText: o.statusText, headers: o.headers }, abs));
          else if (o.kind === "neterr") reject(new TypeError("Failed to fetch"));
          else reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        };
        const p = net.start(method, abs, headers, raw, "fetch", { init: init ?? {} }, deliver);
        const onAbort = () => {
          const r = signal?.reason as { name?: string } | undefined;
          p.abort(r?.name === "TimeoutError");
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      };
      if (reqBody)
        reqBody.then(
          (s) => {
            raw = s;
            go();
          },
          () => go(),
        );
      else go();
    });
  }
  let inner: AnyFn = mockFetch as AnyFn;
  let pendingInit: object | null = null;
  const outer = function (this: unknown, input: unknown, init?: unknown) {
    const i = init && typeof init === "object" ? init : {};
    const prev = pendingInit;
    pendingInit = i;
    try {
      return inner.call(w, input, i);
    } finally {
      pendingInit = prev;
    }
  };
  Object.defineProperty(w, "fetch", {
    configurable: true,
    enumerable: true,
    get: () => (inner === (mockFetch as AnyFn) ? mockFetch : outer),
    set: (fn: AnyFn) => {
      inner = fn;
    },
  });

  // ---------------------------------------------------------------------------------------- XMLHttpRequest
  interface XS {
    readyState: number;
    status: number;
    statusText: string;
    responseType: XMLHttpRequestResponseType;
    responseText: string;
    response: unknown;
    responseURL: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    resHeaders: Record<string, string>;
    pending: ReturnType<Network["start"]> | null;
    timeoutTask: { cancelled: boolean } | null;
    sendFlag: boolean;
  }
  const S = new WeakMap<object, XS>();
  const st = (x: object): XS => {
    let s = S.get(x);
    if (!s) {
      s = { readyState: 0, status: 0, statusText: "", responseType: "", responseText: "", response: "", responseURL: "", method: "GET", url: "", headers: {}, resHeaders: {}, pending: null, timeoutTask: null, sendFlag: false };
      S.set(x, s);
    }
    return s;
  };
  class VXMLHttpRequestUpload extends EventTarget {}
  class VXMLHttpRequest extends EventTarget {
    static readonly UNSENT = 0;
    static readonly OPENED = 1;
    static readonly HEADERS_RECEIVED = 2;
    static readonly LOADING = 3;
    static readonly DONE = 4;
    readonly UNSENT = 0;
    readonly OPENED = 1;
    readonly HEADERS_RECEIVED = 2;
    readonly LOADING = 3;
    readonly DONE = 4;
    timeout = 0;
    withCredentials = false;
    upload = new VXMLHttpRequestUpload();
    onreadystatechange: ((e: Event) => void) | null = null;
    onload: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onabort: ((e: Event) => void) | null = null;
    ontimeout: ((e: Event) => void) | null = null;
    onloadend: ((e: Event) => void) | null = null;
    onloadstart: ((e: Event) => void) | null = null;
    onprogress: ((e: Event) => void) | null = null;
    get readyState(): number {
      return st(this).readyState;
    }
    get status(): number {
      return st(this).status;
    }
    get statusText(): string {
      return st(this).statusText;
    }
    get responseType(): XMLHttpRequestResponseType {
      return st(this).responseType;
    }
    set responseType(v: XMLHttpRequestResponseType) {
      st(this).responseType = v;
    }
    get responseText(): string {
      return st(this).responseText;
    }
    get response(): unknown {
      return st(this).response;
    }
    get responseURL(): string {
      return st(this).responseURL;
    }
    override dispatchEvent(e: Event): boolean {
      const r = super.dispatchEvent(e);
      const h = (this as unknown as Record<string, unknown>)[`on${e.type}`];
      if (typeof h === "function") {
        try {
          (h as AnyFn).call(this, e);
        } catch (err) {
          w.reportError?.(err);
        }
      }
      return r;
    }
    private fire(type: string, pe = false): void {
      this.dispatchEvent(pe ? new ProgressEvent(type) : new Event(type));
    }
    open(method: string, url: string | URL): void {
      const s = st(this);
      s.pending?.abort();
      s.pending = null;
      s.method = String(method).toUpperCase();
      s.url = new URL(String(url), origin + "/").href;
      s.headers = {};
      s.resHeaders = {};
      s.status = 0;
      s.statusText = "";
      s.responseText = "";
      s.response = "";
      s.sendFlag = false;
      s.readyState = 1;
      this.fire("readystatechange");
    }
    setRequestHeader(k: string, v: string): void {
      st(this).headers[String(k).toLowerCase()] = String(v);
    }
    overrideMimeType(_m: string): void {}
    getResponseHeader(k: string): string | null {
      return st(this).resHeaders[String(k).toLowerCase()] ?? null;
    }
    getAllResponseHeaders(): string {
      return Object.entries(st(this).resHeaders)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("");
    }
    send(body?: unknown): void {
      const s = st(this);
      if (s.readyState !== 1 || s.sendFlag) throw new DOMException("The object's state must be OPENED.", "InvalidStateError");
      s.sendFlag = true;
      this.fire("loadstart", true);
      const finishErr = (type: "error" | "timeout" | "abort") => {
        s.readyState = 4;
        s.status = 0;
        s.statusText = "";
        s.sendFlag = false;
        this.fire("readystatechange");
        this.fire(type, true);
        this.fire("loadend", true);
      };
      const deliver = (o: Outcome) => {
        if (s.timeoutTask) s.timeoutTask.cancelled = true;
        s.pending = null;
        if (o.kind === "neterr") return finishErr("error");
        if (o.kind === "aborted") return; // handled by abort()/timeout
        s.status = o.status;
        s.statusText = o.statusText;
        s.resHeaders = { ...o.headers };
        s.responseURL = s.url;
        s.readyState = 2;
        this.fire("readystatechange");
        const text = o.body ?? "";
        s.readyState = 3;
        this.fire("readystatechange");
        this.fire("progress", true);
        s.responseText = s.responseType === "" || s.responseType === "text" ? text : "";
        if (s.responseType === "json") {
          try {
            s.response = text ? JSON.parse(text) : null;
          } catch {
            s.response = null;
          }
        } else if (s.responseType === "arraybuffer") s.response = new TextEncoder().encode(text).buffer;
        else if (s.responseType === "blob") s.response = new Blob([text]);
        else s.response = text;
        s.readyState = 4;
        s.sendFlag = false;
        this.fire("readystatechange");
        this.fire("load", true);
        this.fire("loadend", true);
      };
      const raw = s.method === "GET" || s.method === "HEAD" ? "" : bodyToString(body);
      s.pending = net.start(s.method, s.url, s.headers, raw, "xhr", { xhr: this }, deliver);
      if (this.timeout > 0) {
        s.timeoutTask = net.loop.schedule(this.timeout, () => {
          if (!s.pending) return;
          const p = s.pending;
          s.pending = null;
          p.abort(true);
          finishErr("timeout");
        }, "xhr-timeout");
      }
    }
    abort(): void {
      const s = st(this);
      if (s.pending) {
        const p = s.pending;
        s.pending = null;
        if (s.timeoutTask) s.timeoutTask.cancelled = true;
        p.abort();
        s.readyState = 4;
        s.status = 0;
        s.sendFlag = false;
        this.fire("readystatechange");
        this.fire("abort", true);
        this.fire("loadend", true);
      }
      s.readyState = 0;
    }
  }
  g.XMLHttpRequest = VXMLHttpRequest;
  g.XMLHttpRequestUpload = VXMLHttpRequestUpload;

  // ---------------------------------------------------------------------------------------------- WebSocket
  class VWebSocket extends EventTarget implements VWebSocketLike {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly url: string;
    readonly protocol = "";
    readonly extensions = "";
    bufferedAmount = 0;
    binaryType: BinaryType = "blob";
    readyState = 0;
    sid: number;
    lastDelivery = 0;
    topics = new Set<string>();
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    constructor(url: string | URL, _protocols?: string | string[]) {
      super();
      this.url = String(url);
      this.sid = net.nextSocketId();
      let topic = "";
      try {
        const u = new URL(this.url, origin.replace(/^http/, "ws") + "/");
        const p = decodeURIComponent(u.pathname);
        topic = p.includes("/ws/") ? p.slice(p.indexOf("/ws/") + 4) : p.replace(/^\/+/, "");
        const qt = u.searchParams.get("topic") ?? u.searchParams.get("topics");
        if (qt) for (const x of qt.split(",")) this.topics.add(x);
      } catch {
        /* ignore */
      }
      if (topic) this.topics.add(topic);
      const connectMs = net.ideal ? 0 : 25 + (net.seed % 7) * 8 + (this.sid % 5) * 7;
      net.loop.schedule(connectMs, () => {
        if (this.readyState !== 0) return;
        if (net.wsDownUntil > net.loop.now) {
          this.readyState = 3;
          this.dispatchEvent(new Event("error"));
          this.dispatchEvent(new CloseEvent("close", { code: 1006, wasClean: false, reason: "" }));
          return;
        }
        this.readyState = 1;
        net.sockets.add(this);
        this.dispatchEvent(new Event("open"));
      }, "ws");
    }
    override dispatchEvent(e: Event): boolean {
      const r = super.dispatchEvent(e);
      const h = (this as unknown as Record<string, unknown>)[`on${e.type}`];
      if (typeof h === "function") {
        try {
          (h as AnyFn).call(this, e);
        } catch (err) {
          w.reportError?.(err);
        }
      }
      return r;
    }
    wants(topic: string): boolean {
      if (this.topics.has("*") || this.topics.has(topic)) return true;
      for (const t of this.topics) if (topic.startsWith(t + "/") || t.startsWith(topic + "/")) return true;
      return false;
    }
    receive(data: string): void {
      this.dispatchEvent(new MessageEvent("message", { data, origin }));
    }
    drop(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      net.sockets.delete(this);
      this.dispatchEvent(new Event("error"));
      this.dispatchEvent(new CloseEvent("close", { code: 1006, wasClean: false, reason: "" }));
    }
    send(data: unknown): void {
      if (this.readyState !== 1) throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
      if (typeof data === "string") {
        try {
          const m = JSON.parse(data) as { type?: string; topic?: string; action?: string };
          if ((m.type === "subscribe" || m.action === "subscribe") && m.topic) this.topics.add(m.topic);
          if ((m.type === "unsubscribe" || m.action === "unsubscribe") && m.topic) this.topics.delete(m.topic);
        } catch {
          /* plain text */
        }
      }
    }
    close(code?: number, reason?: string): void {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      net.sockets.delete(this);
      net.loop.schedule(0, () => {
        this.readyState = 3;
        this.dispatchEvent(new CloseEvent("close", { code: code ?? 1000, wasClean: true, reason: reason ?? "" }));
      }, "ws");
    }
  }
  g.WebSocket = VWebSocket;
  g.EventSource = undefined;

  return { currentInit: () => pendingInit, MockResponse };
}
