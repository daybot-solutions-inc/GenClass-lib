// onnxruntime-web (WASM-only bundle) for the CDN worker and the script tag's inline fallback (dist/cdn/ort-wasm.js).
import * as ort from "onnxruntime-web/wasm";
import { prepareOrt } from "./ort-env.js";

prepareOrt(ort.env as never, "ort-wasm-simd-threaded.mjs");

export * from "onnxruntime-web/wasm";
