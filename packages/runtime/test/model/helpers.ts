import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIX = join(PKG, "test", "fixtures", "model");
/** Model directory downloaded with `genclass-runtime fetch-model` (GENCLASS_MODEL_DIR, default <repo>/.cache-model). */
export const MODEL_DIR = process.env.GENCLASS_MODEL_DIR ? resolve(process.env.GENCLASS_MODEL_DIR) : resolve(PKG, "..", "..", ".cache-model");

export const readJson = <T = unknown>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
export const modelFile = (f: string): string => join(MODEL_DIR, f);
export const hasModelFile = (f: string): boolean => existsSync(modelFile(f));

export interface PackFixture {
  id: string;
  input_ids: number[];
  position_ids: number[];
  q_group: number[];
  i_group: number[];
  n_state: number;
  q_index: Record<string, { kind: string; header: string; labels: string[]; q_pos: number; item_pos: number[] }>;
}
export interface TorchFixture {
  id: string;
  logits: Record<string, number[]>;
  probs: Record<string, number[]>;
  header_key: Record<string, string>;
}
export interface RequestFixture {
  id: string;
  state: Record<string, unknown>;
  questions: Record<string, { type: string; instructions?: unknown; criteria?: unknown }>;
}

/**
 * Parity fixtures: from the model directory when it ships them (TRAIN's export_runtime.py writes requests.json,
 * pack_fixtures.json, torch_fixtures.json and parity.json next to the model), else the v0.1 set in fixtures/model.
 */
export const FIXTURES_FROM_MODEL = ["requests.json", "pack_fixtures.json", "torch_fixtures.json"].every((f) => existsSync(join(MODEL_DIR, f)));
const fixture = (own: string, v01: string) => (FIXTURES_FROM_MODEL ? join(MODEL_DIR, own) : join(FIX, v01));
export const requests = (): RequestFixture[] => readJson<RequestFixture[]>(fixture("requests.json", "requests50.json"));

/**
 * Ids of fixture requests whose JSON holds integral floats written Python-style ("25.0"): Python renders them as
 * "25.0", but a JavaScript runtime can only ever produce "25", so their packing cannot match (and such rows teach
 * the model a text the runtime never sends). Uses JSON.parse source-text access (Node >= 21).
 */
export function pythonOnlyFloatRequests(): Set<string> {
  const text = readFileSync(fixture("requests.json", "requests50.json"), "utf8");
  const ids = new Set<string>();
  let hit = false;
  const reviver = function (this: unknown, key: string, value: unknown, ctx?: { source?: string }) {
    if (typeof value === "number" && Number.isInteger(value) && ctx?.source && /[.eE]/.test(ctx.source)) hit = true;
    if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { id?: unknown }).id === "string" && "state" in (value as object) && "questions" in (value as object)) {
      if (hit) ids.add((value as { id: string }).id);
      hit = false;
    }
    return value;
  };
  JSON.parse(text, reviver as (k: string, v: unknown) => unknown);
  return ids;
}
export const packs = (): PackFixture[] => readJson<PackFixture[]>(fixture("pack_fixtures.json", "pack_fixtures.json"));
export const torch = (): TorchFixture[] => readJson<TorchFixture[]>(fixture("torch_fixtures.json", "torch_fixtures.json"));
/** The export's own parity report (ORT CPU vs PyTorch), when the model directory has one. */
export const exportParity = (): Record<string, any> | null => (existsSync(join(MODEL_DIR, "parity.json")) ? readJson(join(MODEL_DIR, "parity.json")) : null);
export const pyFixturesPath = join(FIX, "py_fixtures.json");
/** The v0.1 GenClass tokenizer (50,009 merges): the HF edge-case fixtures were generated from it. */
export const isV01Tokenizer = (json: any): boolean => json?.model?.merges?.length === 50009 && Object.keys(json?.model?.vocab ?? {}).length === 50280;

/**
 * Wire questions with choice criteria as Maps in the order Python used (JSON.parse would move integer-like keys
 * first; the fixtures have none, but this keeps the parity tests independent of that).
 */
export function questionsInPythonOrder(r: RequestFixture, p: PackFixture): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [qid, q] of Object.entries(r.questions)) {
    if (q.type === "choice") {
      const crit = q.criteria as Record<string, unknown>;
      out[qid] = { ...q, criteria: new Map(p.q_index[qid].labels.map((l) => [l, crit[l] ?? null])) };
    } else out[qid] = q;
  }
  return out;
}

/**
 * Pruned vocabulary, as the runtime model's export does it: keep the 256 byte tokens, the first `nMerges` merges and
 * every added token, then renumber by old id. Mirrors prune_tokenizer() in fixtures/model/make_py_fixtures.py.
 */
export function pruneTokenizer(json: any, nMerges: number): any {
  const model = json.model;
  const merges: Array<string | [string, string]> = model.merges.slice(0, nMerges);
  const pair = (m: string | [string, string]): [string, string] => (Array.isArray(m) ? m : (m.split(" ") as [string, string]));
  // bytes that never occur in UTF-8 (0xC0, 0xC1, 0xF5-0xFF) may be absent from the vocab
  const keep = new Set<string>(bytesToUnicodeChars().filter((c) => model.vocab[c] !== undefined));
  for (const m of merges) {
    const [a, b] = pair(m);
    keep.add(a + b);
  }
  const added: Array<{ id: number; content: string }> = json.added_tokens ?? [];
  const old = new Map<string, number>();
  for (const s of keep) {
    const id = model.vocab[s];
    if (id === undefined) throw new Error(`pruned token ${JSON.stringify(s)} missing from the vocab`);
    old.set(s, id);
  }
  for (const t of added) old.set(t.content, t.id);
  const newId = new Map([...old.entries()].sort((x, y) => x[1] - y[1]).map(([s], i) => [s, i]));
  const addedContents = new Set(added.map((t) => t.content));
  const vocab: Record<string, number> = {};
  for (const s of Object.keys(model.vocab)) if (keep.has(s) || addedContents.has(s)) vocab[s] = newId.get(s) as number;
  return { ...json, added_tokens: added.map((t) => ({ ...t, id: newId.get(t.content) })), model: { ...model, vocab, merges } };
}

function bytesToUnicodeChars(): string[] {
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
  return cs.map((c) => String.fromCodePoint(c));
}

/** sha256 of the sorted "token\tid" lines: the same digest the Python fixture records for its pruned vocab. */
export async function vocabDigest(json: any): Promise<string> {
  const { createHash } = await import("node:crypto");
  // Python sorts str by code point = UTF-8 byte order (JS's default sort compares UTF-16 units).
  const lines = Object.entries(json.model.vocab as Record<string, number>)
    .map(([t, id]) => `${t}\t${id}`)
    .concat((json.added_tokens as Array<{ content: string; id: number }>).map((t) => `+${t.content}\t${t.id}`))
    .sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}
