// Per-app tokens and dashboards: D1 storage, aggregation of telemetry batches, stats for the dashboard, retention.
//
// - A token (`gc_` + 22 base62) identifies one web app. It is public (ships in client code) and only lets data be
//   sent. The dashboard secret (32 base62) is private; only its SHA-256 hex is stored.
// - Aggregates are counters per (token, UTC day | UTC hour, metric, key). No situation text, no IP, no user agent.
// - Retention (daily cron): daily counters and recent rows 90 days, hourly counters 48 hours, summary state 2 days.

export const TOKEN_RE = /^gc_[A-Za-z0-9]{22}$/;
export const SECRET_RE = /^[A-Za-z0-9]{32}$/;
export const RECENT_CAP = 500;
export const RETENTION_DAYS = 90;
/** Distinct counters one batch may touch (bounds D1 writes per batch). */
export const MAX_COUNTERS = 300;
const KEY_MAX = 120;
const ROWS_PER_STMT = 16; // 5 bound params per row; D1 allows 100 per statement

// --------------------------------------------------------------------------------------------- D1 subset

export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1Like {
  prepare(sql: string): D1Stmt;
  batch(stmts: D1Stmt[]): Promise<unknown[]>;
}

// --------------------------------------------------------------------------------------------- ids, hashing

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** n base62 chars from crypto.getRandomValues, unbiased (rejection sampling). */
export function randomBase62(n: number): string {
  let out = "";
  while (out.length < n) {
    const bytes = crypto.getRandomValues(new Uint8Array(n * 2));
    for (const b of bytes) {
      if (b < 248) out += B62[b % 62];
      if (out.length === n) break;
    }
  }
  return out;
}

export const newToken = (): string => `gc_${randomBase62(22)}`;
export const newSecret = (): string => randomBase62(32);

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Project name: printable text, whitespace collapsed, at most 80 chars; default "Untitled app". */
export function sanitizeName(v: unknown): string {
  if (typeof v !== "string") return "Untitled app";
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  const cut = [...s].slice(0, 80).join("").trim();
  return cut || "Untitled app";
}

export const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
export const hourKey = (d: Date): string => d.toISOString().slice(0, 13);

// --------------------------------------------------------------------------------------------- projects

export interface Project {
  token: string;
  name: string;
  created: string;
  last_event: string | null;
}

export async function createProject(db: D1Like, name: string, now: Date): Promise<{ token: string; secret: string; name: string; created: string }> {
  for (let attempt = 0; ; attempt++) {
    const token = newToken();
    const secret = newSecret();
    const created = now.toISOString();
    try {
      await db
        .prepare("INSERT INTO projects (token, secret_hash, name, created) VALUES (?, ?, ?, ?)")
        .bind(token, await sha256Hex(secret), name, created)
        .run();
      tokenCache.set(token, { ok: true, exp: now.getTime() + CACHE_OK_MS });
      return { token, secret, name, created };
    } catch (e) {
      if (attempt >= 2) throw e; // a collision is astronomically unlikely; anything else is a real error
    }
  }
}

/** Look a project up by its dashboard secret (by hash, so lookup time does not depend on how much of it matches). */
export async function projectBySecret(db: D1Like, secret: string): Promise<Project | null> {
  if (!SECRET_RE.test(secret)) return null;
  return db
    .prepare("SELECT token, name, created, last_event FROM projects WHERE secret_hash = ?")
    .bind(await sha256Hex(secret))
    .first<Project>();
}

const CACHE_OK_MS = 5 * 60_000;
const CACHE_MISS_MS = 30_000;
const tokenCache = new Map<string, { ok: boolean; exp: number }>();
export function resetTokenCache(): void {
  tokenCache.clear();
}

/** Is this a token of a known project? Cached in memory briefly (5 min hits, 30 s misses). */
export async function knownToken(db: D1Like, token: string, nowMs: number): Promise<boolean> {
  if (!TOKEN_RE.test(token)) return false;
  const c = tokenCache.get(token);
  if (c && c.exp > nowMs) return c.ok;
  const row = await db.prepare("SELECT 1 AS ok FROM projects WHERE token = ?").bind(token).first();
  const ok = !!row;
  if (tokenCache.size > 5000) tokenCache.clear();
  tokenCache.set(token, { ok, exp: nowMs + (ok ? CACHE_OK_MS : CACHE_MISS_MS) });
  return ok;
}

// --------------------------------------------------------------------------------------------- aggregation

type Ev = Record<string, unknown>;
export interface AggBatch {
  sid: string;
  runtime: string;
  model: string | null;
  events: Ev[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? [...v.trim()].slice(0, KEY_MAX).join("") : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const LATENCY_BUCKETS: [number, string][] = [
  [50, "<50 ms"],
  [100, "50-100 ms"],
  [250, "100-250 ms"],
  [500, "250-500 ms"],
  [1000, "0.5-1 s"],
  [2500, "1-2.5 s"],
  [Infinity, ">2.5 s"],
];
const latencyBucket = (ms: number): string => LATENCY_BUCKETS.find(([max]) => ms < max)![1];

class Counters {
  readonly m = new Map<string, number>();
  add(metric: string, key: string | undefined = "", n = 1): void {
    if (!(n > 0) || !Number.isFinite(n)) return;
    const k = `${metric}\u0000${key ?? ""}`;
    const prev = this.m.get(k);
    if (prev === undefined && this.m.size >= MAX_COUNTERS) return;
    this.m.set(k, (prev ?? 0) + n);
  }
}

interface RecentRow {
  route?: string;
  fn?: string;
  trigger?: string;
  diagnosis?: string;
  action?: string;
  ran?: string;
  confidence?: number;
  mode?: string;
  executed?: boolean;
  acted?: boolean;
  kind: "detect" | "acted";
}

/** Pure part of the aggregation: counters and recent rows for one batch (exported for tests). */
export function summarize(batch: AggBatch): { counters: Counters; recent: RecentRow[]; summary?: Ev } {
  const c = new Counters();
  const recent: RecentRow[] = [];
  const decisions = new Map<string, Ev>();
  for (const e of batch.events) if (e.t === "decision" && typeof e.id === "string") decisions.set(e.id, e);
  const detected = new Set<string>();
  let summary: Ev | undefined;

  for (const e of batch.events) {
    switch (e.t) {
      case "session": {
        c.add("sessions");
        c.add("host", str(e.host) ?? "(unknown)");
        c.add("page_route", str(e.route) ?? "(unknown)");
        c.add("runtime", str(e.runtime) ?? str(batch.runtime) ?? "(unknown)");
        c.add("model_version", str(e.modelVersion) ?? str(batch.model) ?? "none");
        c.add("mode", str(e.effectiveMode) ?? str(e.mode) ?? "(unknown)");
        c.add("model_kind", str(e.model) ?? "(unknown)");
        const dev = e.device as Ev | undefined;
        if (dev && typeof dev === "object") c.add("webgpu_available", dev.webgpu ? "yes" : "no");
        break;
      }
      case "model": {
        const state = str(e.state);
        if (!state) break;
        c.add("model_state", state);
        if (state === "ready") {
          c.add("model_ready");
          c.add("backend", str(e.device) ?? "(unknown)");
          const ms = num(e.loadMs);
          if (ms !== undefined && ms >= 0) {
            c.add("model_load_ms_sum", "", ms);
            c.add("model_load_ms_n");
          }
          if (e.fromCache === true) c.add("model_from_cache");
        } else if (state === "error") {
          c.add("model_load_failed");
        }
        break;
      }
      case "decision": {
        c.add("decisions");
        c.add("trigger", str(e.trigger) ?? "(unknown)");
        c.add("route", str(e.route) ?? "(unknown)");
        const fn = str(e.fn);
        if (fn) c.add("fn", fn);
        c.add("diagnosis", str(e.diagnosis) ?? "(unknown)");
        c.add("decision_mode", str(e.effectiveMode) ?? "(unknown)");
        if (e.executed === true) c.add("executed");
        if (e.acted === true) {
          c.add("acted");
          c.add("acted_action", str(e.ran) ?? str(e.action) ?? "(unknown)");
          if (fn) c.add("fn_acted", fn);
        }
        const lat = num(e.latencyMs);
        if (lat !== undefined && lat >= 0) {
          c.add("latency_ms_sum", "", lat);
          c.add("latency_ms_n");
          c.add("latency_bucket", latencyBucket(lat));
        }
        break;
      }
      case "detect": {
        c.add("detections");
        c.add("detect_diagnosis", str(e.diagnosis) ?? "(unknown)");
        c.add("detect_trigger", str(e.trigger) ?? "(unknown)");
        const d = typeof e.decision === "string" ? decisions.get(e.decision) : undefined;
        if (d) {
          detected.add(e.decision as string);
          c.add("detect_route", str(d.route) ?? "(unknown)");
          const fn = str(d.fn);
          if (fn) c.add("fn_detect", fn);
        } else {
          recent.push({ kind: "detect", trigger: str(e.trigger), diagnosis: str(e.diagnosis), confidence: num(e.p) });
        }
        break;
      }
      case "action": {
        const outcome = str(e.outcome) ?? "(unknown)";
        c.add("action_outcome", outcome);
        if (outcome === "applied") c.add("intervention", str(e.action) ?? "(unknown)");
        break;
      }
      case "veto":
        c.add("vetoes");
        break;
      case "breaker":
        if (e.tripped === true) c.add("breaker_trips");
        break;
      case "model-error":
        c.add("model_error_events", str(e.code) ?? "error");
        break;
      case "summary": {
        const prevSeq = num(summary?.seq) ?? -1;
        if (!summary || (num(e.seq) ?? 0) >= prevSeq) summary = e;
        break;
      }
    }
  }

  for (const [id, d] of decisions) {
    const acted = d.acted === true;
    if (!acted && !detected.has(id)) continue;
    recent.push({
      kind: detected.has(id) ? "detect" : "acted",
      route: str(d.route),
      fn: str(d.fn),
      trigger: str(d.trigger),
      diagnosis: str(d.diagnosis),
      action: str(d.action),
      ran: str(d.ran),
      confidence: num(d.confidence),
      mode: str(d.effectiveMode),
      executed: d.executed === true,
      acted,
    });
  }
  return { counters: c, recent: recent.slice(-100), summary };
}

type CountMap = Record<string, number>;
function countMap(v: unknown): CountMap {
  const out: CountMap = {};
  if (!v || typeof v !== "object") return out;
  let i = 0;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (i++ >= 50) break;
    const x = num(n);
    if (x !== undefined && x > 0) out[[...k].slice(0, KEY_MAX).join("")] = x;
  }
  return out;
}

function upserts(db: D1Like, table: "daily" | "hourly", col: "day" | "hour", token: string, bucket: string, counters: Counters): D1Stmt[] {
  const entries = [...counters.m];
  const out: D1Stmt[] = [];
  for (let i = 0; i < entries.length; i += ROWS_PER_STMT) {
    const chunk = entries.slice(i, i + ROWS_PER_STMT);
    const sql =
      `INSERT INTO ${table} (token, ${col}, metric, key, count) VALUES ` +
      chunk.map(() => "(?, ?, ?, ?, ?)").join(", ") +
      ` ON CONFLICT (token, ${col}, metric, key) DO UPDATE SET count = count + excluded.count`;
    const params: unknown[] = [];
    for (const [k, n] of chunk) {
      const [metric, key] = k.split("\u0000") as [string, string];
      params.push(token, bucket, metric, key, n);
    }
    out.push(db.prepare(sql).bind(...params));
  }
  return out;
}

/** Aggregate one accepted batch for a known token: all writes in one db.batch(). */
export async function aggregate(db: D1Like, token: string, batch: AggBatch, now: Date): Promise<void> {
  const { counters, recent, summary } = summarize(batch);
  const iso = now.toISOString();
  const day = dayKey(now);

  // `summary` counters are cumulative per page load; count only what is new since the last summary we saw.
  let sessionStmt: D1Stmt | undefined;
  if (summary) {
    const counts = (summary.counts ?? {}) as Ev;
    const cur = { failOpen: countMap(counts.failOpen), modelErrors: countMap(counts.modelErrors) };
    const sidHash = (await sha256Hex(`${token}:${batch.sid}`)).slice(0, 32);
    const row = await db.prepare("SELECT counts FROM sessions WHERE sid_hash = ?").bind(sidHash).first<{ counts: string }>();
    let prev: { failOpen?: CountMap; modelErrors?: CountMap } = {};
    try {
      prev = row ? JSON.parse(row.counts) : {};
    } catch {
      /* corrupt: treat as new */
    }
    for (const [k, n] of Object.entries(cur.failOpen)) counters.add("fail_open", k, n - (prev.failOpen?.[k] ?? 0));
    for (const [k, n] of Object.entries(cur.modelErrors)) counters.add("model_errors", k, n - (prev.modelErrors?.[k] ?? 0));
    sessionStmt = db
      .prepare("INSERT INTO sessions (sid_hash, token, day, counts) VALUES (?, ?, ?, ?) ON CONFLICT (sid_hash) DO UPDATE SET counts = excluded.counts, day = excluded.day")
      .bind(sidHash, token, day, JSON.stringify(cur));
  }

  const stmts: D1Stmt[] = [
    ...upserts(db, "daily", "day", token, day, counters),
    ...upserts(db, "hourly", "hour", token, hourKey(now), counters),
    db.prepare("UPDATE projects SET last_event = ? WHERE token = ?").bind(iso, token),
  ];
  if (sessionStmt) stmts.push(sessionStmt);
  for (const r of recent) {
    stmts.push(
      db
        .prepare("INSERT INTO recent (token, t, route, fn, trigger, diagnosis, action, ran, confidence, mode, executed, acted, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(token, iso, r.route ?? null, r.fn ?? null, r.trigger ?? null, r.diagnosis ?? null, r.action ?? null, r.ran ?? null, r.confidence ?? null, r.mode ?? null, r.executed === undefined ? null : r.executed ? 1 : 0, r.acted === undefined ? null : r.acted ? 1 : 0, r.kind),
    );
  }
  if (recent.length) {
    stmts.push(
      db
        .prepare("DELETE FROM recent WHERE token = ?1 AND id < (SELECT id FROM recent WHERE token = ?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)")
        .bind(token, RECENT_CAP - 1),
    );
  }
  await db.batch(stmts);
}

// --------------------------------------------------------------------------------------------- stats

export type Range = "24h" | "7d" | "30d";
export const RANGES: Range[] = ["24h", "7d", "30d"];
const SERIES_METRICS = ["sessions", "decisions", "detections", "acted"];

export interface Stats {
  name: string;
  token: string;
  created: string;
  lastEvent: string | null;
  range: Range;
  from: string;
  generated: string;
  totals: Record<string, number>;
  breakdowns: Record<string, { key: string; count: number }[]>;
  series: { bucket: string; sessions: number; decisions: number; detections: number; acted: number }[];
  recent: Record<string, unknown>[];
}

export async function stats(db: D1Like, p: Project, range: Range, now: Date): Promise<Stats> {
  const hourly = range === "24h";
  const table = hourly ? "hourly" : "daily";
  const col = hourly ? "hour" : "day";
  const span = hourly ? 24 : range === "7d" ? 7 : 30;
  const buckets: string[] = [];
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * (hourly ? 3_600_000 : 86_400_000));
    buckets.push(hourly ? hourKey(d) : dayKey(d));
  }
  const from = buckets[0]!;

  const [agg, series, recent] = await db.batch([
    db.prepare(`SELECT metric, key, SUM(count) AS c FROM ${table} WHERE token = ? AND ${col} >= ? GROUP BY metric, key`).bind(p.token, from),
    db
      .prepare(`SELECT ${col} AS b, metric, SUM(count) AS c FROM ${table} WHERE token = ? AND ${col} >= ? AND key = '' AND metric IN (${SERIES_METRICS.map(() => "?").join(", ")}) GROUP BY ${col}, metric`)
      .bind(p.token, from, ...SERIES_METRICS),
    db
      .prepare("SELECT t, route, fn, trigger, diagnosis, action, ran, confidence, mode, executed, acted, kind FROM recent WHERE token = ? AND t >= ? ORDER BY id DESC LIMIT 50")
      .bind(p.token, hourly ? new Date(now.getTime() - 86_400_000).toISOString() : `${from}T00:00:00.000Z`),
  ]);
  const rows = (r: unknown) => ((r as { results?: Record<string, unknown>[] })?.results ?? []) as Record<string, unknown>[];

  const totals: Record<string, number> = {};
  const breakdowns: Record<string, { key: string; count: number }[]> = {};
  for (const r of rows(agg)) {
    const metric = String(r.metric);
    const key = String(r.key ?? "");
    const c = Number(r.c) || 0;
    if (key === "") totals[metric] = (totals[metric] ?? 0) + c;
    else (breakdowns[metric] ??= []).push({ key, count: c });
  }
  for (const list of Object.values(breakdowns)) {
    list.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    list.splice(25);
  }
  const sumOf = (m: string) => (breakdowns[m] ?? []).reduce((s, x) => s + x.count, 0);
  totals.latencyAvgMs = totals.latency_ms_n ? Math.round(totals.latency_ms_sum! / totals.latency_ms_n) : 0;
  totals.modelLoadAvgMs = totals.model_load_ms_n ? Math.round(totals.model_load_ms_sum! / totals.model_load_ms_n) : 0;
  totals.failOpens = sumOf("fail_open");
  totals.modelErrors = sumOf("model_errors");
  totals.interventions = sumOf("intervention");
  if (breakdowns.latency_bucket) {
    const order = LATENCY_BUCKETS.map(([, l]) => l);
    breakdowns.latency_bucket.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }

  const byBucket = new Map(buckets.map((b) => [b, { bucket: b, sessions: 0, decisions: 0, detections: 0, acted: 0 }]));
  for (const r of rows(series)) {
    const s = byBucket.get(String(r.b));
    if (s && SERIES_METRICS.includes(String(r.metric))) (s as Record<string, unknown>)[String(r.metric)] = Number(r.c) || 0;
  }

  return {
    name: p.name,
    token: p.token,
    created: p.created,
    lastEvent: p.last_event,
    range,
    from: hourly ? `${from}:00:00.000Z` : `${from}T00:00:00.000Z`,
    generated: now.toISOString(),
    totals,
    breakdowns,
    series: [...byBucket.values()],
    recent: rows(recent).map((r) => ({ ...r, executed: r.executed === null ? null : !!r.executed, acted: r.acted === null ? null : !!r.acted })),
  };
}

// --------------------------------------------------------------------------------------------- retention

export async function retention(db: D1Like, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  await db.batch([
    db.prepare("DELETE FROM daily WHERE day < ?").bind(dayKey(cutoff)),
    db.prepare("DELETE FROM hourly WHERE hour < ?").bind(hourKey(new Date(now.getTime() - 48 * 3_600_000))),
    db.prepare("DELETE FROM recent WHERE t < ?").bind(cutoff.toISOString()),
    db.prepare("DELETE FROM sessions WHERE day < ?").bind(dayKey(new Date(now.getTime() - 2 * 86_400_000))),
  ]);
}
