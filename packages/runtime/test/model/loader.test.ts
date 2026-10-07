// Model card, plan order, cached downloads (Cache Storage + sha256 + progress) and the backend load sequence,
// with an in-memory model directory, Cache Storage and onnxruntime.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { browserClock } from "../../src/clock.js";
import { ModelBackend, ORT_WASM_FILES, type ModelHostStatus, type OrtBuild } from "../../src/model/backend.js";
import type { OrtLike } from "../../src/model/engine.js";
import { ModelIntegrityError, ModelLoadError, ModelNotReadyError, ModelUnsupportedError } from "../../src/model/errors.js";
import { fetchCard, fetchFile, parseCard, planOrder, type GpuInfo } from "../../src/model/loader.js";
import { bytesToUnicode } from "../../src/model/tokenizer.js";

// --------------------------------------------------------------------------------------------- fakes

class FakeCache {
  store = new Map<string, Response>();
  failPut = false;
  async match(url: string): Promise<Response | undefined> {
    return this.store.get(url)?.clone();
  }
  async put(url: string, res: Response): Promise<void> {
    if (this.failPut) throw new DOMException("quota", "QuotaExceededError");
    this.store.set(url, new Response(await res.arrayBuffer(), { headers: res.headers, status: res.status }));
  }
  async delete(url: string): Promise<boolean> {
    return this.store.delete(url);
  }
}
class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let c = this.caches.get(name);
    if (!c) this.caches.set(name, (c = new FakeCache()));
    return c;
  }
}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const enc = new TextEncoder();

/** An in-memory model directory served by a fake fetch that logs every request. */
function modelDir(opts: { onnxBytes?: number; v01?: boolean } = {}) {
  const tokenizer = {
    model: { type: "BPE", vocab: Object.fromEntries(bytesToUnicode().map((c, b) => [c, b])), merges: [] },
    added_tokens: ["[CLS]", "[SEP]", "[Q]", "[O]", "[L]", "[T]", "[F]"].map((c, i) => ({ id: 300 + i, content: c, special: true })),
    normalizer: { type: "NFC" },
    pre_tokenizer: { type: "ByteLevel", add_prefix_space: false, use_regex: true },
  };
  const meta = {
    name: "toy",
    max_len: 1536,
    markers: { "[Q]": 302, "[O]": 303, "[L]": 304, "[T]": 305, "[F]": 306 },
    cls_id: 300,
    sep_id: 301,
    inputs: ["input_ids", "position_ids", "q_group", "i_group", "choice_q", "choice_items", "score_q", "score_items", "noul_q", "noul_t", "noul_f"],
    outputs: ["choice_logits", "score_logits", "noul_logits"],
  };
  const onnx = new Uint8Array(opts.onnxBytes ?? 300_000).map((_, i) => (i * 7) & 255);
  const fp16 = new Uint8Array(1000).fill(16);
  const files: Record<string, Uint8Array> = {
    "tokenizer.json": enc.encode(JSON.stringify(tokenizer)),
    "calibration.json": enc.encode(JSON.stringify({ noul: 1, choice: 1, score: 1, by_header: {} })),
    "meta.json": enc.encode(JSON.stringify(meta)),
    "toy-q8.onnx": onnx,
    "toy-fp16.onnx": fp16,
  };
  const spec = (f: string) => ({ file: f, bytes: files[f].byteLength, sha256: sha(files[f]) });
  const card = opts.v01
    ? {
        name: "genclass-model",
        version: "0.1.0",
        license: "Apache-2.0",
        release_tag: "v0.1.0",
        default_base_url: "https://example.invalid/",
        variants: { fp16: { ...spec("toy-fp16.onnx"), provider: "webgpu", needs: "shader-f16" }, q8: { ...spec("toy-q8.onnx"), provider: "wasm" } },
        bundled: ["tokenizer.json", "calibration.json", "meta.json"],
      }
    : {
        format: "genclass-runtime-model/1",
        name: "toy-model",
        version: "1.2.3",
        variants: { q8: { ...spec("toy-q8.onnx"), provider: "wasm" }, fp16: { ...spec("toy-fp16.onnx"), provider: "webgpu", needs: "shader-f16" } },
        files: { tokenizer: spec("tokenizer.json"), calibration: spec("calibration.json"), meta: spec("meta.json") },
      };
  files["model.json"] = enc.encode(JSON.stringify(card));
  const wasm = new Uint8Array(5000).fill(9);
  const log: string[] = [];
  let down = false;
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    log.push(url);
    if (down) throw new TypeError("network down");
    if (url.endsWith(ORT_WASM_FILES.webgpu) || url.endsWith(ORT_WASM_FILES.wasm)) return new Response(wasm, { status: 200 });
    const name = url.replace("https://cdn.test/model/", "");
    const body = files[name];
    if (!body) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-length": String(body.byteLength) } });
  }) as typeof fetch;
  return { files, card, fetch: fetchFn, log, wasm, setDown: (v: boolean) => (down = v) };
}

/** onnxruntime stand-in: WebGPU sessions fail (no adapter on the VM), WASM sessions answer with fixed logits. */
function fakeOrt(): OrtLike & { created: string[]; env: any } {
  const created: string[] = [];
  return {
    created,
    Tensor: class {
      constructor(
        public type: string,
        public data: BigInt64Array,
        public dims: readonly number[],
      ) {}
    } as any,
    InferenceSession: {
      create: async (_bytes: Uint8Array, o?: Record<string, unknown>) => {
        const ep = (o?.executionProviders as string[])[0];
        created.push(ep);
        if (ep === "webgpu") throw new Error("WebGPU not available on this browser (requestAdapter returned null)");
        return {
          inputNames: ["input_ids", "position_ids", "q_group", "i_group", "choice_q", "choice_items", "score_q", "score_items", "noul_q", "noul_t", "noul_f"],
          outputNames: ["choice_logits", "score_logits", "noul_logits"],
          run: async (feeds: Record<string, any>) => {
            const [g, k] = feeds.choice_items.dims;
            const [s, k2] = feeds.score_items.dims;
            const m = feeds.noul_q.dims[0];
            return {
              choice_logits: { type: "float32", dims: [g, k], data: Float32Array.from({ length: g * k }, (_, i) => (i % k === 1 ? 3 : 0)) },
              score_logits: { type: "float32", dims: [s, k2], data: new Float32Array(s * k2) },
              noul_logits: { type: "float32", dims: [m], data: new Float32Array(m).fill(2) },
            };
          },
          release: async () => undefined,
        } as any;
      },
    },
    env: { wasm: {}, versions: { web: "1.30.0" } },
  };
}

const NO_GPU: GpuInfo = { webgpu: false, f16: false, fallback: false };
const GPU_F16: GpuInfo = { webgpu: true, f16: true, fallback: false };

// ------------------------------------------------------------------------------------------------ card

describe("model card", () => {
  it("parses the runtime card and the v0.1 extension card", () => {
    const a = parseCard(modelDir().card);
    expect(a).toMatchObject({ format: "genclass-runtime-model/1", name: "toy-model", version: "1.2.3" });
    expect(a.files.tokenizer.sha256).toMatch(/^[0-9a-f]{64}$/);
    const b = parseCard(modelDir({ v01: true }).card);
    expect(b.files).toEqual({ tokenizer: { file: "tokenizer.json" }, calibration: { file: "calibration.json" }, meta: { file: "meta.json" } });
    expect(b.variants.fp16.needs).toBe("shader-f16");
  });

  it("rejects malformed cards and unsafe file names", () => {
    expect(() => parseCard({})).toThrow(ModelUnsupportedError);
    expect(() => parseCard({ variants: { q8: { file: "../x.onnx" } } })).toThrow(ModelUnsupportedError);
    expect(() => parseCard({ variants: { q8: { file: "https://evil/x.onnx" } } })).toThrow(ModelUnsupportedError);
    expect(() => parseCard({ variants: { q8: { file: "x.onnx", sha256: "nope" } } })).toThrow(ModelUnsupportedError);
  });

  it("plans: webgpu+fp16 (shader-f16) -> webgpu+q8 -> wasm+q8; auto skips software adapters", () => {
    const card = parseCard(modelDir().card);
    const fmt = (gpu: GpuInfo, d: "auto" | "webgpu" | "wasm") => planOrder(card, d, gpu).map((p) => `${p.device}+${p.variant}`);
    expect(fmt(GPU_F16, "auto")).toEqual(["webgpu+fp16", "webgpu+q8", "wasm+q8"]);
    expect(fmt({ ...GPU_F16, f16: false }, "auto")).toEqual(["webgpu+q8", "wasm+q8"]);
    expect(fmt(NO_GPU, "auto")).toEqual(["wasm+q8"]);
    expect(fmt(NO_GPU, "webgpu")).toEqual(["wasm+q8"]);
    expect(fmt(GPU_F16, "wasm")).toEqual(["wasm+q8"]);
    expect(fmt({ ...GPU_F16, fallback: true }, "auto")).toEqual(["wasm+q8"]);
    expect(fmt({ ...GPU_F16, fallback: true }, "webgpu")).toEqual(["webgpu+fp16", "webgpu+q8", "wasm+q8"]);
    // a q8 with fp16 tensors (the v0.1 export's fp16 embedding table) declares shader-f16 and skips non-f16 WebGPU;
    // an int8-embedding q8 has no fp16 tensor and runs there
    const f16q8 = parseCard({ ...modelDir().card, variants: { ...modelDir().card.variants, q8: { ...modelDir().card.variants.q8, needs: "shader-f16" } } });
    expect(planOrder(f16q8, "auto", { ...GPU_F16, f16: false }).map((p) => `${p.device}+${p.variant}`)).toEqual(["wasm+q8"]);
    expect(planOrder(f16q8, "auto", GPU_F16).map((p) => `${p.device}+${p.variant}`)).toEqual(["webgpu+fp16", "webgpu+q8", "wasm+q8"]);
  });
});

// ------------------------------------------------------------------------------------------- downloads

describe("cached downloads", () => {
  const url = "https://cdn.test/model/toy-q8.onnx";

  it("streams with progress, verifies sha256, stores, then serves from Cache Storage without the network", async () => {
    const d = modelDir();
    const caches = new FakeCacheStorage();
    const env = { fetch: d.fetch, caches: caches as unknown as CacheStorage, cacheName: "genclass-runtime-v1" };
    const spec = parseCard(d.card).variants.q8;
    const prog: number[] = [];
    const a = await fetchFile(env, url, spec, "toy@1", (l, t) => {
      expect(t).toBe(spec.bytes);
      prog.push(l);
    });
    await a.stored;
    expect(a.fromCache).toBe(false);
    expect(a.bytes.byteLength).toBe(spec.bytes);
    expect(prog.at(-1)).toBe(spec.bytes);
    expect(prog).toEqual([...prog].sort((x, y) => x - y));
    const before = d.log.length;
    const b = await fetchFile(env, url, spec, "toy@1");
    expect(b.fromCache).toBe(true);
    expect(d.log.length).toBe(before);
    expect(sha(b.bytes)).toBe(spec.sha256);
  });

  it("refetches when the cached copy is for another hash; rejects corrupt downloads", async () => {
    const d = modelDir();
    const caches = new FakeCacheStorage();
    const env = { fetch: d.fetch, caches: caches as unknown as CacheStorage, cacheName: "c" };
    const spec = parseCard(d.card).variants.q8;
    (await caches.open("c")).store.set(url, new Response(new Uint8Array(10), { headers: { "x-genclass-sha256": "0".repeat(64) } }));
    const a = await fetchFile(env, url, spec, "t");
    expect(a.fromCache).toBe(false);
    await expect(fetchFile(env, url, { ...spec, sha256: "1".repeat(64) }, "t")).rejects.toBeInstanceOf(ModelIntegrityError);
    await expect(fetchFile(env, url, { ...spec, bytes: 5 }, "t")).rejects.toBeInstanceOf(ModelIntegrityError);
    await expect(fetchFile(env, "https://cdn.test/model/missing.onnx", { file: "missing.onnx" }, "t")).rejects.toBeInstanceOf(ModelLoadError);
  });

  it("works without Cache Storage and when storing fails (quota)", async () => {
    const d = modelDir();
    const spec = parseCard(d.card).variants.q8;
    const a = await fetchFile({ fetch: d.fetch, caches: null, cacheName: "c" }, url, spec, "t");
    expect(a.bytes.byteLength).toBe(spec.bytes);
    const caches = new FakeCacheStorage();
    (await caches.open("c")).failPut = true;
    const b = await fetchFile({ fetch: d.fetch, caches: caches as unknown as CacheStorage, cacheName: "c" }, url, spec, "t");
    await b.stored;
    expect(b.bytes.byteLength).toBe(spec.bytes);
  });

  it("the card comes from the network, or from Cache Storage when offline", async () => {
    const d = modelDir();
    const caches = new FakeCacheStorage();
    const env = { fetch: d.fetch, caches: caches as unknown as CacheStorage, cacheName: "c" };
    const a = await fetchCard(env, "https://cdn.test/model/");
    expect(a.fromCache).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    d.setDown(true);
    const b = await fetchCard(env, "https://cdn.test/model/");
    expect(b).toMatchObject({ fromCache: true, card: { name: "toy-model" } });
    await expect(fetchCard({ ...env, caches: null }, "https://cdn.test/model/")).rejects.toBeInstanceOf(ModelLoadError);
  });
});

// ---------------------------------------------------------------------------------------------- backend

describe("ModelBackend load", () => {
  function backend(d: ReturnType<typeof modelDir>, caches: FakeCacheStorage | null, gpu: GpuInfo, ort = fakeOrt()) {
    const statuses: ModelHostStatus[] = [];
    const builds: OrtBuild[] = [];
    const b = new ModelBackend({
      ort: async (build) => {
        builds.push(build);
        return ort;
      },
      fetch: d.fetch,
      caches: caches as unknown as CacheStorage,
      clock: browserClock,
      emit: (s) => statuses.push(s),
      probeGpu: async () => gpu,
      inWorker: true,
    });
    return { b, statuses, ort, builds };
  }

  it("falls back through the plans, reports phases, progress and timings, then answers", async () => {
    const d = modelDir();
    const caches = new FakeCacheStorage();
    const { b, statuses, ort, builds } = backend(d, caches, GPU_F16);
    await expect(b.evaluate({ s: "x" }, {})).rejects.toBeInstanceOf(ModelNotReadyError);
    await b.load({ baseUrl: "https://cdn.test/model/" });
    expect(builds).toEqual(["webgpu"]); // a WebGPU plan exists: the WebGPU bundle (it also runs the WASM fallback)
    expect(ort.created).toEqual(["webgpu", "webgpu", "wasm"]);
    const last = statuses.at(-1) as ModelHostStatus;
    expect(last).toMatchObject({ state: "ready", device: "wasm", variant: "q8", model: "toy-model", version: "1.2.3", fromCache: false, worker: true, threads: 1, ort: "1.30.0", ortBuild: "webgpu" });
    expect(last.latency).toMatchObject({ n: 0, source: "warmup" });
    expect(last.latency!.tokensP50).toBeGreaterThan(100);
    expect(last.bytes).toBe(300_000);
    expect(last.attempts?.map((a) => `${a.device}+${a.variant}`)).toEqual(["webgpu+fp16", "webgpu+q8"]);
    expect(typeof last.loadMs).toBe("number");
    expect(typeof last.warmupMs).toBe("number");
    const phases = [...new Set(statuses.map((s) => s.phase).filter(Boolean))];
    expect(phases).toEqual(["card", "download", "runtime", "session", "warmup"]);
    const prog = statuses.filter((s) => s.progress).map((s) => s.progress!.loaded);
    expect(prog.length).toBeGreaterThan(0);
    expect(prog).toEqual([...prog].sort((x, y) => x - y));
    // the ORT wasm was fetched once, through the same cache, and handed to ORT (then released)
    expect(d.log.filter((u) => u.endsWith(ORT_WASM_FILES.webgpu)).length).toBe(1);
    expect(d.log.filter((u) => u.endsWith(ORT_WASM_FILES.wasm)).length).toBe(0);
    expect(ort.env.wasm.wasmBinary).toBeUndefined();
    const r = await b.evaluate({ s: "x" }, { c: { type: "choice", instructions: "?", criteria: { a: null, b: null } }, n: { type: "noul", instructions: "?" } });
    expect(r.answers.c).toMatchObject({ type: "choice", choice: "b" });
    expect(r.answers.n).toEqual({ type: "noul", noul: 1 / (1 + Math.exp(-2)) });
    // byte vocabulary, no merges: [CLS] "s" ":" "Ġ" "x" [SEP]
    expect(b.measure({ s: "x" }).stateTokens).toBe(6);
  });

  it("second load: everything from Cache Storage, no network for model files or the ORT wasm", async () => {
    const d = modelDir();
    const caches = new FakeCacheStorage();
    const first = backend(d, caches, NO_GPU);
    await first.b.load({ baseUrl: "https://cdn.test/model/" });
    expect(first.builds).toEqual(["wasm"]); // no usable WebGPU: the smaller WASM bundle and its wasm
    expect(d.log.filter((u) => u.endsWith(ORT_WASM_FILES.wasm)).length).toBe(1);
    expect(d.log.filter((u) => u.endsWith(ORT_WASM_FILES.webgpu)).length).toBe(0);
    d.log.length = 0;
    const { b, statuses } = backend(d, caches, NO_GPU);
    await b.load({ baseUrl: "https://cdn.test/model/" });
    expect(statuses.at(-1)).toMatchObject({ state: "ready", fromCache: true, ortBuild: "wasm" });
    expect(d.log).toEqual(["https://cdn.test/model/model.json"]); // the card is revalidated; nothing else moves
  });

  it("accepts the v0.1 extension card", async () => {
    const d = modelDir({ v01: true });
    const { b, statuses } = backend(d, new FakeCacheStorage(), NO_GPU);
    await b.load({ baseUrl: "https://cdn.test/model/", warmup: false });
    expect(statuses.at(-1)).toMatchObject({ state: "ready", model: "genclass-model", version: "0.1.0", variant: "q8" });
  });

  it("a WebGPU session that never comes up times out: in a worker the remaining plans stop, inline they continue", async () => {
    for (const inWorker of [true, false]) {
      const d = modelDir();
      const ort = fakeOrt();
      const create = ort.InferenceSession.create;
      ort.InferenceSession.create = async (bytes: Uint8Array, o?: Record<string, unknown>) =>
        (o?.executionProviders as string[])[0] === "webgpu" ? new Promise(() => undefined) : create(bytes, o);
      const statuses: ModelHostStatus[] = [];
      const b = new ModelBackend({ ort: async () => ort, fetch: d.fetch, caches: null, clock: browserClock, emit: (s) => statuses.push(s), probeGpu: async () => GPU_F16, inWorker });

      const res = await b.load({ baseUrl: "https://cdn.test/model/", warmup: false, sessionTimeoutMs: { webgpu: 30 } }).then(() => "ready", (e) => e);
      if (inWorker) {
        expect(res).toBeInstanceOf(ModelLoadError);
        expect(statuses.at(-1)).toMatchObject({ state: "error", attempts: [{ device: "webgpu", variant: "fp16" }] });
        expect(statuses.at(-1)?.error).toContain("WebGPU did not come up");
      } else {
        expect(res).toBe("ready");
        expect(statuses.at(-1)?.attempts?.map((a) => a.device)).toEqual(["webgpu", "webgpu"]);
      }
    }
  });

  it("reports an error status with every attempt when nothing can run", async () => {
    const d = modelDir();
    const ort = fakeOrt();
    ort.InferenceSession.create = async () => {
      throw new Error("bad model");
    };
    const { b, statuses } = backend(d, null, NO_GPU, ort);
    const err = await b.load({ baseUrl: "https://cdn.test/model/" }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelLoadError);
    expect(statuses.at(-1)).toMatchObject({ state: "error", attempts: [{ variant: "q8", device: "wasm", error: "bad model" }] });
    await expect(b.evaluate({}, {})).rejects.toBeInstanceOf(ModelNotReadyError);
  });
});
