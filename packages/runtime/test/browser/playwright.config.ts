import { defineConfig } from "@playwright/test";

// Headless Chromium on the VM (no GPU: WebGPU code paths are exercised through their fallbacks).
// GENCLASS_MODEL_DIR: a model directory from `genclass-runtime fetch-model` (default <repo>/.cache-model).
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  globalSetup: "./build.mjs",
  timeout: 600_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "../../test-results/browser",
  use: { browserName: "chromium", headless: true },
  projects: [
    { name: "chromium", testIgnore: /webgpu\.spec\.ts$/ },
    {
      // A real (software) WebGPU adapter: SwiftShader. No shader-f16, so this covers webgpu+q8.
      name: "swiftshader-webgpu",
      testMatch: /webgpu\.spec\.ts$/,
      use: { launchOptions: { args: ["--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-webgpu-adapter=swiftshader"] } },
    },
  ],
});
