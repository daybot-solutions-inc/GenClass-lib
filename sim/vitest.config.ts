import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 600000, // the 40-trajectory row test takes ~45 s alone and longer on a busy shared VM
    hookTimeout: 120000,
    pool: "forks",
  },
});
