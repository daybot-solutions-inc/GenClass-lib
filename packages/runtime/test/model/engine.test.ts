// End to end in Node: TS packer -> ONNX (onnxruntime-node CPU, and onnxruntime-web WASM) -> TS calibration, vs
// PyTorch logits/probabilities on the 50 harness requests. Needs the v0.1 model directory (GENCLASS_MODEL_DIR,
// fetched with `genclass-runtime fetch-model`); skipped when absent.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCalibration } from "../../src/model/calibrate.js";
import { Engine, type OrtLike } from "../../src/model/engine.js";
import { ModelUnsupportedError } from "../../src/model/errors.js";
import { Tokenizer, bytesToUnicode } from "../../src/model/tokenizer.js";
import { hasModelFile, modelFile, packs, questionsInPythonOrder, readJson, requests, torch } from "./helpers.js";

const HAVE = hasModelFile("model.json") && hasModelFile("tokenizer.json");
const card = HAVE ? readJson<any>(modelFile("model.json")) : null;
const variantFile = (v: string): string | null => {
  const f = card?.variants?.[v]?.file;
  return f && hasModelFile(f) ? modelFile(f) : null;
};

interface Parity {
  maxLogit: number;
  maxProb: number;
  agree: number;
  total: number;
  requestsAllSame: number;
  p50ms: number;
  n: number;
}

async function parity(ort: OrtLike, file: string, variant: string, opts: Record<string, unknown>, limit = 50): Promise<Parity> {
  const tok = new Tokenizer(readJson(modelFile("tokenizer.json")));
  const calibration = parseCalibration(readJson(modelFile("calibration.json")));
  const meta = readJson<any>(modelFile("meta.json"));
  const session = await ort.InferenceSession.create(readFileSync(file), opts);
  const eng = new Engine({ ort, session, tokenizer: tok, calibration, meta, variant });
  const reqs = requests().slice(0, limit);
  const pf = packs();
  const tf = torch();
  const r: Parity = { maxLogit: 0, maxProb: 0, agree: 0, total: 0, requestsAllSame: 0, p50ms: 0, n: reqs.length };
  const ms: number[] = [];
  for (let i = 0; i < reqs.length; i++) {
    const qs = questionsInPythonOrder(reqs[i], pf[i]);
    const t0 = performance.now();
    const res = await eng.evaluate(reqs[i].state, qs);
    ms.push(performance.now() - t0);
    const { logits } = await eng.logits(reqs[i].state, qs);
    let all = true;
    for (const [qid, z] of logits) {
      z.forEach((x, j) => {
        r.maxLogit = Math.max(r.maxLogit, Math.abs(x - tf[i].logits[qid][j]));
      });
      const ref = tf[i].probs[qid];
      const ans = res.answers[qid];
      let same: boolean;
      if (ans.type === "noul") {
        r.maxProb = Math.max(r.maxProb, Math.abs(ans.noul - ref[0]));
        same = ans.noul >= 0.5 === ref[0] >= 0.5;
      } else {
        const got = Object.values(ans.probabilities);
        got.forEach((x, j) => {
          r.maxProb = Math.max(r.maxProb, Math.abs(x - ref[j]));
        });
        same = got.indexOf(Math.max(...got)) === ref.indexOf(Math.max(...ref));
        if (ans.type === "choice") expect(Object.keys(ans.probabilities)).toEqual(pf[i].q_index[qid].labels);
      }
      r.agree += same ? 1 : 0;
      all &&= same;
      r.total++;
    }
    r.requestsAllSame += all ? 1 : 0;
  }
  ms.sort((a, b) => a - b);
  r.p50ms = Math.round(ms[ms.length >> 1]);
  await eng.release();
  console.log(`[parity ${variant}]`, JSON.stringify(r));
  return r;
}

describe.skipIf(!HAVE)("engine parity with PyTorch (onnxruntime-node, CPU EP)", () => {
  it.skipIf(!variantFile("q8"))("q8 (MatMulNBits 8-bit)", { timeout: 600_000 }, async () => {
    const ort = (await import("onnxruntime-node")) as unknown as OrtLike;
    const r = await parity(ort, variantFile("q8") as string, "q8", { executionProviders: ["cpu"], intraOpNumThreads: 4 });
    expect(r.total).toBe(503);
    expect(r.agree / r.total).toBeGreaterThanOrEqual(0.99);
    expect(r.maxLogit).toBeLessThan(1.0);
  });

  it.skipIf(!variantFile("fp16"))("fp16", { timeout: 600_000 }, async () => {
    const ort = (await import("onnxruntime-node")) as unknown as OrtLike;
    const r = await parity(ort, variantFile("fp16") as string, "fp16", { executionProviders: ["cpu"], intraOpNumThreads: 4 });
    expect(r.agree / r.total).toBeGreaterThanOrEqual(0.99);
    expect(r.maxLogit).toBeLessThan(0.1);
  });
});

describe.skipIf(!HAVE)("engine parity with PyTorch (onnxruntime-web, WASM EP in Node: the browser runtime)", () => {
  it.skipIf(!variantFile("q8"))("q8 on onnxruntime-web 1.30 wasm, single thread", { timeout: 900_000 }, async () => {
    const ort = (await import("onnxruntime-web")) as unknown as OrtLike;
    ort.env.wasm.numThreads = 1;
    const r = await parity(ort, variantFile("q8") as string, "q8", { executionProviders: ["wasm"], graphOptimizationLevel: "all" }, 12);
    expect(r.agree / r.total).toBeGreaterThanOrEqual(0.99);
    expect(r.maxLogit).toBeLessThan(1.0);
  });
});

describe("engine graph contract", () => {
  const fakeOrt: OrtLike = {
    Tensor: class {
      constructor(
        public type: string,
        public data: BigInt64Array,
        public dims: readonly number[],
      ) {}
    } as any,
    InferenceSession: { create: async () => ({}) as any },
    env: { wasm: {} },
  };
  const tokJson = {
    model: { type: "BPE", vocab: Object.fromEntries(bytesToUnicode().map((c, b) => [c, b])), merges: [] },
    added_tokens: ["[CLS]", "[SEP]", "[Q]", "[O]", "[L]", "[T]", "[F]"].map((c, i) => ({ id: 1000 + i, content: c, special: true })),
    normalizer: null,
    pre_tokenizer: { type: "ByteLevel", add_prefix_space: false, use_regex: true },
  };

  it("feeds exactly the inputs meta.json declares and rejects unknown ones", async () => {
    // a byte-only vocabulary (no merges) with markers at arbitrary ids: nothing about the vocab is hardcoded
    const tok = new Tokenizer(tokJson as any);
    expect(tok.vocabSize).toBe(1007);
    const session = {
      inputNames: ["input_ids", "position_ids", "q_group", "i_group", "noul_q", "noul_t", "noul_f"],
      outputNames: ["noul_logits"],
      run: async (feeds: Record<string, any>) => {
        expect(Object.keys(feeds).sort()).toEqual(["i_group", "input_ids", "noul_f", "noul_q", "noul_t", "position_ids", "q_group"]);
        return { noul_logits: { type: "float32", data: Float32Array.from([2]), dims: [1] } };
      },
    };
    const meta = { inputs: session.inputNames, outputs: ["noul_logits"], max_len: 512 };
    const eng = new Engine({ ort: fakeOrt, session: session as any, tokenizer: tok, calibration: parseCalibration({}), meta });
    const r = await eng.evaluate({ s: "x" }, { n: { type: "noul", instructions: "ok?" } });
    expect(r.answers.n).toEqual({ type: "noul", noul: 1 / (1 + Math.exp(-2)) });
    await expect(eng.evaluate({ s: "x" }, { c: { type: "choice", instructions: "?", criteria: { a: null } } })).rejects.toBeInstanceOf(ModelUnsupportedError);
    expect(() => new Engine({ ort: fakeOrt, session: { ...session, inputNames: [...session.inputNames, "mystery"] } as any, tokenizer: tok, calibration: parseCalibration({}), meta: { ...meta, inputs: [...meta.inputs, "mystery"] } })).toThrow(ModelUnsupportedError);
    expect(() => new Engine({ ort: fakeOrt, session: session as any, tokenizer: tok, calibration: parseCalibration({}), meta: { ...meta, inputs: ["input_ids"] } })).toThrow(ModelUnsupportedError);
  });
});
