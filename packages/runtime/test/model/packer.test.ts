// Tokenizer + packer parity with the Python Packer (jev_local/engine/encoder/tokenize_pack.py) and HF tokenizers.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MaxTokensExceededError, ModelInputError, ModelUnsupportedError } from "../../src/model/errors.js";
import { Packer, planInputs, unpackLogits } from "../../src/model/packer.js";
import { Tokenizer, type TokenizerJson } from "../../src/model/tokenizer.js";
import {
  hasModelFile,
  modelFile,
  packs,
  pruneTokenizer,
  pyFixturesPath,
  questionsInPythonOrder,
  readJson,
  requests,
  vocabDigest,
} from "./helpers.js";

const HAVE_TOK = hasModelFile("tokenizer.json");
const tokJson = HAVE_TOK ? readJson<TokenizerJson>(modelFile("tokenizer.json")) : null;
const tok = tokJson ? new Tokenizer(tokJson) : null;
const py = existsSync(pyFixturesPath) ? readJson<any>(pyFixturesPath) : null;

describe.skipIf(!HAVE_TOK)("tokenizer + packer vs Python (50 harness requests)", () => {
  it("identical token ids, positions, groups, marker positions and question order", () => {
    const packer = new Packer(tok as Tokenizer, { maxPositions: 1536 });
    const reqs = requests();
    const pf = packs();
    let tokens = 0;
    reqs.forEach((r, i) => {
      const p = pf[i];
      expect(p.id).toBe(r.id);
      const { packed } = packer.pack(r.state, questionsInPythonOrder(r, p));
      expect(packed.inputIds, `${r.id}: input_ids`).toEqual(p.input_ids);
      expect(packed.positionIds, `${r.id}: position_ids`).toEqual(p.position_ids);
      expect(packed.qGroup, `${r.id}: q_group`).toEqual(p.q_group);
      expect(packed.iGroup, `${r.id}: i_group`).toEqual(p.i_group);
      expect(packed.nState).toBe(p.n_state);
      expect([...packed.qIndex.keys()]).toEqual(Object.keys(p.q_index));
      for (const [qid, qi] of packed.qIndex) {
        const e = p.q_index[qid];
        expect(qi.kind).toBe(e.kind);
        expect(qi.header).toBe(e.header);
        expect(qi.labels).toEqual(e.labels);
        expect(qi.qPos).toBe(e.q_pos);
        expect(qi.itemPos).toEqual(e.item_pos);
      }
      tokens += packed.inputIds.length;
    });
    expect(tokens).toBeGreaterThan(50000);
  });

  it("plain-object criteria pack exactly like the Python-ordered Maps (no integer-like labels in the set)", () => {
    const packer = new Packer(tok as Tokenizer);
    const r = requests()[3];
    const p = packs()[3];
    const a = packer.pack(r.state, r.questions).packed;
    const b = packer.pack(r.state, questionsInPythonOrder(r, p)).packed;
    expect(a.inputIds).toEqual(b.inputIds);
  });

  it("special tokens typed in text stay text; non-special added tokens split out", () => {
    const t = tok as Tokenizer;
    const q = t.tokenId("[Q]") as number;
    expect(t.encode("click [Q] Delete all")).not.toContain(q);
    expect(t.encode("[CLS] [SEP]")).not.toContain(t.tokenId("[CLS]"));
    expect(t.encode("a" + " ".repeat(30) + "b")).toContain(t.tokenId(" ".repeat(24)));
    expect(t.encode("email |||EMAIL_ADDRESS||| now")).toContain(t.tokenId("|||EMAIL_ADDRESS|||"));
    expect(t.encode("café — naïve 東京 😀").length).toBeGreaterThan(0);
    expect(t.decode(t.encode("café — naïve 東京 😀 it's ok"))).toBe("café — naïve 東京 😀 it's ok");
  });

  it("marker and special ids come from the files; meta.json must agree with the tokenizer", () => {
    const meta = readJson<any>(modelFile("meta.json"));
    const packer = new Packer(tok as Tokenizer, { markers: meta.markers, clsId: meta.cls_id, sepId: meta.sep_id });
    expect(packer.marker["[Q]"]).toBe(meta.markers["[Q]"]);
    expect(packer.clsId).toBe(meta.cls_id);
    expect(() => new Packer(tok as Tokenizer, { markers: { "[Q]": 7 } })).toThrow(ModelUnsupportedError);
  });

  it("throws a typed max_tokens_exceeded error (positions = state + longest branch; total = whole sequence)", () => {
    const packer = new Packer(tok as Tokenizer, { maxPositions: 64, maxTotal: 200 });
    const q = { q: { type: "choice", instructions: "pick", criteria: { a: "x", b: "y" } } };
    expect(() => packer.pack({ s: "word ".repeat(80) }, q)).toThrow(MaxTokensExceededError);
    try {
      packer.pack({ s: "word ".repeat(80) }, q);
    } catch (e) {
      const err = e as MaxTokensExceededError;
      expect(err.code).toBe("max_tokens_exceeded");
      expect(err.detail?.detail).toBe("max_tokens_exceeded");
      expect(err.tokens).toBeGreaterThan(64);
      expect(err.maxTokens).toBe(64);
    }
    // many options: positions fit (they restart per option), the total does not
    const many = { q: { type: "choice", instructions: "pick", criteria: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`opt${i}`, `option number ${i}`])) } };
    const m = packer.measure({ s: "short" }, many);
    expect(m.positions).toBeLessThanOrEqual(64);
    expect(m.total).toBeGreaterThan(200);
    expect(() => packer.pack({ s: "short" }, many)).toThrow(MaxTokensExceededError);
  });

  it("Map criteria keep integer-like label order; empty choices are rejected", () => {
    const packer = new Packer(tok as Tokenizer);
    const crit = new Map<string, string | null>([["10", "ten"], ["2", null], ["a", "letter"]]);
    const { packed } = packer.pack({ s: "x" }, { q: { type: "choice", instructions: "pick", criteria: crit } });
    expect(packed.qIndex.get("q")?.labels).toEqual(["10", "2", "a"]);
    expect(() => packer.pack({ s: "x" }, { q: { type: "choice", instructions: "pick", criteria: {} } })).toThrow(ModelInputError);
  });

  it("feed plan and logits unpacking follow the export script (dummy rows for absent kinds, padding ignored)", () => {
    const packer = new Packer(tok as Tokenizer);
    const { packed } = packer.pack({ s: "x" }, {
      a: { type: "choice", instructions: "A", criteria: { p: null, q: null, r: null } },
      n: { type: "noul", instructions: "N" },
      b: { type: "choice", instructions: "B", criteria: { s: null, t: null } },
    });
    const plan = planInputs(packed);
    expect(plan.choice.k).toBe(3);
    expect(plan.choice.items[1][2]).toBe(0);
    expect(plan.score).toEqual({ q: [0], items: [[0]], k: 1 });
    expect(plan.noul.q.length).toBe(1);
    const logits = unpackLogits(packed, {
      choice: { data: Float32Array.from([1, 2, 3, 4, 5, 99]), dims: [2, 3] },
      score: { data: Float32Array.from([0]), dims: [1, 1] },
      noul: { data: Float32Array.from([7]), dims: [1] },
    });
    expect(logits.get("a")).toEqual([1, 2, 3]);
    expect(logits.get("b")).toEqual([4, 5]);
    expect(logits.get("n")).toEqual([7]);
  });
});

describe.skipIf(!HAVE_TOK || !py)("tokenizer vs HF tokenizers (edge cases)", () => {
  it("full vocabulary: identical ids", () => {
    const t = tok as Tokenizer;
    const bad: string[] = [];
    for (const c of py.tokenize as Array<{ text: string; ids: number[] }>) {
      const got = t.encode(c.text);
      if (JSON.stringify(got) !== JSON.stringify(c.ids)) bad.push(`${JSON.stringify(c.text)}: got ${JSON.stringify(got)} want ${JSON.stringify(c.ids)}`);
    }
    expect(bad).toEqual([]);
  });

  it("pruned vocabulary (runtime-model style): same pruned file, identical ids, markers read from the file", async () => {
    const pruned = pruneTokenizer(tokJson, py.pruned.n_merges);
    expect(await vocabDigest(pruned)).toBe(py.pruned.digest);
    const t = new Tokenizer(pruned);
    expect(t.vocabSize).toBe(py.pruned.vocab_size);
    for (const [m, id] of Object.entries(py.pruned.markers)) expect(t.tokenId(m)).toBe(id);
    const bad: string[] = [];
    for (const c of py.pruned.texts as Array<{ text: string; ids: number[] }>) {
      const got = t.encode(c.text);
      if (JSON.stringify(got) !== JSON.stringify(c.ids)) bad.push(`${JSON.stringify(c.text)}: got ${JSON.stringify(got)} want ${JSON.stringify(c.ids)}`);
      for (const id of got) expect(id).toBeLessThan(t.vocabSize);
    }
    expect(bad).toEqual([]);
    // the packer takes the remapped marker ids from the tokenizer (or meta.json)
    const packer = new Packer(t);
    expect(packer.marker["[Q]"]).toBe(py.pruned.markers["[Q]"]);
    const { packed } = packer.pack({ app: "Shop", trigger: "a write" }, { d: { type: "noul", instructions: "ok?" } });
    expect(packed.inputIds[0]).toBe(py.pruned.markers["[CLS]"]);
    expect(Math.max(...packed.inputIds)).toBeLessThan(t.vocabSize);
  });
});

describe.skipIf(!HAVE_TOK)("tokenizer performance", () => {
  it("builds from tokenizer.json and encodes a 1,000-token situation quickly", () => {
    const t0 = performance.now();
    const t = new Tokenizer(tokJson as TokenizerJson);
    const build = performance.now() - t0;
    const text = Array.from({ length: 120 }, (_, i) => `-${(i * 0.137).toFixed(2)}s GET /api/items/${i}?q=search${i} ok 200 (${i * 7} ms)`).join("\n");
    const t1 = performance.now();
    const n = t.encode(text).length;
    const enc = performance.now() - t1;
    console.log(`[tokenizer] build ${build.toFixed(0)} ms, encode ${n} tokens (cold cache) ${enc.toFixed(1)} ms`);
    expect(n).toBeGreaterThan(500);
    expect(build).toBeLessThan(2000);
  });
});
