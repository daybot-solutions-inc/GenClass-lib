# @genclass/runtime-model

The local decision model of [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime): a 17M-parameter
GenClass encoder that reads what the runtime observed in your app (a *situation*) and answers typed questions about
it: what is going on (`expected`, `stale`, `duplicate`, `failing`, ...) and which generic action fits. It runs in
the browser with onnxruntime-web, in a Web Worker, on WebGPU or WASM. Nothing leaves the page.

**You don't need to install this package.** The runtime loads it from jsDelivr when the browser is idle after page
load, and caches it in Cache Storage. This is the default model URL:

```
https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.2.0/files/
```

## Files

`files/model.json` lists every file with its size and sha256. The runtime checks both before using a file.

| file | size | used for |
|---|---|---|
| `files/model.json` | 1 KB | the model card the runtime reads first (`genclass-runtime-model/1`) |
| `files/genclass-runtime-r17-q8.onnx` | 10.2 MB | WASM, and WebGPU without `shader-f16`. 8-bit weights, int8 embeddings |
| `files/genclass-runtime-r17-fp16.onnx` | 13.6 MB | WebGPU with `shader-f16` |
| `files/tokenizer.json` | 1.1 MB | byte-level BPE, 16,364 tokens |
| `files/calibration.json` | 1 KB | per-question-kind temperatures |
| `files/meta.json` | 2 KB | graph inputs and outputs, and the action and detection thresholds |

A browser downloads `model.json`, the tokenizer, the calibration, the meta file and **one** of the two `.onnx` files:
about 11 MB on WASM. onnxruntime-web's wasm (3.1 MB brotli) comes from jsDelivr's `onnxruntime-web` package.

Model: `genclass-runtime-r17` 2.0.0-rc4t (training run `r17-v2dT`). `model.json` sha256 `3f79289280dc11e4284b04d63a505e3cac9e77b3dc06a981cd4686c880169daf`. Its `meta.json` gate is a gain gate with three aggressiveness profiles (`cautious`, `balanced`, `eager`), chosen with `GenClass.init({ aggressiveness })` in `@genclass/runtime` 0.1.0-beta.1 and later.

## Self-hosting

To serve the model yourself (offline apps, strict CSP, no third-party CDN):

```bash
npm install @genclass/runtime-model
cp -r node_modules/@genclass/runtime-model/files public/genclass-model
```

```ts
GenClass.init({ model: { baseUrl: "/genclass-model/" } });
```

Or download it with the runtime's CLI, which verifies every hash:

```bash
npx @genclass/runtime fetch-model public/genclass-model --from https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.2.0/files/
```

With the script tag, use `data-model="/genclass-model/"`.

## What it can and can't do

See [MODEL_CARD.md](MODEL_CARD.md) for the training data, held-out results, thresholds and limits. In short:

- **It acts rarely, by design.** It acts only when it is very sure. At the shipped thresholds, the false-intervention
  rate is 0.00% on held-out real apps and at most 0.23% on simulated apps.
- **In observe mode it reports.** On real apps it was never trained on, it reports about 76% of duplicate submits
  and 28% of stale overwrites, with 0.36% false reports on clean traffic.

## License

Apache-2.0. Trained only on data generated for this project (see the model card).
