// Probe Chromium event-loop facts the harness relies on (run on the VM).
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<html><body><div id=app>hi</div></body></html>");
const r = await page.evaluate(async () => {
  const out = {};
  const ch = new MessageChannel();
  let wake = null;
  ch.port1.onmessage = () => { const w = wake; wake = null; w && w(); };
  const yieldTask = () => new Promise((r) => { wake = r; ch.port2.postMessage(null); });
  // 1. Response.json resolves before the next task?
  for (const kind of ["json", "text", "arrayBuffer", "clone-json", "blob"]) {
    let done = false;
    const res = new Response('{"a":1}', { status: 200, headers: { "content-type": "application/json" } });
    let p;
    if (kind === "clone-json") p = res.clone().json(); else p = res[kind]();
    p.then(() => (done = true));
    await yieldTask();
    let n = 1;
    while (!done && n < 50) { await yieldTask(); n++; }
    out["tasks_" + kind] = n;
  }
  // 2. yield throughput
  const t0 = performance.now();
  for (let i = 0; i < 20000; i++) await yieldTask();
  out.yield_us = ((performance.now() - t0) / 20000) * 1000;
  // 3. microtask chain fully drained before next task
  let depth = 0; let reached = 0;
  const chain = (k) => { if (k > 0) Promise.resolve().then(() => { depth++; chain(k - 1); }); };
  chain(500); await yieldTask(); reached = depth; out.microtask_chain_drained = reached === 500;
  // 4. body reading via getReader
  { let done = false; const res = new Response("x".repeat(1000)); const rd = res.body.getReader();
    (async () => { while (!(await rd.read()).done); done = true; })(); let n = 0; while (!done && n < 50) { await yieldTask(); n++; } out.tasks_reader = n; }
  // 5. Blob arrayBuffer
  { let done = false; new Blob(["abc"]).arrayBuffer().then(() => (done = true)); let n = 0; while (!done && n < 50) { await yieldTask(); n++; } out.tasks_blob_ab = n; }
  // 6. structuredClone + TextEncoder sync ok
  out.ua = navigator.userAgent;
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
