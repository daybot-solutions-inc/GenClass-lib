import { beforeEach, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import worker from "../src/index.js";
import { handle, MAX_PROJECTS_PER_MINUTE, validate, type Env } from "../src/collector.js";
import { RECENT_CAP, resetTokenCache, retention, sanitizeName, sha256Hex, TOKEN_RE, type D1Like, type D1Stmt } from "../src/dashboard.js";

// D1 stand-in backed by node:sqlite running the real migration, so the SQL itself is under test.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const MIGRATION = ["0001_dashboard.sql", "0002_projects_created.sql"].map((f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8")).join("\n");

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATION);
  let batches = 0;
  const stmt = (sql: string, params: unknown[] = []): D1Stmt => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async <T>() => (db.prepare(sql).get(...(params as never[])) ?? null) as T | null,
    all: async <T>() => ({ results: db.prepare(sql).all(...(params as never[])) as T[] }),
    run: async () => db.prepare(sql).run(...(params as never[])),
  });
  const api: D1Like = {
    prepare: (sql) => stmt(sql),
    async batch(stmts) {
      batches++;
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.all());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { api, db, rows: (sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as never[])) as Record<string, unknown>[], batches: () => batches };
}

function setup(limiter?: Env["CREATE_LIMITER"]) {
  const puts: { key: string; body: Uint8Array }[] = [];
  const sql = d1();
  const env: Env = {
    BUCKET: {
      async put(key: string, value: ArrayBuffer | Uint8Array) {
        puts.push({ key, body: value instanceof Uint8Array ? value : new Uint8Array(value) });
      },
    },
    DB: sql.api,
    CREATE_LIMITER: limiter,
  };
  return { env, puts, sql };
}

const NOW = new Date("2026-10-08T12:00:00Z");
let uuidN = 0;
const opts = { now: () => NOW, uuid: () => `u-${++uuidN}` };

async function create(env: Env, body: unknown = { name: "Acme checkout" }, ip = "203.0.113.7") {
  const res = await handle(
    new Request("https://genclass.dev/api/projects", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "cf-connecting-ip": ip } }),
    env,
    opts,
  );
  return { res, json: (await res.json()) as Record<string, string> };
}

function post(body: unknown) {
  const r = new Request("https://genclass-telemetry.example.workers.dev/v1/events", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "text/plain;charset=UTF-8" } });
  Object.defineProperty(r, "cf", { value: { country: "CA", city: "Toronto" } });
  return r;
}

const secretOf = (url: string) => url.split("/").pop()!;

/** A realistic page load, shaped like packages/runtime/src/telemetry/client.ts emits it. */
function pageBatch(token: string | undefined, sid = "3f9c0a1b2c3d4e5f60718293", extra: Record<string, unknown>[] = []) {
  return {
    schema: "genclass-telemetry/1",
    sid,
    sent: 12034,
    runtime: "0.1.0-beta.5",
    model: "2.0.0-rc4t",
    ...(token === undefined ? {} : { token }),
    events: [
      { t: "session", seq: 0, at: 1, runtime: "0.1.0-beta.5", host: "shop.acme.test", route: "/cart/:id", mode: "heal", effectiveMode: "heal", aggressiveness: 0.5, sampled: true, model: "local", modelState: "loading", modelVersion: "2.0.0-rc4t", device: { webgpu: true, cores: 8 }, sample: 1, situation: true },
      { t: "model", seq: 1, at: 900, state: "ready", version: "2.0.0-rc4t", device: "webgpu", loadMs: 840, fromCache: true },
      { t: "decision", seq: 2, at: 1200, id: "d1", trigger: "mutation", route: "/cart/:id", fn: "saveCart", model: "genclass-2", latencyMs: 42, held: true, situation: "SECRET SITUATION TEXT op saveCart", diagnosis: "stale", diagnosisConfidence: 0.97, action: "discard", confidence: 0.95, tier: "guard", ran: "discard", executed: true, acted: true, effectiveMode: "heal" },
      { t: "detect", seq: 3, at: 1201, decision: "d1", trigger: "mutation", diagnosis: "stale", p: 0.97 },
      { t: "action", seq: 4, at: 1202, id: "a1", decision: "d1", action: "discard", tier: "guard", trigger: "mutation", outcome: "applied", reversible: true },
      { t: "decision", seq: 5, at: 2000, id: "d2", trigger: "response", route: "/cart/:id", model: "genclass-2", latencyMs: 180, situation: "more text", diagnosis: "expected", action: "proceed", confidence: 0.99, tier: "passive", ran: "proceed", executed: true, acted: false, effectiveMode: "heal" },
      { t: "model-error", seq: 6, at: 2100, code: "inference_failed", message: "x" },
      { t: "action", seq: 7, at: 3000, id: "a1", decision: "d1", action: "discard", tier: "guard", trigger: "mutation", outcome: "undone" },
      { t: "summary", seq: 8, at: 4000, reason: "hidden", counts: { decisions: 2, failOpen: { "timeout:response": 2 }, modelErrors: { inference_failed: 1 } } },
      ...extra,
    ],
  };
}

beforeEach(() => resetTokenCache());

describe("project creation", () => {
  it("creates a project: token, private dashboard link, only the secret's hash stored", async () => {
    const { env, sql } = setup();
    const { res, json } = await create(env, { name: "  Acme\u0000 checkout\n\u202e " });
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(json.token).toMatch(TOKEN_RE);
    expect(json.dashboardUrl).toMatch(/^https:\/\/genclass\.dev\/dashboard\/[A-Za-z0-9]{32}$/);
    expect(json.name).toBe("Acme checkout");
    expect(json.created).toBe(NOW.toISOString());
    const rows = sql.rows("SELECT * FROM projects");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).toBe(json.token);
    expect(rows[0]!.secret_hash).toBe(await sha256Hex(secretOf(json.dashboardUrl)));
    expect(JSON.stringify(rows)).not.toContain(secretOf(json.dashboardUrl));
  });

  it("names: optional, sanitised, at most 80 chars; bad bodies rejected; CORS preflight", async () => {
    const { env } = setup();
    expect((await create(env, {})).json.name).toBe("Untitled app");
    expect((await create(env, { name: 42 })).json.name).toBe("Untitled app");
    expect([...(await create(env, { name: "x".repeat(200) })).json.name]).toHaveLength(80);
    expect(sanitizeName("<b>hi</b>")).toBe("<b>hi</b>"); // stored as text; pages escape it
    const empty = await handle(new Request("https://genclass.dev/api/projects", { method: "POST" }), env, opts);
    expect(empty.status).toBe(201);
    const bad = await handle(new Request("https://genclass.dev/api/projects", { method: "POST", body: "{nope" }), env, opts);
    expect(bad.status).toBe(400);
    expect((await handle(new Request("https://genclass.dev/api/projects", { method: "POST", body: "[1]" }), env, opts)).status).toBe(400);
    const pre = await handle(new Request("https://genclass.dev/api/projects", { method: "OPTIONS" }), env, opts);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect((await handle(new Request("https://genclass.dev/api/projects"), env, opts)).status).toBe(405);
  });

  it("rate-limits creation per client without passing the IP to the limiter", async () => {
    const keys: string[] = [];
    const counts = new Map<string, number>();
    const { env, sql } = setup({
      async limit({ key }) {
        keys.push(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return { success: counts.get(key)! <= 10 };
      },
    });
    for (let i = 0; i < 10; i++) expect((await create(env)).res.status).toBe(201);
    const r = await create(env);
    expect(r.res.status).toBe(429);
    expect(r.json).toMatchObject({ ok: false });
    expect(r.res.headers.get("access-control-allow-origin")).toBe("*");
    expect((await create(env, {}, "198.51.100.9")).res.status).toBe(201);
    expect(keys.join()).not.toContain("203.0.113.7");
    expect(sql.rows("SELECT COUNT(*) AS n FROM projects")[0]!.n).toBe(11);
  });
  it("has a global ceiling on new projects per minute, independent of the per-client limiter", async () => {
    const { env } = setup();
    for (let i = 0; i < MAX_PROJECTS_PER_MINUTE; i++) expect((await create(env, {}, `198.51.100.${i}`)).res.status).toBe(201);
    expect((await create(env, {}, "192.0.2.1")).res.status).toBe(429);
    const later = await handle(
      new Request("https://genclass.dev/api/projects", { method: "POST", body: "{}" }),
      env,
      { ...opts, now: () => new Date(NOW.getTime() + 61_000) },
    );
    expect(later.status).toBe(201);
  });
});

describe("token on telemetry batches", () => {
  it("validate keeps a well-formed token and drops a malformed one without rejecting the batch", () => {
    const ok = validate(pageBatch("gc_abcdefghijklmnopqrstuv"));
    expect(typeof ok !== "string" && ok.token).toBe("gc_abcdefghijklmnopqrstuv");
    for (const t of ["gc_short", "xx_abcdefghijklmnopqrstuv", "gc_abcdefghijklmnopqrst-v", 7, null]) {
      const b = validate(pageBatch(t as string));
      expect(typeof b).not.toBe("string");
      expect(b).not.toHaveProperty("token");
    }
  });

  it("aggregates a known token's batch for its dashboard (and still stores the raw batch, with the token, in R2)", async () => {
    const { env, puts, sql } = setup();
    const { json } = await create(env);
    const res = await handle(post(pageBatch(json.token)), env, opts);
    expect(res.status).toBe(202);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toMatch(/^events\/dt=2026-10-08\/rt=0\.1\.0-beta\.5\/model=2\.0\.0-rc4t\/u-\d+\.jsonl\.gz$/);
    const line = JSON.parse(gunzipSync(puts[0]!.body).toString("utf8").split("\n")[0]!);
    expect(line).toMatchObject({ sid: "3f9c0a1b2c3d4e5f60718293", token: json.token, country: "CA", event: { t: "session" } });

    // the dashboard store never holds situation text, sid or the secret
    const dump = JSON.stringify([sql.rows("SELECT * FROM daily"), sql.rows("SELECT * FROM hourly"), sql.rows("SELECT * FROM recent"), sql.rows("SELECT * FROM sessions")]);
    expect(dump).not.toMatch(/SECRET SITUATION|more text|3f9c0a1b2c3d4e5f60718293/);
    expect(sql.rows("SELECT last_event FROM projects")[0]!.last_event).toBe(NOW.toISOString());

    const st = await handle(new Request(`https://genclass.dev/api/projects/${secretOf(json.dashboardUrl)}?range=7d`), env, opts);
    expect(st.status).toBe(200);
    expect(st.headers.get("referrer-policy")).toBe("no-referrer");
    const s = (await st.json()) as Record<string, any>;
    expect(s).toMatchObject({ name: "Acme checkout", token: json.token, lastEvent: NOW.toISOString(), range: "7d" });
    expect(s.totals).toMatchObject({ sessions: 1, decisions: 2, detections: 1, acted: 1, executed: 2, model_ready: 1, latencyAvgMs: 111, modelLoadAvgMs: 840, failOpens: 2, modelErrors: 1, interventions: 1 });
    const bd = (m: string) => Object.fromEntries((s.breakdowns[m] ?? []).map((x: any) => [x.key, x.count]));
    expect(bd("detect_diagnosis")).toEqual({ stale: 1 });
    expect(bd("diagnosis")).toEqual({ stale: 1, expected: 1 });
    expect(bd("intervention")).toEqual({ discard: 1 });
    expect(bd("action_outcome")).toEqual({ applied: 1, undone: 1 });
    expect(bd("route")).toEqual({ "/cart/:id": 2 });
    expect(bd("fn")).toEqual({ saveCart: 1 });
    expect(bd("fn_detect")).toEqual({ saveCart: 1 });
    expect(bd("fn_acted")).toEqual({ saveCart: 1 });
    expect(bd("backend")).toEqual({ webgpu: 1 });
    expect(bd("host")).toEqual({ "shop.acme.test": 1 });
    expect(bd("runtime")).toEqual({ "0.1.0-beta.5": 1 });
    expect(bd("model_version")).toEqual({ "2.0.0-rc4t": 1 });
    expect(bd("fail_open")).toEqual({ "timeout:response": 2 });
    expect(bd("model_errors")).toEqual({ inference_failed: 1 });
    expect(bd("latency_bucket")).toEqual({ "<50 ms": 1, "100-250 ms": 1 });
    expect(s.series).toHaveLength(7);
    expect(s.series.at(-1)).toEqual({ bucket: "2026-10-08", sessions: 1, decisions: 2, detections: 1, acted: 1 });
    expect(s.recent).toEqual([
      { t: NOW.toISOString(), route: "/cart/:id", fn: "saveCart", trigger: "mutation", diagnosis: "stale", action: "discard", ran: "discard", confidence: 0.95, mode: "heal", executed: true, acted: true, kind: "detect" },
    ]);
    expect(JSON.stringify(s)).not.toContain("SITUATION");

    // 24 h (hourly) and 30 d windows
    const h = (await (await handle(new Request(`https://genclass.dev/api/projects/${secretOf(json.dashboardUrl)}?range=24h`), env, opts)).json()) as any;
    expect(h.series).toHaveLength(24);
    expect(h.series.at(-1)).toMatchObject({ bucket: "2026-10-08T12", sessions: 1 });
    expect(h.totals.decisions).toBe(2);
    const m = (await (await handle(new Request(`https://genclass.dev/api/projects/${secretOf(json.dashboardUrl)}?range=30d`), env, opts)).json()) as any;
    expect(m.series).toHaveLength(30);
  });

  it("counts cumulative summaries once per page load (deltas) and aggregates in one D1 batch", async () => {
    const { env, sql } = setup();
    const { json } = await create(env);
    await handle(post(pageBatch(json.token)), env, opts);
    const before = sql.batches();
    // the same page later sends a bigger cumulative summary
    await handle(
      post({ ...pageBatch(json.token), events: [{ t: "summary", seq: 20, at: 9000, reason: "pagehide", counts: { failOpen: { "timeout:response": 3, "busy:mutation": 1 }, modelErrors: { inference_failed: 1 } } }] }),
      env,
      opts,
    );
    expect(sql.batches() - before).toBe(1);
    const s = (await (await handle(new Request(`https://genclass.dev/api/projects/${secretOf(json.dashboardUrl)}`), env, opts)).json()) as any;
    expect(s.totals.failOpens).toBe(4);
    expect(s.totals.modelErrors).toBe(1);
  });

  it("caps recent rows per token", async () => {
    const { env, sql } = setup();
    const { json } = await create(env);
    const acted = (i: number) => ({ t: "decision", seq: i, at: i, id: `d${i}`, trigger: "mutation", diagnosis: "stale", action: "discard", ran: "discard", executed: true, acted: true });
    for (let b = 0; b < 6; b++) {
      await handle(post({ ...pageBatch(json.token), events: Array.from({ length: 100 }, (_, i) => acted(b * 100 + i)) }), env, opts);
    }
    expect(sql.rows("SELECT COUNT(*) AS n FROM recent")[0]!.n).toBe(RECENT_CAP);
    expect(sql.rows("SELECT MIN(id) AS lo, MAX(id) AS hi FROM recent")[0]).toEqual({ lo: 101, hi: 600 });
  });

  it("unknown, malformed or missing tokens: stored in R2 exactly as before, nothing aggregated", async () => {
    const { env, puts, sql } = setup();
    await create(env);
    for (const token of ["gc_unknownunknownunknown1", "not-a-token", undefined]) {
      const res = await handle(post(pageBatch(token)), env, opts);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, accepted: 9 });
    }
    expect(puts).toHaveLength(3);
    const first = (i: number) => JSON.parse(gunzipSync(puts[i]!.body).toString("utf8").split("\n")[0]!);
    expect(first(0).token).toBe("gc_unknownunknownunknown1");
    // old clients (no token) and malformed tokens: the exact pre-dashboard record shape
    for (const i of [1, 2]) expect(Object.keys(first(i))).toEqual(["sid", "runtime", "model", "sent", "receivedAt", "country", "event"]);
    expect(sql.rows("SELECT COUNT(*) AS n FROM daily")[0]!.n).toBe(0);
    expect(sql.rows("SELECT COUNT(*) AS n FROM recent")[0]!.n).toBe(0);
  });

  it("a D1 failure never fails ingest", async () => {
    const { env, puts } = setup();
    const { json } = await create(env);
    env.DB = { prepare: () => { throw new Error("d1 down"); }, batch: async () => { throw new Error("d1 down"); } };
    const res = await handle(post(pageBatch(json.token)), env, opts);
    expect(res.status).toBe(202);
    expect(puts).toHaveLength(1);
  });

  it("works without a DB binding (plain collector)", async () => {
    const { env, puts } = setup();
    delete env.DB;
    expect((await handle(post(pageBatch("gc_abcdefghijklmnopqrstuv")), env, opts)).status).toBe(202);
    expect(puts).toHaveLength(1);
  });
});

describe("dashboard pages", () => {
  it("serves the dashboard for a valid secret with strict headers; 404 otherwise", async () => {
    const { env } = setup();
    const { json } = await create(env, { name: "</script><img src=x onerror=alert(1)>" });
    const res = await handle(new Request(json.dashboardUrl), env, opts);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toMatch(/default-src 'none'; script-src 'nonce-[A-Za-z0-9]{22}'/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const body = await res.text();
    const nonce = /nonce-([A-Za-z0-9]{22})/.exec(csp)![1]!;
    expect(body).toContain(`<script nonce="${nonce}">`);
    expect(body).toContain(json.token);
    expect(body).not.toContain("</script><img");
    expect(body).not.toMatch(/ style="/);
    expect(body).not.toContain(secretOf(json.dashboardUrl));

    for (const bad of ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "short", "../../etc"]) {
      expect((await handle(new Request(`https://genclass.dev/dashboard/${bad}`), env, opts)).status).toBe(404);
      expect((await handle(new Request(`https://genclass.dev/api/projects/${bad}`), env, opts)).status).toBe(404);
    }
    const st = await handle(new Request(`https://genclass.dev/api/projects/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`), env, opts);
    expect(await st.json()).toEqual({ ok: false, error: "not found" });
  });

  it("serves /start, redirects /dashboard, and passes other genclass.dev paths to the site", async () => {
    const { env } = setup();
    const start = await handle(new Request("https://genclass.dev/start"), env, opts);
    expect(start.status).toBe(200);
    const html = await start.text();
    expect(html).toContain("Get a token");
    expect(html).toContain('fetch("/api/projects"');
    expect(html).toContain("https://cdn.jsdelivr.net/npm/@genclass/runtime");
    expect((await handle(new Request("https://genclass.dev/dashboard"), env, opts)).headers.get("location")).toBe("/start");
    const seen: string[] = [];
    const passthrough = async (r: Request) => {
      seen.push(new URL(r.url).pathname);
      return new Response("site", { status: 200 });
    };
    expect(await (await handle(new Request("https://genclass.dev/starter-kit"), env, { ...opts, passthrough })).text()).toBe("site");
    expect(seen).toEqual(["/starter-kit"]);
    // on workers.dev nothing is passed through
    expect((await handle(new Request("https://x.workers.dev/starter-kit"), env, { ...opts, passthrough })).status).toBe(404);
    expect((await handle(new Request("https://genclass.dev/api/nope"), env, { ...opts, passthrough })).status).toBe(404);
  });
});

describe("retention", () => {
  it("deletes daily/recent rows older than 90 days, hourly older than 48 h, summary state older than 2 days", async () => {
    const { env, sql } = setup();
    const { json } = await create(env);
    const db = sql.db;
    const ins = db.prepare("INSERT INTO daily (token, day, metric, key, count) VALUES (?, ?, 'sessions', '', 1)");
    for (const d of ["2026-07-09", "2026-07-10", "2026-10-08"]) ins.run(json.token, d);
    const insH = db.prepare("INSERT INTO hourly (token, hour, metric, key, count) VALUES (?, ?, 'sessions', '', 1)");
    for (const h of ["2026-10-06T11", "2026-10-06T12", "2026-10-08T12"]) insH.run(json.token, h);
    const insR = db.prepare("INSERT INTO recent (token, t, kind) VALUES (?, ?, 'detect')");
    for (const t of ["2026-07-10T11:00:00.000Z", "2026-07-10T13:00:00.000Z"]) insR.run(json.token, t);
    const insS = db.prepare("INSERT INTO sessions (sid_hash, token, day, counts) VALUES (?, ?, ?, '{}')");
    insS.run("a", json.token, "2026-10-05");
    insS.run("b", json.token, "2026-10-06");

    await retention(sql.api, NOW);
    expect(sql.rows("SELECT day FROM daily ORDER BY day").map((r) => r.day)).toEqual(["2026-07-10", "2026-10-08"]);
    expect(sql.rows("SELECT hour FROM hourly ORDER BY hour").map((r) => r.hour)).toEqual(["2026-10-06T12", "2026-10-08T12"]);
    expect(sql.rows("SELECT t FROM recent").map((r) => r.t)).toEqual(["2026-07-10T13:00:00.000Z"]);
    expect(sql.rows("SELECT sid_hash FROM sessions").map((r) => r.sid_hash)).toEqual(["b"]);
    expect(sql.rows("SELECT COUNT(*) AS n FROM projects")[0]!.n).toBe(1);
  });

  it("the scheduled handler runs the sweep", async () => {
    const { env, sql } = setup();
    sql.db.prepare("INSERT INTO daily (token, day, metric, key, count) VALUES ('gc_x', '2020-01-01', 'sessions', '', 1)").run();
    const waits: Promise<unknown>[] = [];
    await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    expect(sql.rows("SELECT COUNT(*) AS n FROM daily")[0]!.n).toBe(0);
  });
});
