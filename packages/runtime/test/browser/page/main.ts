// Test app for the browser tests: drives the BUILT library (aliased as "genclass-dist" by build.mjs) and exposes a
// small API on window.GC for Playwright.
// @ts-nocheck
import { createModelHost } from "genclass-dist";

const events = [];
let host = null;
let t0 = 0;

function installFakeGpu(kind) {
  // A WebGPU adapter that advertises features but cannot create a device: exercises the webgpu -> wasm fallback.
  const adapter = {
    features: new Set(kind === "f16" ? ["shader-f16"] : []),
    limits: {},
    info: { isFallbackAdapter: false },
    requestDevice: async () => {
      throw new Error("fake adapter: no device");
    },
    requestAdapterInfo: async () => ({}),
  };
  Object.defineProperty(navigator, "gpu", { configurable: true, value: { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => "bgra8unorm" } });
}

window.GC = {
  create(opts = {}) {
    const o = { ...opts };
    if (o.mockGpu) installFakeGpu(o.mockGpu);
    delete o.mockGpu;
    if (o.workerUrl) {
      const url = o.workerUrl;
      o.workerFactory = () => new Worker(url, { type: "module" });
      delete o.workerUrl;
    }
    if (o.noWorkerGlobal) {
      // simulate a page where Worker is unavailable
      // eslint-disable-next-line no-global-assign
      window.Worker = undefined;
      delete o.noWorkerGlobal;
    }
    t0 = performance.now();
    host = createModelHost(o);
    events.length = 0;
    events.push({ t: 0, status: host.status });
    host.onStatus((s) => events.push({ t: performance.now() - t0, status: JSON.parse(JSON.stringify(s)) }));
    document.getElementById("state").textContent = "created";
    return host.status;
  },
  async ready() {
    await host.ready();
    return { wallMs: performance.now() - t0, status: host.status };
  },
  async load() {
    await host.load();
    return { wallMs: performance.now() - t0, status: host.status };
  },
  status: () => host.status,
  stats: () => host.stats,
  events: () => events,
  async evaluate(req) {
    try {
      return { ok: true, answers: await host.evaluate(req) };
    } catch (e) {
      return { ok: false, error: { name: e.name, code: e.code, message: e.message } };
    }
  },
  async evaluateDetailed(req) {
    const t = performance.now();
    try {
      const r = await host.evaluateDetailed(req);
      return { ok: true, wallMs: performance.now() - t, ...r };
    } catch (e) {
      return { ok: false, wallMs: performance.now() - t, error: { name: e.name, code: e.code, message: e.message } };
    }
  },
  async measure(state, questions) {
    return host.measure(state, questions);
  },
  async bench(req, n) {
    const forward = [];
    const wall = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      const r = await host.evaluateDetailed({ ...req, timeoutMs: 120000 });
      wall.push(performance.now() - t);
      forward.push(r.timings.forward);
    }
    return { forward, wall, usage: (await host.evaluateDetailed({ ...req, timeoutMs: 120000 })).usage };
  },
  dispose() {
    host?.dispose();
  },
  async cacheKeys(name = "genclass-runtime-v1") {
    const c = await caches.open(name);
    return (await c.keys()).map((r) => r.url);
  },
  isolated: () => self.crossOriginIsolated,
};
document.getElementById("state").textContent = "ready";
