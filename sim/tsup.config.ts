import { defineConfig } from "tsup";

export default defineConfig({
  entry: { gen: "src/gen.ts", worker: "src/gen/worker.ts", index: "src/index.ts", smoke: "src/dev/smoke.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: false,
  external: ["@genclass/runtime"],
  banner: { js: "" },
});
