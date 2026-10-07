import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/react": "src/adapters/react.ts",
    "adapters/redux": "src/adapters/redux.ts",
    "adapters/zustand": "src/adapters/zustand.ts",
    "devtools/index": "src/devtools/index.ts",
    worker: "src/model/worker.ts",
  },
  format: ["esm"],
  dts: { entry: ["src/index.ts", "src/adapters/react.ts", "src/adapters/redux.ts", "src/adapters/zustand.ts", "src/devtools/index.ts"] },
  target: "es2022",
  platform: "browser",
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: ["onnxruntime-web", "onnxruntime-web/webgpu", "react", "redux", "zustand"],
});
