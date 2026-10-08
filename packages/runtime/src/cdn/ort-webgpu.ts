// onnxruntime-web (WebGPU + WASM bundle) for the CDN worker and the script tag's inline fallback (dist/cdn/ort-webgpu.js).
import * as ort from "onnxruntime-web/webgpu";
import { prepareOrt } from "./ort-env.js";

prepareOrt(ort.env as never, "ort-wasm-simd-threaded.asyncify.mjs");

export * from "onnxruntime-web/webgpu";
