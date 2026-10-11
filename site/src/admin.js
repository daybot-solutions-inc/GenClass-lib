// genclass.dev/admin: password-protected live dashboard.
// ingest(): every minute (cron) reads new telemetry batches from the collector's R2 bucket into the ADMIN_DB
// aggregates. stats(): one JSON for the dashboard (telemetry aggregates + npm + GitHub + waitlist + dashboard projects).
import { ADMIN_PAGE, ADMIN_JS, LOGIN_PAGE } from "./admin-page.js";

const COOKIE = "gc_admin";
const SESSION_HOURS = 12;
const TEST_HOST = /^(|localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.invalid|.*\.local|.*\.test|.*\.localhost|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|genclass-site-staging\..*)$/;
const enc = new TextEncoder();
let lastViewIngest = 0;
const NOINDEX = {
  "x-robots-tag": "noindex, nofollow", "cache-control": "no-store", "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff", "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

// ---------- auth ----------
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function safeEqual(a, b, key) { return (await hmac(key, a)) === (await hmac(key, b)); }
async function makeCookie(env) {
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  return `${COOKIE}=${exp}.${await hmac(env.ADMIN_SESSION_KEY, "admin:" + exp)}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`;
}
async function authed(request, env) {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_KEY) return false;
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([0-9a-f]{64})`));
  if (!m || Number(m[1]) < Date.now()) return false;
  return safeEqual(m[2], await hmac(env.ADMIN_SESSION_KEY, "admin:" + m[1]), env.ADMIN_SESSION_KEY);
}
const html = (body, status = 200, extra = {}) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...NOINDEX, ...extra } });

export async function handleAdmin(request, env, url, ctx) {
  const path = url.pathname.replace(/\/+$/, "") || "/admin";
  if (path === "/admin/login" && request.method === "POST") {
    if (env.LIMIT) {
      const { success } = await env.LIMIT.limit({ key: "admin:" + (request.headers.get("cf-connecting-ip") || "?") });
      if (!success) return html(LOGIN_PAGE("Too many attempts. Wait a minute and try again."), 429);
    }
    const form = await request.formData().catch(() => null);
    const pw = String(form?.get("password") || "");
    if (!env.ADMIN_PASSWORD || !(await safeEqual(pw, env.ADMIN_PASSWORD, env.ADMIN_SESSION_KEY || "k"))) {
      return html(LOGIN_PAGE("Wrong password."), 401);
    }
    return new Response(null, { status: 303, headers: { location: "/admin", "set-cookie": await makeCookie(env), ...NOINDEX } });
  }
  if (path === "/admin/logout") {
    return new Response(null, { status: 303, headers: { location: "/admin", "set-cookie": `${COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`, ...NOINDEX } });
  }
  if (!(await authed(request, env))) {
    if (path.startsWith("/admin/api/")) return Response.json({ error: "unauthorized" }, { status: 401, headers: NOINDEX });
    return html(LOGIN_PAGE(""));
  }
  if (path === "/admin/api/stats") {
    // Sync on view too (throttled per isolate), so the dashboard is current even when the cron is late.
    if (Date.now() - lastViewIngest > 20e3) {
      lastViewIngest = Date.now();
      await ingest(env, 100).catch(() => {});
    }
    return Response.json(await stats(env, url), { headers: NOINDEX });
  }
  if (path === "/admin/api/ingest" && request.method === "POST") return Response.json(await ingest(env, 300), { headers: NOINDEX });
  if (path === "/admin") return html(ADMIN_PAGE);
  if (path === "/admin/app.js") return new Response(ADMIN_JS, { headers: { "content-type": "text/javascript; charset=utf-8", ...NOINDEX } });
  return new Response("Not found", { status: 404, headers: NOINDEX });
}

// ---------- ingestion: R2 telemetry batches -> ADMIN_DB ----------
const dayOf = (iso) => (iso || new Date().toISOString()).slice(0, 10);
async function gunzipLines(obj) {
  const stream = obj.body.pipeThrough(new DecompressionStream("gzip"));
  return (await new Response(stream).text()).split("\n").filter(Boolean);
}
export async function ingest(env, maxObjects = 150) {
  if (!env.TELEMETRY || !env.ADMIN_DB) return { error: "bindings missing" };
  const db = env.ADMIN_DB;
  const days = [0, 1].map((d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10));
  // Scan the whole bucket until a run leaves nothing pending (the backfill can take several runs), then only
  // today's and yesterday's prefixes.
  const BACKFILLED = "__backfill_done";
  const full = !(await db.prepare("SELECT 1 FROM processed WHERE key = ?").bind(BACKFILLED).first());
  const prefixes = full ? ["events/"] : days.map((d) => `events/dt=${d}/`);
  const keys = [];
  for (const prefix of prefixes) {
    let cursor;
    do {
      const page = await env.TELEMETRY.list({ prefix, cursor, limit: 1000 });
      for (const o of page.objects) keys.push(o.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && keys.length < 20000);
  }
  const todo = [];
  for (let i = 0; i < keys.length && todo.length < maxObjects; i += 80) {
    const chunk = keys.slice(i, i + 80);
    const done = new Set((await db.prepare(`SELECT key FROM processed WHERE key IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all()).results.map((r) => r.key));
    for (const k of chunk) if (!done.has(k) && todo.length < maxObjects) todo.push(k);
  }
  const hostOf = new Map();
  const counters = new Map();
  const bump = (day, host, metric, key = "", n = 1) => { const k = `${day}\u0000${host}\u0000${metric}\u0000${key}`; counters.set(k, (counters.get(k) || 0) + n); };
  const stmts = [];
  let events = 0;
  for (const key of todo) {
    const obj = await env.TELEMETRY.get(key);
    if (!obj) continue;
    let lines = [];
    try { lines = await gunzipLines(obj); } catch { lines = []; }
    const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    rows.sort((a, b) => (a.event?.t === "session" ? -1 : 0) - (b.event?.t === "session" ? -1 : 0));
    for (const r of rows) {
      const e = r.event || {}; const at = r.receivedAt || new Date().toISOString(); const day = dayOf(at);
      events++;
      if (e.t === "session") {
        const host = String(e.host || "").slice(0, 120);
        hostOf.set(r.sid, host);
        stmts.push(db.prepare(`INSERT INTO sessions (sid, host, route, runtime, model, mode, country, device, first_at, last_at, test)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10) ON CONFLICT(sid) DO UPDATE SET last_at = excluded.last_at`)
          .bind(r.sid, host, String(e.route || "").slice(0, 200), r.runtime || e.runtime || null, r.model || null, e.mode || null,
            r.country || null, JSON.stringify(e.device || {}).slice(0, 300), at, TEST_HOST.test(host) ? 1 : 0));
        bump(day, host, "sessions");
        bump(day, host, "runtime", r.runtime || e.runtime || "?");
        bump(day, host, "mode", e.mode || "?");
        bump(day, host, "country", r.country || "?");
        bump(day, host, "route", String(e.route || "/").slice(0, 80));
        if (e.aggressiveness !== undefined) bump(day, host, "aggressiveness", String(e.aggressiveness));
        bump(day, host, "situation_text", e.situation ? "on" : "off");
        if (e.device && e.device.webgpu !== undefined) bump(day, host, "webgpu", e.device.webgpu ? "available" : "none");
        if (e.model) bump(day, host, "model_kind", String(e.model));
        continue;
      }
      let host = hostOf.get(r.sid);
      if (host === undefined) {
        const s = await db.prepare("SELECT host FROM sessions WHERE sid = ?").bind(r.sid).first();
        host = s ? s.host : ""; hostOf.set(r.sid, host);
      }
      if (e.t === "decision") {
        bump(day, host, "decisions"); bump(day, host, "decisions_by_trigger", e.trigger || "?");
        if (e.acted) bump(day, host, "acted", e.ran || e.action || "?");
        if (e.diagnosis) bump(day, host, "diagnoses", e.diagnosis);
        if (typeof e.latencyMs === "number") {
          bump(day, host, "latency_ms", "", e.latencyMs); bump(day, host, "latency_n");
          bump(day, host, "latency_bucket", e.latencyMs < 100 ? "< 100 ms" : e.latencyMs < 250 ? "100–250 ms" : e.latencyMs < 500 ? "250–500 ms" : e.latencyMs < 1000 ? "0.5–1 s" : "≥ 1 s");
        }
        if (e.held !== undefined) bump(day, host, "held", e.held ? "held (could act)" : "background (too late to act)");
        if (!e.acted) bump(day, host, "passive_reason", String(e.reason || (e.tier === "passive" ? "gate: not confident enough" : "passive")).slice(0, 60));
      } else if (e.t === "veto") {
        bump(day, host, "vetoes");
      } else if (e.t === "detect") {
        bump(day, host, "detections", e.diagnosis || "?");
        stmts.push(db.prepare(`INSERT INTO recent (at, sid, host, route, kind, trigger, diagnosis, confidence, runtime) VALUES (?,?,?,?,?,?,?,?,?)`)
          .bind(at, r.sid, host, null, "detect", e.trigger || null, e.diagnosis || null, e.p ?? null, r.runtime || null));
      } else if (e.t === "action") {
        const outcome = e.outcome || (e.ok === false ? "failed" : "applied");
        bump(day, host, "actions", `${e.action || "?"}:${outcome}`);
        if (outcome === "undone" || e.undone) bump(day, host, "undos");
        stmts.push(db.prepare(`INSERT INTO recent (at, sid, host, kind, trigger, action, outcome, runtime) VALUES (?,?,?,?,?,?,?,?)`)
          .bind(at, r.sid, host, "action", e.trigger || null, e.action || null, outcome, r.runtime || null));
      } else if (e.t === "undo") {
        bump(day, host, "undos");
      } else if (e.t === "model") {
        if (e.state === "ready") {
          bump(day, host, "model_ready", e.device || e.backend || "?");
          if (e.loadMs) { bump(day, host, "model_load_ms", "", e.loadMs); bump(day, host, "model_load_n"); }
          bump(day, host, "model_worker", e.worker === false ? "inline (main thread)" : "web worker");
          bump(day, host, "model_cache", e.fromCache ? "from cache" : "downloaded");
          if (e.variant) bump(day, host, "model_variant", String(e.variant).slice(0, 40));
        }
        if (e.state === "error") bump(day, host, "model_error", String(e.error || "error").slice(0, 60));
      } else if (e.t === "model-error") {
        bump(day, host, "model_error", String(e.code || "error").slice(0, 60));
      } else if (e.t === "breaker" && e.tripped) {
        bump(day, host, "breaker", String(e.reason || "?").slice(0, 60));
      }
    }
    stmts.push(db.prepare("INSERT OR IGNORE INTO processed (key, at, events) VALUES (?,?,?)").bind(key, new Date().toISOString(), rows.length));
  }
  for (const [k, n] of counters) {
    const [day, host, metric, key] = k.split("\u0000");
    stmts.push(db.prepare(`INSERT INTO daily (day, host, metric, key, n) VALUES (?,?,?,?,?)
      ON CONFLICT(day, host, metric, key) DO UPDATE SET n = n + excluded.n`).bind(day, host, metric, key, n));
  }
  for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
  if (todo.length) await db.prepare("DELETE FROM recent WHERE id < (SELECT MAX(id) - 3000 FROM recent)").run();
  const pending = keys.length - (await countProcessed(db, keys));
  if (full && pending === 0) await db.prepare("INSERT OR IGNORE INTO processed (key, at, events) VALUES (?,?,0)").bind(BACKFILLED, new Date().toISOString()).run();
  return { scanned: keys.length, processed: todo.length, events, pending, backfill: full };
}
async function countProcessed(db, keys) {
  let n = 0;
  for (let i = 0; i < keys.length; i += 80) {
    const chunk = keys.slice(i, i + 80);
    n += (await db.prepare(`SELECT COUNT(*) n FROM processed WHERE key IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).first()).n;
  }
  return n;
}

// ---------- stats ----------
async function cachedJson(url, ttl, init) {
  const cache = caches.default; const req = new Request(url, { headers: { "x-admin-cache": "1" } });
  const hit = await cache.match(req);
  if (hit) return hit.json();
  try {
    const r = await fetch(url, init);
    if (!r.ok) return null;
    const j = await r.json();
    await cache.put(req, new Response(JSON.stringify(j), { headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` } }));
    return j;
  } catch { return null; }
}
async function npmStats() {
  const pkgs = ["@genclass/runtime", "@genclass/runtime-model", "genclass-runtime"];
  const out = {};
  await Promise.all(pkgs.map(async (p) => {
    const e = p.replace("/", "%2F");
    const [range, versions, meta] = await Promise.all([
      cachedJson(`https://api.npmjs.org/downloads/range/last-month/${e}`, 600),
      cachedJson(`https://api.npmjs.org/versions/${e}/last-week`, 600),
      cachedJson(`https://registry.npmjs.org/${e}`, 300, { headers: { accept: "application/vnd.npm.install-v1+json" } }),
    ]);
    out[p] = { daily: range?.downloads || [], versions: versions?.downloads || {}, latest: meta?.["dist-tags"]?.latest || null, modified: meta?.modified || null };
  }));
  return out;
}
// Adoption without a beacon: the model download from jsDelivr is not optional, so CDN hits count every install that
// loaded the default model (telemetry on or off, minus self-hosted models and browser-cached repeats). Public GitHub
// repositories that depend on the package come from code search (needs the optional GITHUB_TOKEN secret).
async function adoptionStats(env) {
  const cdn = async (pkg) => {
    const j = await cachedJson(`https://data.jsdelivr.com/v1/stats/packages/npm/${pkg}?period=month`, 3600); // jsDelivr wants the literal slash
    const dates = j?.hits?.dates || {};
    return { total: j?.hits?.total ?? null, daily: Object.keys(dates).sort().map((day) => ({ day, hits: dates[day] })), bandwidth: j?.bandwidth?.total ?? null };
  };
  const [runtime, model] = await Promise.all([cdn("@genclass/runtime"), cdn("@genclass/runtime-model")]);
  let dependents = null;
  if (env.GITHUB_TOKEN) {
    const j = await cachedJson("https://api.github.com/search/code?q=%22%40genclass%2Fruntime%22+filename%3Apackage.json&per_page=50", 1800,
      { headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, "user-agent": "genclass-admin", accept: "application/vnd.github+json" } });
    if (j) dependents = { total: j.total_count, repos: [...new Set((j.items || []).map((i) => i.repository?.full_name).filter(Boolean))].slice(0, 50) };
  }
  return { runtime, model, dependents, note: "jsDelivr publishes daily stats with a 1–2 day delay; model loads count installs with the default CDN model, telemetry on or off." };
}
async function githubStats() {
  const j = await cachedJson("https://api.github.com/repos/genclass-dev/GenClass-lib", 600, { headers: { "user-agent": "genclass-admin", accept: "application/vnd.github+json" } });
  return j ? { stars: j.stargazers_count, forks: j.forks_count, issues: j.open_issues_count, watchers: j.subscribers_count, pushed: j.pushed_at } : null;
}
export async function stats(env, url) {
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 14));
  const includeTest = url.searchParams.get("test") === "1";
  const since = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
  const db = env.ADMIN_DB;
  const hostFilter = includeTest ? "" : "AND host NOT IN (SELECT DISTINCT host FROM sessions WHERE test = 1)";
  const q = (sql, ...b) => db.prepare(sql).bind(...b).all().then((r) => r.results);
  const [series, breakdown, hosts, recent, ingestState, testHosts] = await Promise.all([
    q(`SELECT day, metric, SUM(n) n FROM daily WHERE day >= ? AND metric IN ('sessions','decisions','detections','acted','undos') ${hostFilter} GROUP BY day, metric ORDER BY day`, since),
    q(`SELECT metric, key, SUM(n) n FROM daily WHERE day >= ? AND metric IN ('detections','acted','actions','runtime','mode','country','model_ready','model_error','decisions_by_trigger','breaker','diagnoses','latency_bucket','held','passive_reason','model_worker','model_cache','model_variant','route','aggressiveness','situation_text','webgpu','model_kind','vetoes') ${hostFilter} GROUP BY metric, key ORDER BY n DESC`, since),
    q(`SELECT s.host, MIN(s.first_at) first_at, MAX(s.last_at) last_at, COUNT(*) sessions, MAX(s.test) test, MAX(s.runtime) runtime,
        (SELECT SUM(n) FROM daily d WHERE d.host = s.host AND d.metric = 'detections' AND d.day >= ?1) detections,
        (SELECT SUM(n) FROM daily d WHERE d.host = s.host AND d.metric = 'acted' AND d.day >= ?1) acted
       FROM sessions s WHERE s.last_at >= ?1 ${includeTest ? "" : "AND s.test = 0"} GROUP BY s.host ORDER BY sessions DESC LIMIT 100`, since),
    q(`SELECT at, host, kind, trigger, diagnosis, action, outcome, confidence, runtime FROM recent ${includeTest ? "" : "WHERE host NOT IN (SELECT DISTINCT host FROM sessions WHERE test = 1)"} ORDER BY id DESC LIMIT 60`),
    db.prepare("SELECT COUNT(*) objects, SUM(events) events, MAX(at) last FROM processed WHERE key LIKE 'events/%'").first(),
    q("SELECT host, COUNT(*) sessions FROM sessions WHERE test = 1 GROUP BY host ORDER BY sessions DESC LIMIT 20"),
  ]);
  const load = await db.prepare(`SELECT SUM(CASE WHEN metric='model_load_ms' THEN n END) ms, SUM(CASE WHEN metric='model_load_n' THEN n END) n,
    SUM(CASE WHEN metric='latency_ms' THEN n END) lms, SUM(CASE WHEN metric='latency_n' THEN n END) ln FROM daily WHERE day >= ? ${hostFilter}`).bind(since).first();
  const [waitlist, waitlistRecent, projects, npm, github, adoption] = await Promise.all([
    env.DB ? env.DB.prepare("SELECT plan, COUNT(*) n FROM waitlist GROUP BY plan").all().then((r) => r.results).catch(() => []) : [],
    env.DB ? env.DB.prepare("SELECT email, company, apps, plan, page, created_at FROM waitlist ORDER BY id DESC LIMIT 25").all().then((r) => r.results).catch(() => []) : [],
    env.DASH_DB ? env.DASH_DB.prepare("SELECT name, created, last_event FROM projects ORDER BY created DESC LIMIT 50").all().then((r) => r.results).catch(() => []) : [],
    npmStats(), githubStats(), adoptionStats(env),
  ]);
  return { generatedAt: new Date().toISOString(), days, includeTest, series, breakdown, hosts, testHosts, recent, ingest: ingestState,
    modelLoadMs: load && load.n ? Math.round(load.ms / load.n) : null, decisionLatencyMs: load && load.ln ? Math.round(load.lms / load.ln) : null,
    waitlist, waitlistRecent, projects, npm, github, adoption };
}
