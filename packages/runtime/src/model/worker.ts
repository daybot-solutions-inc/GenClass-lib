// Module Worker entry (built as dist/worker.js): runs the model backend off the main thread. The host creates it
// with `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })` and talks to it with the messages
// in protocol.ts.
//
// onnxruntime-web is imported dynamically once the WebGPU probe has run: onnxruntime-web/wasm (3.1 MB brotli wasm)
// when no WebGPU plan will be tried, onnxruntime-web/webgpu (5.5 MB) otherwise. Both specifiers are static strings,
// so bundlers emit each as its own chunk and a page only downloads the one it uses.
//
// When the page is crossOriginIsolated, ORT starts WASM threads as workers of the script that holds ORT (emscripten
// pthreads, named "em-pthread*"); if that is this script, the model host must stay out of the way.

import { browserClock } from "../clock.js";
import { ModelBackend, type OrtBuild } from "./backend.js";
import type { OrtLike } from "./engine.js";
import { serializeError } from "./errors.js";
import type { FromWorker, ToWorker } from "./protocol.js";

interface WorkerScope {
  name?: string;
  postMessage(m: FromWorker): void;
  addEventListener(type: "message", fn: (ev: MessageEvent<ToWorker>) => void): void;
  close(): void;
  fetch: typeof fetch;
  caches?: CacheStorage;
}

const scope = globalThis as unknown as WorkerScope;
const isOrtThread = typeof scope.name === "string" && (scope.name.startsWith("em-pthread") || scope.name === "ort-wasm-proxy-worker");

if (!isOrtThread) {
  const post = (m: FromWorker) => scope.postMessage(m);

  let cachesRef: CacheStorage | null = null;
  try {
    cachesRef = scope.caches ?? null; // throws in some opaque-origin / privacy contexts
  } catch {
    cachesRef = null;
  }

  const loadOrt = async (build: OrtBuild): Promise<OrtLike> =>
    (build === "webgpu" ? await import("onnxruntime-web/webgpu") : await import("onnxruntime-web/wasm")) as unknown as OrtLike;

  const backend = new ModelBackend({
    ort: loadOrt,
    fetch: scope.fetch.bind(scope),
    caches: cachesRef,
    clock: browserClock,
    emit: (status) => post({ type: "status", status }),
    inWorker: true,
  });

  scope.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || typeof m !== "object") return;
    switch (m.type) {
      case "load":
        backend.load(m.options).catch(() => undefined); // the failure is reported through status
        break;
      case "evaluate":
        backend.evaluate(m.state, m.questions).then(
          (r) => post({ type: "result", id: m.id, ok: true, value: { answers: r.answers, model: r.model, usage: r.usage, timings: r.timings } }),
          (e) => post({ type: "result", id: m.id, ok: false, error: serializeError(e) }),
        );
        break;
      case "measure":
        try {
          post({ type: "result", id: m.id, ok: true, value: backend.measure(m.state, m.questions) });
        } catch (e) {
          post({ type: "result", id: m.id, ok: false, error: serializeError(e) });
        }
        break;
      case "dispose":
        backend.dispose().finally(() => scope.close());
        break;
    }
  });

  post({ type: "hello" });
}
