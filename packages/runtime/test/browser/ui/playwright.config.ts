// Playwright config for the UI workstream's browser specs (test/browser/ui-*.spec.ts): devtools screenshots
// and real-browser checks. Run on the VM:
//   npx playwright test --config packages/runtime/test/browser/ui/playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "..",
  testMatch: /ui-.*\.spec\.ts$/,
  outputDir: "../../../test-results/ui",
  reporter: [["list"]],
  timeout: 90_000,
  workers: 1,
  use: {
    browserName: "chromium",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  },
});
