// Debug helper: open a built template (already served at URL) and print every console line plus GenClass globals.
//   node compat/scripts/debug-template.mjs http://127.0.0.1:4173/
import { chromium } from "@playwright/test";
import { join } from "node:path";

const MODEL = process.env.COMPAT_MODEL_DIR || "/data/compat/model/runtime-model-0.2.0";
const url = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.route((u) => u.hostname !== "127.0.0.1", (r) => {
  const u = new URL(r.request().url());
  let m;
  if ((m = /^\/npm\/@genclass\/runtime-model@[^/]+\/files\/(.+)$/.exec(u.pathname))) return r.fulfill({ path: join(MODEL, m[1]) });
  if ((m = /^\/npm\/onnxruntime-web@[^/]+\/dist\/(.+)$/.exec(u.pathname))) return r.fulfill({ path: join(MODEL, "ort", m[1]) });
  return r.abort();
});
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("genclass.telemetry", "off");
  } catch {}
});
const page = await ctx.newPage();
page.on("console", (m) => console.log(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on("worker", (w) => console.log(`[worker] ${w.url()}`));
await page.goto(url);
await new Promise((r) => setTimeout(r, 2500));
console.log("--- typing");
await page.click("input");
await page.keyboard.type("san", { delay: 60 });
await new Promise((r) => setTimeout(r, 2500));
console.log(await page.evaluate(() => ({ fetch: String(window.fetch).slice(0, 120), workers: performance.getEntriesByType("resource").filter((e) => /worker|onnx|model/.test(e.name)).map((e) => e.name.replace(/^.*\//, "")) })));
await browser.close();
