// onnxruntime-web's WebGPU execution provider on a real (software) adapter: Chromium's SwiftShader, enabled by the
// "swiftshader-webgpu" project in playwright.config.ts. SwiftShader is a fallback adapter WITHOUT shader-f16, so this
// is also the check that a model runs on WebGPU devices that lack it. Its speed says nothing about real GPUs.
//
// GENCLASS_WEBGPU_VARIANTS: a directory of test-only model variants (test/fixtures/model/make_webgpu_variants.py:
// f32emb = fp32 embedding table, i8emb = int8 table + per-row scale) that isolate the embedding encoding.
import { expect, test } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { HAVE_MODEL, MODEL_DIR, benchSizes, create, evaluate, openApp, parityRun, ready, saveResults, transferReport, useServer } from "./model-helpers.js";

test.describe.configure({ mode: "serial" });
test.skip(!HAVE_MODEL, `no model directory at ${MODEL_DIR} (run genclass-runtime fetch-model)`);

const VARIANTS_DIR = process.env.GENCLASS_WEBGPU_VARIANTS ? resolve(process.env.GENCLASS_WEBGPU_VARIANTS) : "";
const variants: Record<string, string> = {};
if (VARIANTS_DIR && existsSync(VARIANTS_DIR)) {
  for (const d of readdirSync(VARIANTS_DIR)) if (existsSync(join(VARIANTS_DIR, d, "model.json"))) variants[d] = join(VARIANTS_DIR, d);
}
/** Exported runtime models (GENCLASS_BENCH_MODELS="name=dir,..."), e.g. TRAIN's int8-embedding q8. */
const exports: Record<string, string> = Object.fromEntries(
  (process.env.GENCLASS_BENCH_MODELS ?? "")
    .split(",")
    .map((x) => x.split("="))
    .filter(([n, d]) => n && d && existsSync(join(d, "model.json"))),
);

const srv = useServer({ ...variants, ...exports });
const results: Record<string, unknown> = {};
test.afterAll(() => {
  if (Object.keys(results).length) saveResults("latency", { webgpuSwiftshader: results });
});

async function adapterInfo(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const a = await (navigator as any).gpu?.requestAdapter();
    return a ? { fallback: a.info?.isFallbackAdapter, f16: a.features.has("shader-f16"), arch: a.info?.architecture } : null;
  });
}

test("the model directory on a WebGPU adapter without shader-f16: webgpu+q8 runs, or fails on f16 tensors and falls back to WASM", async ({ browser }) => {
  const { page, logs } = await openApp(browser, srv.url);
  const adapter = await adapterInfo(page);
  test.skip(!adapter, "no WebGPU adapter even with SwiftShader");
  srv.clearLog();
  await create(page, { baseUrl: "/model/", device: "webgpu", preload: "eager", ortWasmPaths: "/ort/" });
  const s = await ready(page);
  const summary = { device: s.status.device, variant: s.status.variant, gpu: s.status.gpu, attempts: s.status.attempts };
  console.log(`[webgpu] ${JSON.stringify(adapter)} -> ${JSON.stringify(summary)}`);
  expect(s.status.state).toBe("ready");
  // a WebGPU plan exists: the WebGPU onnxruntime bundle and its asyncify wasm (which also runs the WASM fallback)
  expect(s.status.ortBuild).toBe("webgpu");
  expect(srv.served(/\/ort\/ort-wasm-simd-threaded\.asyncify\.wasm$/)).toBe(1);
  expect(srv.served(/\/ort\/ort-wasm-simd-threaded\.wasm$/)).toBe(0);
  const transfer = transferReport(srv.paths());
  console.log(`[transfer webgpu path] runtime ${JSON.stringify(transfer.totals.runtime)} model ${JSON.stringify(transfer.totals.model)}`);
  saveResults("transfer", { webgpuPath: transfer });
  if (s.status.device === "webgpu") {
    const par = await parityRun(page, [0, 13, 29, 49]);
    expect(par.agree).toBeGreaterThanOrEqual(par.total - 1);
    results.model = { ...summary, parity: par };
  } else {
    // the v0.1 q8 export stores its embedding table in fp16: WebGPU needs shader-f16 for that Gather
    expect(s.status.device).toBe("wasm");
    expect(s.status.attempts?.[0]?.device).toBe("webgpu");
    expect(String(s.status.attempts?.[0]?.error)).toMatch(/f16/);
    results.model = { ...summary, note: "webgpu+q8 needs shader-f16 with this model (fp16 tensors); fell back to wasm" };
  }
  expect(logs.filter((l) => l.startsWith("[pageerror]"))).toEqual([]);
  await page.context().close();
});

for (const name of Object.keys(variants).sort()) {
  test(`embedding encoding "${name}": webgpu+q8 (MatMulNBits) on a WebGPU adapter without shader-f16`, async ({ browser }) => {
    const { page } = await openApp(browser, srv.url);
    test.skip(!(await adapterInfo(page)), "no WebGPU adapter");
    await create(page, { baseUrl: `/m/${name}/`, device: "webgpu", preload: "eager", ortWasmPaths: "/ort/" });
    const s = await ready(page);
    const summary = { device: s.status.device, attempts: s.status.attempts, loadMs: s.status.loadMs, warmupMs: s.status.warmupMs, bytes: s.status.bytes };
    console.log(`[webgpu ${name}] ${JSON.stringify(summary)}`);
    expect(s.status.state).toBe("ready");
    const par = await parityRun(page, [0, 13, 29, 49]);
    console.log(`[webgpu ${name}] parity on ${s.status.device}: agree ${par.agree}/${par.total}, max |dp| ${par.maxProb.toFixed(4)}`);
    const out: Record<string, unknown> = { ...summary, parity: par };
    if (s.status.device === "webgpu") Object.assign(out, await benchSizes(page, `webgpu ${name} (SwiftShader, software)`, 3));
    results[name] = out;
    if (name === "f32emb") {
      // fp32 table: nothing in the graph needs f16, so MatMulNBits 8-bit must run on WebGPU
      expect(s.status.device).toBe("webgpu");
    }
    expect(par.agree).toBeGreaterThanOrEqual(par.total - 2);
    await page.context().close();
  });
}

for (const name of Object.keys(exports).sort()) {
  test(`exported model "${name}": its q8 runs on WebGPU without shader-f16 and answers`, async ({ browser }) => {
    const { page } = await openApp(browser, srv.url);
    test.skip(!(await adapterInfo(page)), "no WebGPU adapter");
    await create(page, { baseUrl: `/m/${name}/`, device: "webgpu", preload: "eager", ortWasmPaths: "/ort/" });
    const s = await ready(page);
    const summary = { model: `${s.status.model}@${s.status.version}`, device: s.status.device, variant: s.status.variant, attempts: s.status.attempts, bytes: s.status.bytes, loadMs: s.status.loadMs, warmupMs: s.status.warmupMs, latency: s.status.latency };
    console.log(`[webgpu ${name}] ${JSON.stringify(summary)}`);
    expect(s.status).toMatchObject({ state: "ready", device: "webgpu", variant: "q8" }); // fp16 skipped: no shader-f16
    const r = await evaluate(page, { trigger: "ask", state: { app: "Shop", trigger: "a write" }, questions: { d: { type: "choice", instructions: "What is going on?", criteria: { expected: "fine", stale: "older data" } } } });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    results[`export:${name}`] = summary;
    await page.context().close();
  });
}

test("auto skips a software adapter and runs on WASM", async ({ browser }) => {
  const { page } = await openApp(browser, srv.url);
  test.skip(!(await adapterInfo(page)), "no WebGPU adapter");
  await create(page, { baseUrl: "/model/", device: "auto", preload: "eager", ortWasmPaths: "/ort/" });
  const s = await ready(page);
  expect(s.status).toMatchObject({ state: "ready", device: "wasm", variant: "q8" });
  expect(s.status.gpu).toContain("software");
  await page.context().close();
});
