// CDN module-worker entry (dist/cdn/worker.js). Owner: INSTALL.
//
// Browsers refuse `new Worker(<cross-origin URL>)`, so the script-tag build starts the model worker from a
// same-origin Blob URL whose only line is `import "<cdn>/dist/cdn/worker.js";` (a module worker may import
// cross-origin modules over CORS; jsDelivr and unpkg send `Access-Control-Allow-Origin: *`). This entry is the
// regular worker (src/model/worker.ts) with onnxruntime-web bundled in through src/cdn/ort-*.ts (tsup.config.ts maps
// the worker's `import("onnxruntime-web/...")` to them), so nothing needs a bare-specifier resolution.

import "../model/worker.js";
import { cdnState } from "./ort-env.js";

(globalThis as { addEventListener?: (t: string, fn: (ev: MessageEvent) => void) => void }).addEventListener?.("message", (ev) => {
  const m = ev.data as { type?: string; options?: { ortWasmPaths?: string } } | null;
  if (m && m.type === "load" && m.options) cdnState.ortWasmPaths = m.options.ortWasmPaths;
});
