// Helpers shared by feature implementations.

import { API_STYLES, canonical, type ApiStyle, type Item } from "../../net/server.js";
import type { Knowledge } from "../../oracle/knowledge.js";
import type { Rng } from "../../rng.js";
import type { Entity } from "../vocab.js";
import { itemName, numIn } from "../feature.js";

/** Content fingerprint of a list of items (ids in order). */
export function idsKey(list: unknown): string {
  if (!Array.isArray(list)) return canonical(list);
  return list.map((x) => (x && typeof x === "object" && "id" in x ? String((x as Item).id) : canonical(x))).join(",");
}

/**
 * Remembers which intent produced which content for a key, so classifiers can tell which intent the currently
 * displayed data reflects ("shown intent") by content, independent of how the runtime applies writes.
 */
export class ContentBook {
  private byIntent = new Map<number, string>();
  constructor(readonly know: Knowledge) {}
  note(intent: number | undefined, content: string): void {
    if (intent !== undefined) this.byIntent.set(intent, content);
  }
  get(intent: number): string | undefined {
    return this.byIntent.get(intent);
  }
  /** Latest intent (<= maxIntent) whose content equals `content`. */
  shown(content: string, maxIntent = Infinity): number | undefined {
    let best: number | undefined;
    for (const [i, c] of this.byIntent) if (c === content && i <= maxIntent && (best === undefined || i > best)) best = i;
    return best;
  }
}

/** Seed items for an entity collection. */
export function seedItems(rng: Rng, e: Entity, n: number, extra?: (it: Item, i: number) => void): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < n; i++) {
    const it: Item = { [e.name]: itemName(rng, e, i) };
    for (const [f, lo, hi, dec] of e.nums.slice(0, 2)) it[f] = numIn(rng, lo, hi, dec);
    if (e.status.length) it.status = e.status[0]!;
    for (const fl of e.flags.slice(0, 1)) it[fl] = rng.bool(0.2);
    extra?.(it, i);
    out.push(it);
  }
  return out;
}

export function weightsOf(pairs: [string, number][]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const [k, v] of pairs) o[k] = v;
  return o;
}

/** Query words users type for an entity: prefixes of item-name words. */
export function queryWords(rng: Rng, e: Entity): string[] {
  const words = e.words.filter((w) => /^[a-z]/i.test(w) && w.length >= 3);
  return rng.shuffle(words.length ? words : [e.p]);
}

export function errMsg(status: number, outcome: string): string {
  if (outcome === "timeout") return "Request timed out";
  if (outcome === "neterr") return "Network error";
  if (status === 429) return "Too many requests";
  if (status >= 500) return `Server error (${status})`;
  if (status === 409) return "Conflict";
  return `Request failed (${status || outcome})`;
}

export function apiOf(name: string): ApiStyle {
  return API_STYLES.find((a) => a.name === name) ?? API_STYLES[0]!;
}
