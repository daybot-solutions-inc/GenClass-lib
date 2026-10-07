// Pack (state, questions) into one encoder sequence: port of jev_local/engine/encoder/tokenize_pack.Packer with
// FastEngine's length semantics, plus the ONNX feed plan of scripts/genclass_export.py.
//
//   [CLS] seg_0 [SEP] seg_1 [SEP] ... | [Q] header_0 | [O] item_00 | [O] item_01 | ... | [Q] header_1 | ...
//
// q_group: -1 for state tokens, else the question ordinal. i_group: -1 for state and header tokens, else the item
// ordinal. Positions restart per branch (header at S.., every item at S+len(header)..), so `max_len` bounds the
// state plus the longest single branch, not the whole sequence. The graph builds the block attention mask from
// these (a token sees the state, plus its own header and its own item).
//
// Marker and special ids come from meta.json when given (checked against the tokenizer), else from the tokenizer.

import { MaxTokensExceededError, ModelUnsupportedError } from "./errors.js";
import { questionBlock, questionEntries, segmentText, stateSegments, type BlockKind, type QBlock, type Segment } from "./serialize.js";
import type { Tokenizer } from "./tokenizer.js";

export const MARKERS = ["[Q]", "[O]", "[L]", "[T]", "[F]"] as const;
export type Marker = (typeof MARKERS)[number];
export const STATE = -1;

export interface PackedQuestion {
  kind: BlockKind;
  header: string;
  labels: string[];
  /** Token index of the [Q] marker. */
  qPos: number;
  /** Token index of each [O]/[L] item marker, or [T], [F] for noul. */
  itemPos: number[];
}

export interface Packed {
  inputIds: number[];
  positionIds: number[];
  qGroup: number[];
  iGroup: number[];
  nState: number;
  qIndex: Map<string, PackedQuestion>;
}

export interface PackerOptions {
  /** Longest state + header + option one question branch may see (meta.json max_len). */
  maxPositions?: number;
  /** Token budget of the whole sequence (one forward pass). */
  maxTotal?: number;
  cacheSize?: number;
  /** meta.json `markers` / `cls_id` / `sep_id`; read from the tokenizer when absent. */
  markers?: Partial<Record<string, number>>;
  clsId?: number;
  sepId?: number;
}

type Part = { header: number[]; items: number[][] };

export class Packer {
  readonly maxPositions: number;
  readonly maxTotal: number;
  readonly clsId: number;
  readonly sepId: number;
  readonly marker: Record<Marker, number>;
  private readonly tok: Tokenizer;
  private readonly cacheSize: number;
  private readonly cache = new Map<string, number[]>();

  constructor(tokenizer: Tokenizer, opts: PackerOptions = {}) {
    this.tok = tokenizer;
    this.maxPositions = opts.maxPositions ?? 1536;
    this.maxTotal = opts.maxTotal ?? 8192;
    this.cacheSize = opts.cacheSize ?? 8192;
    const pick = (name: string, given: number | undefined): number => {
      const fromTok = tokenizer.tokenId(name);
      if (given !== undefined && given !== null) {
        if (fromTok !== undefined && fromTok !== given) {
          throw new ModelUnsupportedError(`meta.json says ${name} is ${given} but tokenizer.json says ${fromTok}`);
        }
        return given;
      }
      if (fromTok === undefined) throw new ModelUnsupportedError(`tokenizer lacks token ${name}`);
      return fromTok;
    };
    const marker = {} as Record<Marker, number>;
    for (const m of MARKERS) marker[m] = pick(m, opts.markers?.[m]);
    this.marker = marker;
    this.clsId = pick("[CLS]", opts.clsId);
    this.sepId = pick("[SEP]", opts.sepId);
  }

  /** Token ids of one text (no special tokens), cached like the Python Packer. */
  encode(text: string): number[] {
    let ids = this.cache.get(text);
    if (!ids) {
      ids = this.tok.encode(text);
      if (this.cache.size >= this.cacheSize) this.cache.clear();
      this.cache.set(text, ids);
    }
    return ids;
  }

  stateIds(segments: Segment[]): number[] {
    const ids = [this.clsId];
    for (const s of segments) {
      for (const t of this.encode(segmentText(s))) ids.push(t);
      ids.push(this.sepId);
    }
    return ids;
  }

  private itemMarkers(b: QBlock): number[] {
    if (b.kind === "choice") return b.items.map(() => this.marker["[O]"]);
    if (b.kind === "score") return b.items.map(() => this.marker["[L]"]);
    return [this.marker["[T]"], this.marker["[F]"]];
  }

  private blockParts(blocks: QBlock[]): Part[] {
    return blocks.map((b) => {
      const marks = this.itemMarkers(b);
      return { header: [this.marker["[Q]"], ...this.encode(b.header)], items: b.items.map((it, j) => [marks[j], ...this.encode(it)]) };
    });
  }

  private layout(state: number[], blocks: QBlock[], parts: Part[]): Packed {
    const s = state.length;
    const ids = state.slice();
    const pos = Array.from({ length: s }, (_, i) => i);
    const qg = new Array<number>(s).fill(STATE);
    const ig = new Array<number>(s).fill(STATE);
    const qIndex = new Map<string, PackedQuestion>();
    blocks.forEach((b, qn) => {
      const { header, items } = parts[qn];
      const qPos = ids.length;
      header.forEach((t, j) => {
        ids.push(t);
        pos.push(s + j);
        qg.push(qn);
        ig.push(STATE);
      });
      const base = s + header.length;
      const itemPos: number[] = [];
      items.forEach((item, j) => {
        itemPos.push(ids.length);
        item.forEach((t, k) => {
          ids.push(t);
          pos.push(base + k);
          qg.push(qn);
          ig.push(j);
        });
      });
      qIndex.set(b.qid, { kind: b.kind, header: b.header, labels: b.labels, qPos, itemPos });
    });
    return { inputIds: ids, positionIds: pos, qGroup: qg, iGroup: ig, nState: s, qIndex };
  }

  /** Full pipeline from a wire request. Throws MaxTokensExceededError when a branch (or the whole sequence) is too long. */
  pack(state: unknown, questions: unknown): { packed: Packed; blocks: QBlock[] } {
    const segs = stateSegments(state);
    const blocks = questionEntries(questions).map(([qid, q]) => questionBlock(qid, q));
    const st = this.stateIds(segs);
    const parts = this.blockParts(blocks);
    let need = 0;
    let total = st.length;
    for (const p of parts) {
      let longest = 0;
      let sum = 0;
      for (const x of p.items) {
        if (x.length > longest) longest = x.length;
        sum += x.length;
      }
      need = Math.max(need, p.header.length + longest);
      total += p.header.length + sum;
    }
    if (st.length + need > this.maxPositions || total > this.maxTotal) {
      throw new MaxTokensExceededError(st.length + need, total, this.maxPositions, this.maxTotal);
    }
    return { packed: this.layout(st, blocks, parts), blocks };
  }

  /** Token counts without building the sequence: state ([CLS] + segments + [SEP]s), positions needed, total. */
  measure(state: unknown, questions?: unknown): { stateTokens: number; positions: number; total: number } {
    const st = this.stateIds(stateSegments(state)).length;
    if (questions === undefined) return { stateTokens: st, positions: st, total: st };
    const parts = this.blockParts(questionEntries(questions).map(([qid, q]) => questionBlock(qid, q)));
    let need = 0;
    let total = st;
    for (const p of parts) {
      const lens = p.items.map((x) => x.length);
      need = Math.max(need, p.header.length + Math.max(0, ...lens));
      total += p.header.length + lens.reduce((a, b) => a + b, 0);
    }
    return { stateTokens: st, positions: st + need, total };
  }
}

export interface FeedPlan {
  choice: { q: number[]; items: number[][]; k: number };
  score: { q: number[]; items: number[][]; k: number };
  noul: { q: number[]; t: number[]; f: number[] };
}

/** Marker indices per head (genclass_export.py plan_inputs). Kinds with no question get one dummy row at token 0. */
export function planInputs(p: Packed): FeedPlan {
  const by: Record<BlockKind, PackedQuestion[]> = { choice: [], score: [], noul: [] };
  for (const qi of p.qIndex.values()) by[qi.kind].push(qi);
  const grp = (lst: PackedQuestion[]) => {
    if (!lst.length) return { q: [0], items: [[0]], k: 1 };
    const k = Math.max(...lst.map((x) => x.itemPos.length));
    return { q: lst.map((x) => x.qPos), items: lst.map((x) => [...x.itemPos, ...new Array<number>(k - x.itemPos.length).fill(0)]), k };
  };
  const nl = by.noul;
  return {
    choice: grp(by.choice),
    score: grp(by.score),
    noul: nl.length
      ? { q: nl.map((x) => x.qPos), t: nl.map((x) => x.itemPos[0]), f: nl.map((x) => x.itemPos[1]) }
      : { q: [0], t: [0], f: [0] },
  };
}

export interface HeadOutput {
  data: ArrayLike<number>;
  dims: readonly number[];
}

/** Graph outputs -> raw (tau = 1) logits per qid, in request order. Padding columns are ignored. */
export function unpackLogits(p: Packed, out: Partial<Record<BlockKind, HeadOutput>>): Map<string, number[]> {
  const idx: Record<BlockKind, number> = { choice: 0, score: 0, noul: 0 };
  const res = new Map<string, number[]>();
  for (const [qid, qi] of p.qIndex) {
    const g = idx[qi.kind]++;
    const t = out[qi.kind];
    if (!t) throw new ModelUnsupportedError(`the model has no ${qi.kind} head`);
    if (qi.kind === "noul") res.set(qid, [Number(t.data[g])]);
    else {
      const K = t.dims[1];
      const row: number[] = [];
      for (let j = 0; j < qi.labels.length; j++) row.push(Number(t.data[g * K + j]));
      res.set(qid, row);
    }
  }
  return res;
}
