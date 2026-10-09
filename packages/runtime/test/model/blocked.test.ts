// A model download the browser blocked (a Content-Security-Policy, most often): src/model/blocked.ts classifies the
// load error (plus the page's and the worker's securitypolicyviolation events), the host puts it in status.blocked,
// and the runtime prints one warning that names the blocked origin and the fix (Troy trial, 2026-10-09: the model
// failed with a bare "Failed to fetch" at info level under `connect-src 'self'`).
import { describe, expect, it } from "vitest";
import { createRuntime } from "../../src/index.js";
import { blockedFetch, blockedMessage, violationOf } from "../../src/model/blocked.js";
import { createModelHost, type WorkerLike } from "../../src/model/host.js";
import type { FromWorker, ToWorker } from "../../src/model/protocol.js";
import type { DecisionProvider, ModelStatus } from "../../src/types.js";
import { FakeClock, FakeServer, makeGlobal } from "../helpers.js";

const CARD = "https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.2.0/files/model.json";
const CARD_ERR = `model card download failed for ${CARD}: Failed to fetch`;
const PAGE = "https://troy.example";

describe("blockedFetch", () => {
  it("a network-type failure of a cross-origin download is a probable block, named by origin", () => {
    expect(blockedFetch(CARD_ERR, [], PAGE)).toEqual({ url: CARD, origin: "https://cdn.jsdelivr.net", csp: false });
    // Firefox and Safari wording
    expect(blockedFetch(`download failed for ${CARD}: NetworkError when attempting to fetch resource.`, [], PAGE)?.origin).toBe("https://cdn.jsdelivr.net");
    expect(blockedFetch(`download failed for ${CARD}: Load failed`, [], PAGE)?.origin).toBe("https://cdn.jsdelivr.net");
  });

  it("names the URL the network error was about (the ORT wasm), not the first one in the message", () => {
    const wasm = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.wasm";
    const err = `onnxruntime-web wasm download failed for ${wasm}: Failed to fetch; no plan could run the model: q8/wasm: no available backend found`;
    expect(blockedFetch(err, [], PAGE)).toMatchObject({ url: wasm, csp: false });
  });

  it("a CSP violation for that origin confirms it (with the directive)", () => {
    const v = { blockedURI: CARD, directive: "connect-src" };
    expect(blockedFetch(CARD_ERR, [v], PAGE)).toEqual({ url: CARD, origin: "https://cdn.jsdelivr.net", csp: true, directive: "connect-src" });
    // a violation explains an error that names no URL (e.g. a blocked worker script)
    expect(blockedFetch("the model worker crashed: Script error", [{ blockedURI: "https://cdn.jsdelivr.net/x/worker.js", directive: "worker-src" }], PAGE)).toMatchObject({ csp: true, directive: "worker-src" });
  });

  it("anything else is not a block: HTTP errors, checksums, same-origin failures, WebGPU", () => {
    expect(blockedFetch(`download failed: HTTP 404 for ${CARD}`, [], PAGE)).toBeNull();
    expect(blockedFetch(`checksum mismatch for model.onnx`, [], PAGE)).toBeNull();
    expect(blockedFetch(`model card download failed for ${PAGE}/genclass-model/model.json: Failed to fetch`, [], PAGE)).toBeNull();
    expect(blockedFetch("WebGPU did not come up (timeout)", [], PAGE)).toBeNull();
    expect(blockedFetch(undefined, [], PAGE)).toBeNull();
    // a violation for another origin does not explain a 404
    expect(blockedFetch(`download failed: HTTP 404 for ${CARD}`, [{ blockedURI: "https://fonts.example/a.woff", directive: "font-src" }], PAGE)).toBeNull();
  });

  it("violationOf keeps http(s) blocks only and prefers effectiveDirective", () => {
    expect(violationOf({ blockedURI: CARD, effectiveDirective: "connect-src", violatedDirective: "default-src" })).toEqual({ blockedURI: CARD, directive: "connect-src" });
    expect(violationOf({ blockedURI: "inline", violatedDirective: "script-src" })).toBeNull();
    expect(violationOf({ blockedURI: "eval" })).toBeNull();
    expect(violationOf(null)).toBeNull();
  });

  it("the message names the origin, both fixes and the blocked URL", () => {
    const m = blockedMessage({ url: CARD, origin: "https://cdn.jsdelivr.net", csp: true, directive: "connect-src" });
    expect(m).toContain("https://cdn.jsdelivr.net was blocked by this page's Content-Security-Policy (connect-src)");
    expect(m).toContain("npx @genclass/runtime fetch-model public/genclass-model");
    expect(m).toContain('model: { baseUrl: "/genclass-model/", ortWasmPaths: "/genclass-model/ort/" }');
    expect(m).toContain("allow https://cdn.jsdelivr.net in the CSP's connect-src");
    expect(m).toContain(CARD);
    expect(blockedMessage({ url: CARD, origin: "https://cdn.jsdelivr.net", csp: false })).toContain("most likely a Content-Security-Policy connect-src");
  });
});

class FakeWorker implements WorkerLike {
  sent: ToWorker[] = [];
  private listeners: Record<string, Array<(ev: any) => void>> = { message: [], error: [], messageerror: [] };
  postMessage(m: ToWorker): void {
    this.sent.push(m);
  }
  terminate(): void {}
  addEventListener(type: string, fn: (ev: any) => void): void {
    this.listeners[type].push(fn);
  }
  emit(m: FromWorker): void {
    for (const fn of this.listeners.message) fn({ data: m });
  }
}

describe("ModelHost status.blocked", () => {
  const host = () => {
    const w = new FakeWorker();
    const h = createModelHost({ preload: "eager", workerFactory: () => w, device: "wasm" });
    w.emit({ type: "hello" });
    return { h, w };
  };

  it("an error status from a blocked cross-origin download carries `blocked`", () => {
    const { h, w } = host();
    w.emit({ type: "status", status: { state: "error", error: CARD_ERR } });
    expect(h.status.blocked).toMatchObject({ origin: "https://cdn.jsdelivr.net", csp: false });
  });

  it("the worker's securitypolicyviolation (posted as `csp`) makes it a confirmed CSP block", () => {
    const { h, w } = host();
    w.emit({ type: "csp", violation: { blockedURI: CARD, directive: "connect-src" } });
    w.emit({ type: "status", status: { state: "error", error: CARD_ERR } });
    expect(h.status.blocked).toEqual({ url: CARD, origin: "https://cdn.jsdelivr.net", csp: true, directive: "connect-src" });
  });

  it("other errors stay without `blocked`", () => {
    const { h, w } = host();
    w.emit({ type: "status", status: { state: "error", error: `download failed: HTTP 404 for ${CARD}` } });
    expect(h.status.blocked).toBeUndefined();
  });
});

describe("runtime warning", () => {
  class StatusDecider implements DecisionProvider {
    status: ModelStatus = { state: "loading" };
    private fns = new Set<(s: ModelStatus) => void>();
    ready = () => Promise.resolve();
    evaluate = () => Promise.reject(new Error("no model"));
    onStatus(fn: (s: ModelStatus) => void) {
      this.fns.add(fn);
      return () => this.fns.delete(fn);
    }
    set(s: ModelStatus) {
      this.status = s;
      for (const f of this.fns) f(s);
    }
  }
  const run = () => {
    const clock = new FakeClock();
    const warn: string[] = [];
    const info: string[] = [];
    const con = { warn: (...a: unknown[]) => warn.push(a.join(" ")), info: (...a: unknown[]) => info.push(a.join(" ")), log: (...a: unknown[]) => info.push(a.join(" ")), debug() {}, error() {}, groupCollapsed() {}, groupEnd() {} };
    const decider = new StatusDecider();
    createRuntime({ clock, global: makeGlobal(new FakeServer(clock), { console: con }), decider, report: (r) => info.push(r.message), telemetry: false });
    return { decider, warn, info };
  };

  it("a blocked model download prints ONE warning naming the origin and the fix (and no bare 'Model unavailable')", () => {
    const { decider, warn, info } = run();
    const blocked = { url: CARD, origin: "https://cdn.jsdelivr.net", csp: true, directive: "connect-src" };
    decider.set({ state: "error", error: CARD_ERR, blocked });
    decider.set({ state: "error", error: CARD_ERR, blocked }); // a retry fails the same way
    expect(warn.length).toBe(1);
    expect(warn[0]).toContain("[GenClass] The model could not load: https://cdn.jsdelivr.net was blocked by this page's Content-Security-Policy (connect-src)");
    expect(warn[0]).toContain("fetch-model");
    expect(info.join("\n")).not.toContain("Model unavailable");
  });

  it("other load errors keep the 'Model unavailable' status line and no warning", () => {
    const { decider, warn, info } = run();
    decider.set({ state: "error", error: "bad model" });
    expect(warn).toEqual([]);
    expect(info.join("\n")).toContain("Model unavailable (bad model); observing only.");
  });
});
