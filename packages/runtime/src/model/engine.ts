// GenClass decision engine: packer + ONNX session + calibration -> Jev answers (port of the GenClass extension's
// core/engine.js). `ort` is injected (onnxruntime-web in browsers, onnxruntime-node or -web in Node tests).
//
// Graph inputs are built by name for exactly the inputs meta.json declares (checked against the session), so a
// re-exported model may drop or add inputs from the known set below without code changes. Outputs map to heads
// by name; a question whose head the model lacks fails with ModelUnsupportedError.

import type { Answer } from "../types.js";
import { buildAnswer, calibrateLogits, headerKey, type Calibration, type Precision } from "./calibrate.js";
import { ModelInferenceError, ModelUnsupportedError } from "./errors.js";
import { Packer, planInputs, unpackLogits, type FeedPlan, type HeadOutput, type Packed } from "./packer.js";
import { questionEntries, type BlockKind, type QBlock } from "./serialize.js";
import type { Tokenizer } from "./tokenizer.js";

// ------------------------------------------------------------------------------------- ORT structural types

export interface OrtTensorLike {
  readonly data: unknown;
  readonly dims: readonly number[];
  readonly type: string;
  dispose?(): void;
}

export interface OrtSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
  release?(): Promise<void>;
}

export interface OrtEnvLike {
  logLevel?: string;
  versions?: { web?: string; common?: string };
  wasm: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean; simd?: boolean };
  webgpu?: { adapter?: unknown; powerPreference?: string };
}

export interface OrtLike {
  Tensor: new (type: "int64", data: BigInt64Array, dims: readonly number[]) => OrtTensorLike;
  InferenceSession: { create(model: Uint8Array, options?: Record<string, unknown>): Promise<OrtSessionLike> };
  env: OrtEnvLike;
}

/** meta.json of a model directory (only the keys the runtime reads). */
export interface ModelMeta {
  name?: string;
  /** Positions budget: state + the longest question branch. */
  max_len?: number;
  /** Token budget of the whole packed sequence (default 8192). */
  max_total?: number;
  markers?: Record<string, number>;
  cls_id?: number;
  sep_id?: number;
  pad_id?: number;
  inputs?: string[];
  outputs?: string[];
  [k: string]: unknown;
}

const OUTPUT_KIND: Record<string, BlockKind> = { choice_logits: "choice", score_logits: "score", noul_logits: "noul" };

type FeedBuilder = (p: Packed, plan: FeedPlan) => [number[], number[]];
const tokenRow = (arr: number[]): [number[], number[]] => [arr, [1, arr.length]];

/** Every graph input the engine knows how to build: name -> (flat int64 values, dims). */
export const FEEDS: Record<string, FeedBuilder> = {
  input_ids: (p) => tokenRow(p.inputIds),
  position_ids: (p) => tokenRow(p.positionIds),
  q_group: (p) => tokenRow(p.qGroup),
  i_group: (p) => tokenRow(p.iGroup),
  attention_mask: (p) => tokenRow(new Array<number>(p.inputIds.length).fill(1)),
  token_type_ids: (p) => tokenRow(new Array<number>(p.inputIds.length).fill(0)),
  choice_q: (_p, pl) => [pl.choice.q, [pl.choice.q.length]],
  choice_items: (_p, pl) => [pl.choice.items.flat(), [pl.choice.q.length, pl.choice.k]],
  score_q: (_p, pl) => [pl.score.q, [pl.score.q.length]],
  score_items: (_p, pl) => [pl.score.items.flat(), [pl.score.q.length, pl.score.k]],
  noul_q: (_p, pl) => [pl.noul.q, [pl.noul.q.length]],
  noul_t: (_p, pl) => [pl.noul.t, [pl.noul.t.length]],
  noul_f: (_p, pl) => [pl.noul.f, [pl.noul.f.length]],
};

/** fp16 bits -> number. */
function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** Output tensor values as numbers, whatever float type the graph emits. */
export function tensorFloats(t: OrtTensorLike): ArrayLike<number> {
  const d = t.data as ArrayLike<number> & { BYTES_PER_ELEMENT?: number };
  if (t.type === "float16" && d instanceof Uint16Array) return Array.from(d, halfToFloat);
  if (t.type === "float32" || t.type === "float64" || t.type === "float16") return d;
  throw new ModelUnsupportedError(`unexpected output type ${t.type}`);
}

export interface EngineOptions {
  ort: OrtLike;
  session: OrtSessionLike;
  tokenizer: Tokenizer;
  calibration: Calibration;
  meta: ModelMeta;
  device?: string;
  variant?: string;
  /** Reported model id (e.g. "genclass-runtime-model@0.1.0"). */
  name?: string;
  precision?: Precision;
  now?: () => number;
}

export interface EngineResult {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; positions: number };
  timings: { pack: number; forward: number; total: number };
}

export class Engine {
  readonly ort: OrtLike;
  readonly session: OrtSessionLike;
  readonly packer: Packer;
  readonly calib: Calibration;
  readonly meta: ModelMeta;
  readonly device: string;
  readonly variant: string;
  readonly name: string;
  readonly precision: Precision;
  /** Heads this model has. */
  readonly heads: ReadonlySet<BlockKind>;
  private readonly inputs: string[];
  private readonly outputs: string[];
  private readonly now: () => number;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(o: EngineOptions) {
    this.ort = o.ort;
    this.session = o.session;
    this.calib = o.calibration;
    this.meta = o.meta ?? {};
    this.device = o.device ?? "wasm";
    this.variant = o.variant ?? "q8";
    this.name = o.name ?? String(this.meta.name ?? "genclass");
    this.precision = o.precision ?? "exact";
    this.now = o.now ?? (() => performance.now());
    this.packer = new Packer(o.tokenizer, {
      maxPositions: Number(this.meta.max_len ?? 1536),
      maxTotal: Number(this.meta.max_total ?? 8192),
      markers: this.meta.markers,
      clsId: this.meta.cls_id,
      sepId: this.meta.sep_id,
    });

    const graphIn = [...(o.session.inputNames ?? [])];
    const declaredIn = Array.isArray(this.meta.inputs) ? [...this.meta.inputs] : graphIn;
    if (graphIn.length && !sameSet(graphIn, declaredIn)) {
      throw new ModelUnsupportedError(`graph inputs [${graphIn.join(", ")}] differ from meta.json inputs [${declaredIn.join(", ")}]`);
    }
    const unknownIn = declaredIn.filter((n) => !Object.hasOwn(FEEDS, n));
    if (unknownIn.length) throw new ModelUnsupportedError(`unsupported graph inputs: ${unknownIn.join(", ")}`);
    this.inputs = declaredIn;

    const graphOut = [...(o.session.outputNames ?? [])];
    const declaredOut = Array.isArray(this.meta.outputs) ? [...this.meta.outputs] : graphOut;
    if (graphOut.length && declaredOut.some((n) => !graphOut.includes(n))) {
      throw new ModelUnsupportedError(`meta.json outputs [${declaredOut.join(", ")}] are not all graph outputs [${graphOut.join(", ")}]`);
    }
    this.outputs = declaredOut.filter((n) => Object.hasOwn(OUTPUT_KIND, n));
    if (!this.outputs.length) throw new ModelUnsupportedError(`the model has no known head outputs (${declaredOut.join(", ")})`);
    this.heads = new Set(this.outputs.map((n) => OUTPUT_KIND[n]));
  }

  private feeds(p: Packed): Record<string, OrtTensorLike> {
    const plan = planInputs(p);
    const out: Record<string, OrtTensorLike> = {};
    for (const name of this.inputs) {
      const [vals, dims] = FEEDS[name](p, plan);
      const data = new BigInt64Array(vals.length);
      for (let i = 0; i < vals.length; i++) data[i] = BigInt(vals[i]);
      out[name] = new this.ort.Tensor("int64", data, dims);
    }
    return out;
  }

  /** Runs `fn` after every earlier call settled: one forward pass at a time on this session. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.busy.then(fn, fn);
    this.busy = p.catch(() => undefined);
    return p;
  }

  /** Raw (tau = 1) logits per qid (request order) plus the packed sequence. */
  logits(state: unknown, questions: unknown): Promise<{ logits: Map<string, number[]>; packed: Packed; blocks: QBlock[]; timings: { pack: number; forward: number } }> {
    return this.serial(async () => {
      const t0 = this.now();
      const { packed, blocks } = this.packer.pack(state, questions);
      for (const b of blocks) {
        if (!this.heads.has(b.kind)) throw new ModelUnsupportedError(`this model cannot answer ${b.kind} questions (${b.qid})`);
      }
      const t1 = this.now();
      const feeds = this.feeds(packed);
      let out: Record<string, OrtTensorLike> | undefined;
      try {
        try {
          out = await this.session.run(feeds);
        } catch (e) {
          throw new ModelInferenceError(`inference failed: ${(e as Error)?.message ?? String(e)}`);
        }
        const heads: Partial<Record<BlockKind, HeadOutput>> = {};
        for (const name of this.outputs) {
          const t = out[name];
          if (t) heads[OUTPUT_KIND[name]] = { data: tensorFloats(t), dims: t.dims };
        }
        const logits = unpackLogits(packed, heads);
        return { logits, packed, blocks, timings: { pack: t1 - t0, forward: this.now() - t1 } };
      } finally {
        for (const t of Object.values(feeds)) t.dispose?.();
        if (out) for (const t of Object.values(out)) t.dispose?.();
      }
    });
  }

  async evaluate(state: unknown, questions: unknown): Promise<EngineResult> {
    const t0 = this.now();
    const { logits, packed, blocks, timings } = await this.logits(state, questions);
    const qs = new Map(questionEntries(questions));
    const answers: Record<string, Answer> = {};
    for (const b of blocks) {
      const probs = calibrateLogits(b.kind, headerKey(b.header), logits.get(b.qid) as number[], this.calib);
      answers[b.qid] = buildAnswer(qs.get(b.qid) as { type: string }, probs, this.precision, b.labels);
    }
    let positions = 0;
    for (let i = 0; i < packed.positionIds.length; i++) if (packed.positionIds[i] > positions) positions = packed.positionIds[i];
    return {
      model: this.name,
      answers,
      usage: { input_tokens: packed.inputIds.length, positions: positions + 1 },
      timings: { ...timings, total: this.now() - t0 },
    };
  }

  async release(): Promise<void> {
    await this.busy;
    await this.session.release?.();
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}
