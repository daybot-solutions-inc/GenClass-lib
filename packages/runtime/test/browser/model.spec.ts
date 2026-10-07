// The model host in headless Chromium, against the BUILT library and a real model directory (v0.1 GenClass ONNX
// until the runtime model ships): worker load over WASM, PyTorch parity, Cache Storage on the second load, inline
// fallbacks, lazy/idle preload, WebGPU fallbacks, status events, and latency numbers.
import { expect, test } from "@playwright/test";
import {
  HAVE_MODEL,
  MODEL_DIR,
  benchSizes,
  card,
  compare,
  create,
  evaluate,
  evaluateDetailed,
  events,
  fixtureRequest,
  openApp,
  parityRun,
  ready,
  saveResults,
  statusOf,
  useServer,
} from "./model-helpers.js";

test.describe.configure({ mode: "serial" });
test.skip(!HAVE_MODEL, `no model directory at ${MODEL_DIR} (run genclass-runtime fetch-model)`);

const srv = useServer();
const q8File = () => card.variants.q8.file as string;

test("loads over WASM in a module worker, matches PyTorch, reports status, and the second load comes from Cache Storage", async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page, logs } = await openApp(browser, srv.url, { context: ctx });
  srv.clearLog();
  await create(page, { baseUrl: "/model/", device: "wasm", preload: "eager", ortWasmPaths: "/ort/" });
  const cold = await ready(page);
  expect(cold.status).toMatchObject({ state: "ready", device: "wasm", variant: "q8", worker: true, fromCache: false, threads: 1, model: card.name, version: card.version });
  expect(cold.status.bytes).toBe(card.variants.q8.bytes);
  expect(srv.served(new RegExp(`/model/${q8File()}$`))).toBe(1);
  expect(srv.served(/\/ort\/ort-wasm-simd-threaded\.asyncify\.wasm$/)).toBe(1);
  expect(srv.served(/\/model\/genclass-fp16/)).toBe(0);

  // status events: loading phases, monotonic progress up to the full size, then ready
  const ev = await events(page);
  expect(ev.at(-1).status.state).toBe("ready");
  const phases = [...new Set(ev.map((e: any) => e.status.phase).filter(Boolean))];
  expect(phases).toEqual(["card", "download", "runtime", "session", "warmup"]);
  const prog = ev.filter((e: any) => e.status.progress).map((e: any) => e.status.progress);
  expect(prog.length).toBeGreaterThan(2);
  for (let k = 1; k < prog.length; k++) expect(prog[k].loaded).toBeGreaterThanOrEqual(prog[k - 1].loaded);
  expect(prog.at(-1).loaded).toBe(prog.at(-1).total);

  // parity with PyTorch on several requests
  const par = await parityRun(page);
  console.log(`[browser parity q8/wasm] agree ${par.agree}/${par.total}, max |dp| ${par.maxProb.toFixed(4)}`);
  // q8 (8-bit weights) vs fp32 PyTorch: the export measured 502/503 decisions and max |dp| 0.045 over the 50
  // requests; near-ties can flip, so allow one flip here.
  expect(par.agree).toBeGreaterThanOrEqual(par.total - 1);
  expect(par.maxProb).toBeLessThan(0.06);

  // second load in the same browser profile: Cache Storage, no network for the model or the ORT wasm
  const keys = await page.evaluate(() => (window as any).GC.cacheKeys());
  expect(keys.some((k: string) => k.endsWith(q8File()))).toBe(true);
  await page.evaluate(() => (window as any).GC.dispose());
  const { page: page2 } = await openApp(browser, srv.url, { context: ctx });
  srv.clearLog();
  await create(page2, { baseUrl: "/model/", device: "wasm", preload: "eager", ortWasmPaths: "/ort/" });
  const warm = await ready(page2);
  expect(warm.status).toMatchObject({ state: "ready", fromCache: true, device: "wasm", variant: "q8" });
  expect(srv.served(/\.onnx$/)).toBe(0);
  expect(srv.served(/\.wasm$/)).toBe(0);
  expect(srv.served(/\/model\/tokenizer\.json$/)).toBe(0);
  expect(srv.served(/\/model\/model\.json$/)).toBe(1); // the card is revalidated
  const r = await evaluate(page2, fixtureRequest(0));
  expect(compare(0, r.answers).agree).toBe(compare(0, r.answers).total);
  saveResults("latency", {
    parity: { variant: "q8", device: "wasm", ...par },
    load: {
      note: "model (57 MB) + ORT wasm (27 MB) served from localhost; real cold loads add the download time",
      cold: { wallMs: Math.round(cold.wallMs), loadMs: cold.status.loadMs, warmupMs: cold.status.warmupMs },
      cached: { wallMs: Math.round(warm.wallMs), loadMs: warm.status.loadMs, warmupMs: warm.status.warmupMs },
    },
  });
  console.log(`[browser load] cold ${Math.round(cold.wallMs)} ms (warm-up ${cold.status.warmupMs} ms), cached ${Math.round(warm.wallMs)} ms (warm-up ${warm.status.warmupMs} ms)`);
  expect(logs.filter((l) => l.startsWith("[pageerror]"))).toEqual([]);
  await ctx.close();
});

test("inline fallback: no Worker global, and a worker script that fails to load", async ({ browser }) => {
  {
    const { page } = await openApp(browser, srv.url);
    await create(page, { baseUrl: "/model/", device: "wasm", preload: "eager", ortWasmPaths: "/ort/", noWorkerGlobal: true });
    const s = await ready(page);
    expect(s.status).toMatchObject({ state: "ready", worker: false, device: "wasm" });
    const r = await evaluate(page, fixtureRequest(5));
    const c = compare(5, r.answers);
    expect(c.agree).toBe(c.total);
    await page.context().close();
  }
  {
    const { page, logs } = await openApp(browser, srv.url);
    await create(page, { baseUrl: "/model/", device: "wasm", preload: "eager", ortWasmPaths: "/ort/", workerUrl: "/app/missing-worker.js" });
    const s = await ready(page);
    expect(s.status).toMatchObject({ state: "ready", worker: false });
    expect(s.status.workerError).toBeTruthy();
    const r = await evaluate(page, fixtureRequest(9));
    expect(r.ok).toBe(true);
    // the failed worker never reaches the page's error handlers
    expect(logs.filter((l) => l.startsWith("[pageerror]"))).toEqual([]);
    await page.context().close();
  }
});

test("lazy preload: a decision before the model is ready fails open at once; ready() loads it", async ({ browser }) => {
  const { page } = await openApp(browser, srv.url);
  srv.clearLog();
  await create(page, { baseUrl: "/model/", device: "wasm", preload: "lazy", ortWasmPaths: "/ort/" });
  await page.waitForTimeout(500);
  expect(srv.served(/\/model\//)).toBe(0); // nothing downloads until needed
  const r = await evaluateDetailed(page, fixtureRequest(1));
  expect(r.ok).toBe(false);
  expect(r.error.code).toBe("not_ready");
  expect(r.wallMs).toBeLessThan(50);
  expect((await statusOf(page)).state).toBe("loading");
  const s = await ready(page);
  expect(s.status.state).toBe("ready");
  const ok = await evaluate(page, fixtureRequest(1));
  expect(ok.ok).toBe(true);
  await page.context().close();
});

test("idle preload starts after the page load, without any call", async ({ browser }) => {
  const { page } = await openApp(browser, srv.url);
  await create(page, { baseUrl: "/model/", device: "wasm", preload: "idle", ortWasmPaths: "/ort/" });
  await expect.poll(async () => (await statusOf(page)).state, { timeout: 120_000 }).toBe("ready");
  await page.context().close();
});

test("WebGPU paths: no adapter -> wasm; an adapter that cannot make a device is caught by the probe -> wasm", async ({ browser }) => {
  {
    const { page } = await openApp(browser, srv.url);
    const gpu = await page.evaluate(async () => {
      const g = (navigator as any).gpu;
      if (!g) return "no navigator.gpu";
      const a = await g.requestAdapter();
      return a ? `adapter (fallback=${a.info?.isFallbackAdapter})` : "requestAdapter() = null";
    });
    console.log(`[webgpu] headless Chromium on the VM (no flags): ${gpu}`);
    await create(page, { baseUrl: "/model/", device: "webgpu", preload: "eager", ortWasmPaths: "/ort/" });
    const s = await ready(page);
    expect(s.status).toMatchObject({ state: "ready", device: "wasm", variant: "q8" });
    expect(s.status.gpu).toBeTruthy(); // why WebGPU was not used, for devtools
    console.log(`[webgpu] status.gpu in the worker: ${s.status.gpu}`);
    await page.context().close();
  }
  {
    const { page } = await openApp(browser, srv.url);
    await create(page, { baseUrl: "/model/", device: "auto", preload: "eager", ortWasmPaths: "/ort/", worker: false, mockGpu: "f16" });
    const s = await ready(page);
    expect(s.status).toMatchObject({ state: "ready", device: "wasm", variant: "q8", worker: false });
    expect(s.status.gpu).toContain("no device");
    expect(s.status.attempts).toBeUndefined(); // onnxruntime never saw the broken adapter
    console.log(`[webgpu] mocked adapter: ${s.status.gpu}`);
    await page.context().close();
  }
});

test("latency: single-threaded WASM (q8), warm forward for ~600- and ~1,000-token states", async ({ browser }) => {
  const { page } = await openApp(browser, srv.url);
  await create(page, { baseUrl: "/model/", device: "wasm", preload: "eager", ortWasmPaths: "/ort/" });
  const s = await ready(page);
  expect(s.status.threads).toBe(1);
  saveResults("latency", { wasm1: { threads: 1, ...(await benchSizes(page, "wasm x1")) } });
  await page.context().close();
});

test("latency: crossOriginIsolated page, 4 WASM threads", async ({ browser }) => {
  const { page, logs } = await openApp(browser, srv.url, { coi: true });
  expect(await page.evaluate(() => (window as any).GC.isolated())).toBe(true);
  await create(page, { baseUrl: "/coi/model/", device: "wasm", preload: "eager", ortWasmPaths: "/coi/ort/" });
  const s = await ready(page);
  expect(s.status).toMatchObject({ state: "ready", threads: 4 });
  saveResults("latency", { wasm4: { threads: 4, ...(await benchSizes(page, "wasm x4 (crossOriginIsolated)")) } });
  expect(logs.filter((l) => l.startsWith("[pageerror]"))).toEqual([]);
  await page.context().close();
});

test("default ORT wasm path: jsDelivr for the installed onnxruntime-web version", async ({ browser }) => {
  test.skip(!!process.env.GENCLASS_OFFLINE, "offline");
  const { page } = await openApp(browser, srv.url);
  srv.clearLog();
  await create(page, { baseUrl: "/model/", device: "wasm", preload: "eager" });
  const s = await ready(page);
  expect(s.status.state).toBe("ready");
  expect(srv.served(/\/ort\//)).toBe(0);
  const keys = await page.evaluate(() => (window as any).GC.cacheKeys());
  expect(keys.some((k: string) => /^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@1\.30\.\d+\/dist\/ort-wasm-simd-threaded\.asyncify\.wasm$/.test(k))).toBe(true);
  await page.context().close();
});
