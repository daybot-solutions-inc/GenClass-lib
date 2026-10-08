// Shared by the CDN worker entry and the onnxruntime-web wrappers (dist/cdn/*). Owner: INSTALL.
//
// From a CDN, the worker's onnxruntime-web is cross-origin (its import.meta.url is on the CDN, the worker's origin is
// the page's, via the Blob URL). Single-threaded, ORT then uses its embedded wasm glue because the runtime hands it
// the wasm bytes (env.wasm.wasmBinary). With WASM threads (a crossOriginIsolated page) ORT refuses the embedded glue
// for a cross-origin script and loads `ort-wasm-simd-threaded*.mjs` next to the script, which is not in this
// package: point it at the onnxruntime-web directory the runtime already uses for the wasm (`ortWasmPaths`, else
// jsDelivr), so ORT preloads the glue as a same-origin Blob and can start its pthread workers.

/** Load options the host sent to the worker (captured by src/cdn/worker.ts). */
export const cdnState: { ortWasmPaths?: string } = {};

interface OrtEnvLike {
  wasm: { wasmPaths?: unknown };
  versions?: { web?: string };
}

export function prepareOrt(env: OrtEnvLike, glue: string): void {
  try {
    const g = globalThis as { crossOriginIsolated?: boolean; document?: unknown };
    // The runtime only runs WASM threads in a worker of a crossOriginIsolated page (src/model/backend.ts).
    if (!g.crossOriginIsolated || typeof g.document !== "undefined" || env.wasm.wasmPaths) return;
    const version = env.versions?.web;
    const base = cdnState.ortWasmPaths || (version ? `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/` : "");
    if (base) env.wasm.wasmPaths = { mjs: new URL(glue, base.endsWith("/") ? base : `${base}/`).href };
  } catch {
    /* ORT falls back to its own resolution */
  }
}
