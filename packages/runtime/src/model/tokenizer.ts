// Byte-level BPE for a HF `tokenizers` tokenizer.json (the ModernBERT/ettin tokenizer, or a pruned copy of it),
// reproducing `encode(text, add_special_tokens=False)` with `encode_special_tokens = True` as jev_local's Packer
// calls it:
// - special added tokens ([CLS], [Q], ...) are NEVER matched in text, so user text cannot forge a marker;
// - non-special added tokens (|||IP_ADDRESS|||, [unusedN], runs of 2-24 spaces) are split out first,
//   leftmost-longest, and keep their own ids;
// - the rest: normalizer (NFC) -> ByteLevel pre-tokenizer regex -> bytes-to-unicode -> BPE merges.
//
// Nothing is hardcoded: vocab size, ids, merges, added tokens, normalizer and pre-tokenizer options all come from
// the file, so a pruned vocabulary with remapped ids works unchanged. Merges are applied exactly like
// tokenizers' `Word::merge_all` (a min-heap on (rank, position) with stale-entry checks), O(n log n) per word, on
// integer ids rather than strings; words are cached.

import { ModelUnsupportedError } from "./errors.js";

export interface AddedTokenJson {
  id: number;
  content: string;
  special?: boolean;
  normalized?: boolean;
  lstrip?: boolean;
  rstrip?: boolean;
  single_word?: boolean;
}

export interface TokenizerJson {
  model: {
    type: string;
    vocab: Record<string, number>;
    merges: Array<string | [string, string]>;
    dropout?: number | null;
    unk_token?: string | null;
    continuing_subword_prefix?: string | null;
    end_of_word_suffix?: string | null;
    byte_fallback?: boolean;
    ignore_merges?: boolean;
  };
  added_tokens?: AddedTokenJson[];
  normalizer?: { type: string; normalizers?: unknown[] } | null;
  pre_tokenizer?: { type: string; add_prefix_space?: boolean; use_regex?: boolean; pretokenizers?: unknown[] } | null;
}

/** GPT-2 ByteLevel pre-tokenizer pattern. `\s` is spelled \p{White_Space}: that is what the Rust/Oniguruma `\s` of
 * `tokenizers` matches (JS `\s` adds U+FEFF and drops U+0085). */
const PRETOK_RE =
  /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\p{White_Space}\p{L}\p{N}]+|\p{White_Space}+(?!\P{White_Space})|\p{White_Space}+/gu;

/** Ids must stay below this so a pair of ids packs into one safe integer key. */
const ID_SPACE = 2 ** 26;

/** bytes_to_unicode() of GPT-2: byte -> printable unicode char. */
export function bytesToUnicode(): string[] {
  const bs: number[] = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  const m = new Array<string>(256);
  bs.forEach((b, i) => {
    m[b] = String.fromCodePoint(cs[i]);
  });
  return m;
}

function normalizerOf(n: TokenizerJson["normalizer"]): (s: string) => string {
  if (!n) return (s) => s;
  switch (n.type) {
    case "NFC":
    case "NFD":
    case "NFKC":
    case "NFKD": {
      const form = n.type;
      // ASCII is invariant under every normalization form: skip the call for the common case.
      return (s) => (/^[\x00-\x7f]*$/.test(s) ? s : s.normalize(form));
    }
    case "Lowercase":
      return (s) => s.toLowerCase();
    case "Sequence": {
      const fns = (n.normalizers ?? []).map((x) => normalizerOf(x as TokenizerJson["normalizer"]));
      return (s) => fns.reduce((acc, f) => f(acc), s);
    }
    default:
      throw new ModelUnsupportedError(`unsupported tokenizer normalizer ${n.type}`);
  }
}

function byteLevelOf(p: TokenizerJson["pre_tokenizer"]): { addPrefixSpace: boolean; useRegex: boolean } {
  if (!p) throw new ModelUnsupportedError("tokenizer has no pre_tokenizer (a ByteLevel pre-tokenizer is required)");
  if (p.type === "ByteLevel") return { addPrefixSpace: !!p.add_prefix_space, useRegex: p.use_regex !== false };
  if (p.type === "Sequence" && Array.isArray(p.pretokenizers) && p.pretokenizers.length === 1) {
    return byteLevelOf(p.pretokenizers[0] as TokenizerJson["pre_tokenizer"]);
  }
  throw new ModelUnsupportedError(`unsupported tokenizer pre_tokenizer ${p.type}`);
}

export class Tokenizer {
  /** Highest id + 1 over the vocab and the added tokens. */
  readonly vocabSize: number;
  /** The BPE model's vocab (token string -> id). */
  private readonly modelVocab = new Map<string, number>();
  /** Every added token (special or not): content -> id. */
  private readonly added = new Map<string, number>();
  /** (left id * ID_SPACE + right id) -> rank * ID_SPACE + merged id. */
  private readonly merges = new Map<number, number>();
  private readonly byteIds = new Int32Array(256);
  private readonly byteChars: string[];
  private readonly matchable = new Map<string, number>();
  private readonly matchLens: number[];
  private readonly matchFirst: Set<string>;
  private readonly normalize: (s: string) => string;
  private readonly addPrefixSpace: boolean;
  private readonly useRegex: boolean;
  private readonly ignoreMerges: boolean;
  private readonly cache = new Map<string, number[]>();
  private readonly cacheLimit: number;
  private readonly encoder = new TextEncoder();
  private idToToken: string[] | null = null;
  private byteOf: Map<string, number> | null = null;

  constructor(json: TokenizerJson, opts: { cacheSize?: number } = {}) {
    const model = json?.model;
    if (!model || model.type !== "BPE") throw new ModelUnsupportedError(`unsupported tokenizer model ${model?.type ?? "(none)"}`);
    if (model.dropout) throw new ModelUnsupportedError("BPE dropout is not supported at inference");
    if (model.continuing_subword_prefix || model.end_of_word_suffix) throw new ModelUnsupportedError("BPE subword prefixes/suffixes are not supported");
    this.cacheLimit = opts.cacheSize ?? 20000;
    this.normalize = normalizerOf(json.normalizer);
    const pre = byteLevelOf(json.pre_tokenizer);
    this.addPrefixSpace = pre.addPrefixSpace;
    this.useRegex = pre.useRegex;
    this.ignoreMerges = !!model.ignore_merges;

    let maxId = -1;
    for (const [tok, id] of Object.entries(model.vocab)) {
      this.modelVocab.set(tok, id);
      if (id > maxId) maxId = id;
    }
    for (const t of json.added_tokens ?? []) {
      this.added.set(t.content, t.id);
      if (t.id > maxId) maxId = t.id;
      if (t.special) continue;
      if (t.lstrip || t.rstrip || t.single_word) {
        throw new ModelUnsupportedError(`added token ${JSON.stringify(t.content)} uses lstrip/rstrip/single_word, which this tokenizer does not support`);
      }
      this.matchable.set(t.content, t.id);
    }
    if (maxId >= ID_SPACE) throw new ModelUnsupportedError(`tokenizer ids up to ${maxId} exceed ${ID_SPACE}`);
    this.vocabSize = maxId + 1;
    this.matchLens = [...new Set([...this.matchable.keys()].map((s) => s.length))].sort((a, b) => b - a);
    this.matchFirst = new Set([...this.matchable.keys()].map((s) => s[0]));

    this.byteChars = bytesToUnicode();
    for (let b = 0; b < 256; b++) {
      // Bytes that never occur in UTF-8 (0xC0, 0xC1, 0xF5-0xFF) may be missing from the vocab: -1, never looked up.
      this.byteIds[b] = this.modelVocab.get(this.byteChars[b]) ?? -1;
    }
    for (let b = 0; b < 256; b++) {
      const neverInUtf8 = b === 0xc0 || b === 0xc1 || b >= 0xf5;
      if (this.byteIds[b] < 0 && !neverInUtf8) throw new ModelUnsupportedError(`byte-level token for byte ${b} is missing from the vocab`);
    }
    const merges = model.merges;
    for (let rank = 0; rank < merges.length; rank++) {
      const m = merges[rank];
      let a: string;
      let b: string;
      if (Array.isArray(m)) [a, b] = m;
      else {
        const parts = m.split(" ");
        if (parts.length !== 2) throw new ModelUnsupportedError(`malformed merge ${rank}: ${JSON.stringify(m)}`);
        [a, b] = parts;
      }
      const ia = this.modelVocab.get(a);
      const ib = this.modelVocab.get(b);
      const im = this.modelVocab.get(a + b);
      if (ia === undefined || ib === undefined || im === undefined) {
        throw new ModelUnsupportedError(`merge ${rank} (${JSON.stringify(a)} ${JSON.stringify(b)}) refers to a token missing from the vocab`);
      }
      // HashMap::from_iter semantics: a repeated pair keeps its last rank.
      this.merges.set(ia * ID_SPACE + ib, rank * ID_SPACE + im);
    }
  }

  /** Id of a token string (vocab or added token), e.g. tokenId("[Q]"). */
  tokenId(s: string): number | undefined {
    return this.added.get(s) ?? this.modelVocab.get(s);
  }

  /** Token ids of `text` with no special tokens added. */
  encode(text: string): number[] {
    const ids: number[] = [];
    if (!text) return ids;
    for (const seg of this.splitAdded(this.normalize(text))) {
      if (typeof seg === "number") ids.push(seg);
      else this.encodePiece(seg, ids);
    }
    return ids;
  }

  /** Number of tokens of `text` (no special tokens). */
  count(text: string): number {
    return this.encode(text).length;
  }

  /** Text of token ids (byte-level decoding; added tokens verbatim). For logs, tests and truncation. */
  decode(ids: readonly number[]): string {
    if (!this.idToToken) {
      const arr: string[] = [];
      for (const [t, id] of this.added) arr[id] = t;
      for (const [t, id] of this.modelVocab) if (arr[id] === undefined) arr[id] = t;
      this.idToToken = arr;
      this.byteOf = new Map(this.byteChars.map((c, b) => [c, b]));
    }
    const inv = this.byteOf as Map<string, number>;
    const out: string[] = [];
    let bytes: number[] = [];
    const flush = () => {
      if (bytes.length) out.push(new TextDecoder().decode(new Uint8Array(bytes)));
      bytes = [];
    };
    for (const id of ids) {
      const tok = this.idToToken[id];
      if (tok === undefined) continue;
      if (this.matchable.has(tok) || [...tok].some((c) => !inv.has(c))) {
        flush();
        out.push(tok);
      } else for (const c of tok) bytes.push(inv.get(c) as number);
    }
    flush();
    return out.join("");
  }

  /** Split around non-special added tokens (leftmost-longest): strings to BPE, numbers are added-token ids. */
  private splitAdded(text: string): Array<string | number> {
    if (!this.matchable.size) return [text];
    const out: Array<string | number> = [];
    let start = 0;
    let i = 0;
    while (i < text.length) {
      let hitLen = 0;
      let hitId = -1;
      if (this.matchFirst.has(text[i])) {
        for (const L of this.matchLens) {
          if (i + L > text.length) continue;
          const id = this.matchable.get(text.substr(i, L));
          if (id !== undefined) {
            hitLen = L;
            hitId = id;
            break;
          }
        }
      }
      if (hitLen) {
        if (i > start) out.push(text.slice(start, i));
        out.push(hitId);
        i += hitLen;
        start = i;
      } else i++;
    }
    if (start < text.length) out.push(text.slice(start));
    return out;
  }

  private encodePiece(piece: string, out: number[]): void {
    let s = piece;
    if (this.addPrefixSpace && !s.startsWith(" ")) s = " " + s;
    if (!this.useRegex) {
      for (const id of this.word(s)) out.push(id);
      return;
    }
    PRETOK_RE.lastIndex = 0;
    for (const m of s.matchAll(PRETOK_RE)) for (const id of this.word(m[0])) out.push(id);
  }

  /** BPE ids of one pre-tokenized word (cached). */
  private word(w: string): number[] {
    const hit = this.cache.get(w);
    if (hit) return hit;
    const bytes = this.encoder.encode(w);
    let ids: number[];
    if (this.ignoreMerges) {
      let s = "";
      for (const b of bytes) s += this.byteChars[b];
      const whole = this.modelVocab.get(s);
      ids = whole !== undefined ? [whole] : this.mergeAll(bytes);
    } else ids = this.mergeAll(bytes);
    if (this.cache.size >= this.cacheLimit) this.cache.clear();
    this.cache.set(w, ids);
    return ids;
  }

  /** tokenizers `Word::merge_all` (no dropout): min-heap on (rank, pos), stale entries skipped. */
  private mergeAll(bytes: Uint8Array): number[] {
    const n = bytes.length;
    const c = new Int32Array(n);
    for (let i = 0; i < n; i++) c[i] = this.byteIds[bytes[i]];
    if (n < 2) return Array.from(c);
    const prev = new Int32Array(n);
    const next = new Int32Array(n);
    const len = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      prev[i] = i - 1;
      next[i] = i + 1 < n ? i + 1 : -1;
      len[i] = 1;
    }
    const heap = new MergeHeap();
    const merges = this.merges;
    for (let i = 0; i < n - 1; i++) {
      const v = merges.get(c[i] * ID_SPACE + c[i + 1]);
      if (v !== undefined) {
        const rank = Math.floor(v / ID_SPACE);
        heap.push(rank, i, v - rank * ID_SPACE);
      }
    }
    while (heap.size) {
      heap.pop();
      const pos = heap.topPos;
      if (len[pos] === 0) continue;
      const nx = next[pos];
      if (nx === -1) continue;
      const cur = merges.get(c[pos] * ID_SPACE + c[nx]);
      if (cur === undefined || cur - Math.floor(cur / ID_SPACE) * ID_SPACE !== heap.topNew) continue;
      // merge the right symbol into pos
      c[pos] = heap.topNew;
      len[nx] = 0;
      const after = next[nx];
      next[pos] = after;
      if (after !== -1) prev[after] = pos;
      const pv = prev[pos];
      if (pv >= 0) {
        const v = merges.get(c[pv] * ID_SPACE + c[pos]);
        if (v !== undefined) {
          const rank = Math.floor(v / ID_SPACE);
          heap.push(rank, pv, v - rank * ID_SPACE);
        }
      }
      if (after !== -1) {
        const v = merges.get(c[pos] * ID_SPACE + c[after]);
        if (v !== undefined) {
          const rank = Math.floor(v / ID_SPACE);
          heap.push(rank, pos, v - rank * ID_SPACE);
        }
      }
    }
    const ids: number[] = [];
    for (let i = 0; i < n; i++) if (len[i]) ids.push(c[i]);
    return ids;
  }
}

/** Binary min-heap of merge candidates ordered by (rank, pos), as tokenizers' `Merge` Ord. */
class MergeHeap {
  private r: number[] = [];
  private p: number[] = [];
  private m: number[] = [];
  topRank = 0;
  topPos = 0;
  topNew = 0;

  get size(): number {
    return this.r.length;
  }

  private less(i: number, j: number): boolean {
    return this.r[i] < this.r[j] || (this.r[i] === this.r[j] && this.p[i] < this.p[j]);
  }

  private swap(i: number, j: number): void {
    const { r, p, m } = this;
    [r[i], r[j]] = [r[j], r[i]];
    [p[i], p[j]] = [p[j], p[i]];
    [m[i], m[j]] = [m[j], m[i]];
  }

  push(rank: number, pos: number, nid: number): void {
    this.r.push(rank);
    this.p.push(pos);
    this.m.push(nid);
    let i = this.r.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): void {
    this.topRank = this.r[0];
    this.topPos = this.p[0];
    this.topNew = this.m[0];
    const last = this.r.length - 1;
    if (last > 0) this.swap(0, last);
    this.r.pop();
    this.p.pop();
    this.m.pop();
    const n = this.r.length;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const rr = l + 1;
      let best = i;
      if (l < n && this.less(l, best)) best = l;
      if (rr < n && this.less(rr, best)) best = rr;
      if (best === i) break;
      this.swap(i, best);
      i = best;
    }
  }
}
