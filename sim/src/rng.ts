// Seeded randomness. Streams are *keyed*: `rng.fork(label)` derives a child from the parent's construction seed and
// the label (not from how many numbers the parent already drew), so adding draws in one place never shifts another
// stream. Counterfactual runs depend on this: forcing an action at one decision point must not change unrelated
// random draws (latencies of other requests, user timings, ...).

/** 32-bit FNV-1a with a murmur3 finalizer. */
export function hash32(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function hashAll(...parts: (string | number | boolean | undefined)[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) h = hash32(String(p), h ^ 0x5bd1e995);
  return h >>> 0;
}

/** Uniform [0,1) from a key, without constructing a stream. */
export function u01(...parts: (string | number | boolean | undefined)[]): number {
  return hashAll(...parts) / 4294967296;
}

export class Rng {
  readonly seed: number;
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number | string) {
    const s = typeof seed === "string" ? hash32(seed) : seed >>> 0;
    this.seed = s;
    // splitmix32 to initialise sfc32
    let x = s;
    const sm = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = sm();
    this.b = sm();
    this.c = sm();
    this.d = sm();
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Child stream keyed by label; independent of how much this stream has been used. */
  fork(...label: (string | number)[]): Rng {
    return new Rng(hashAll(this.seed, ...label));
  }

  next(): number {
    // sfc32
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) >>> 0;
    return t / 4294967296;
  }

  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  float(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("pick from empty array");
    return arr[Math.floor(this.next() * arr.length)]!;
  }

  weighted<T>(items: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of items) total += Math.max(0, w);
    let r = this.next() * total;
    for (const [v, w] of items) {
      r -= Math.max(0, w);
      if (r < 0) return v;
    }
    return items[items.length - 1]![0];
  }

  /** Pick from a record of weights. */
  weightedKey<K extends string>(w: Partial<Record<K, number>>): K {
    return this.weighted(Object.entries(w) as [K, number][]);
  }

  normal(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  lognormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }

  shuffle<T>(arr: readonly T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }

  sample<T>(arr: readonly T[], k: number): T[] {
    return this.shuffle(arr).slice(0, Math.max(0, Math.min(k, arr.length)));
  }

  /** Short base-36 token, e.g. for idempotency keys or slugs. */
  token(len = 8): string {
    let s = "";
    while (s.length < len) s += Math.floor(this.next() * 36).toString(36);
    return s;
  }
}

/** Deterministic lognormal draw from a key. */
export function keyedLognormal(median: number, sigma: number, ...key: (string | number)[]): number {
  const r = new Rng(hashAll(...key));
  return r.lognormal(median, sigma);
}
