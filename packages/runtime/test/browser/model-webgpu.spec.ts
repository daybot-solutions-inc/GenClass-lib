// onnxruntime-web's WebGPU execution provider on a real (software) adapter: Chromium's SwiftShader, enabled by the
// "swiftshader-webgpu" project in playwright.config.ts. SwiftShader is a fallback adapter without shader-f16, so this
// covers the webgpu+q8 plan (MatMulNBits on WebGPU) and the "auto" rule that skips software adapters. Its speed
// says nothing about real GPUs.
import { expect, test } from "@playwright/test";
import { HAVE_MODEL, MODEL_DIR, benchSizes, create, openApp, parityRun, ready, saveResults, useServer } from "./model-helpers.js";

test.describe.configure({ mode: "serial" });
test.skip(!HAVE_MODEL, `no model directory at ${MODEL_DIR} (run genclass-runtime fetch-model)`);

const srv = useServer();

test("webgpu+q8 runs on a WebGPU adapter in the worker and matches PyTorch", async ({ browser }) => {
  const { page, logs } = await openApp(browser, srv.url);
  const adapter = await page.evaluate(async () => {
    const a = await (navigator as any).gpu?.requestAdapter();
    return a ? { fallback: a.info?.isFallbackAdapter, f16: a.features.has("shader-f16"), arch: a.info?.architecture } : null;
  });
  test.skip(!adapter, "no WebGPU adapter even with SwiftShader");
  console.log(`[webgpu] adapter: ${JSON.stringify(adapter)}`);
  await create(page, { baseUrl: "/model/", device: "webgpu", preload: "eager", ortWasmPaths: "/ort/" });
  const s = await ready(page);
  console.log(`[webgpu] status: ${JSON.stringify({ device: s.status.device, variant: s.status.variant, gpu: s.status.gpu, attempts: s.status.attempts, loadMs: s.status.loadMs, warmupMs: s.status.warmupMs })}`);
  expect(s.status).toMatchObject({ state: "ready", device: "webgpu", variant: "q8", worker: true });
  const par = await parityRun(page, [0, 13, 29, 49]);
  console.log(`[browser parity q8/webgpu] agree ${par.agree}/${par.total}, max |dp| ${par.maxProb.toFixed(4)}`);
  expect(par.agree).toBeGreaterThanOrEqual(par.total - 1);
  expect(par.maxProb).toBeLessThan(0.06);
  saveResults("latency", { webgpuSwiftshader: { adapter, parity: par, loadMs: s.status.loadMs, warmupMs: s.status.warmupMs, ...(await benchSizes(page, "webgpu (SwiftShader, software)", 3)) } });
  expect(logs.filter((l) => l.startsWith("[pageerror]"))).toEqual([]);
  await page.context().close();
});

test("auto skips a software adapter and runs on WASM", async ({ browser }) => {
  const { page } = await openApp(browser, srv.url);
  await create(page, { baseUrl: "/model/", device: "auto", preload: "eager", ortWasmPaths: "/ort/" });
  const s = await ready(page);
  expect(s.status).toMatchObject({ state: "ready", device: "wasm", variant: "q8" });
  expect(s.status.gpu).toContain("software");
  await page.context().close();
});
