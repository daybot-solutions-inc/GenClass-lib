// genclass.dev edge worker: canonical host, early-access API, then static assets with security and cache headers.
const CANONICAL = "genclass.dev";

const SECURITY = {
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://static.cloudflareinsights.com https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://cloudflareinsights.com https://cdn.jsdelivr.net; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const PLANS = new Set(["cloud", "enterprise", "community"]);
const APPS = new Set(["1", "2-5", "6-20", "21+"]);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

async function waitlist(request, env) {
  const isForm = !(request.headers.get("content-type") || "").includes("application/json");
  const reply = (status, body) =>
    isForm
      ? status < 300 ? Response.redirect(`https://${CANONICAL}/thanks`, 303) : new Response(body.error, { status, headers: { "content-type": "text/plain" } })
      : Response.json(body, { status, headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });

  if (env.LIMIT) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const { success } = await env.LIMIT.limit({ key: ip });
    if (!success) return reply(429, { error: "Too many requests. Please try again in a minute." });
  }
  const len = Number(request.headers.get("content-length") || 0);
  if (len > 4096) return reply(413, { error: "Request too large." });

  let data;
  try {
    data = isForm ? Object.fromEntries(await request.formData()) : await request.json();
  } catch {
    return reply(400, { error: "Could not read the form." });
  }
  if (clip(data.website, 200)) return reply(200, { ok: true }); // honeypot: pretend success
  const email = clip(data.email, 254).toLowerCase();
  if (!EMAIL.test(email)) return reply(400, { error: "Please enter a valid work email." });
  const plan = PLANS.has(data.plan) ? data.plan : "cloud";
  const apps = APPS.has(data.apps) ? data.apps : null;
  try {
    await env.DB.prepare(
      "INSERT INTO waitlist (email, company, apps, plan, page) VALUES (?1, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT(email, plan) DO UPDATE SET company = excluded.company, apps = excluded.apps",
    )
      .bind(email, clip(data.company, 120) || null, apps, plan, clip(data.page, 80) || null)
      .run();
  } catch (e) {
    console.error("waitlist insert failed", e && e.message);
    return reply(500, { error: "Something went wrong on our side. Please try again." });
  }
  return reply(200, { ok: true });
}


// ---------- demo backend for the live GenClass lab on the home page ----------
const CITIES = ["San Francisco","San Diego","San Jose","San Antonio","Santa Fe","Santiago","Sapporo","Salvador","Paris","Panama City",
  "Palermo","Perth","Porto","Prague","Lisbon","London","Los Angeles","Lima","Lagos","Toronto","Tokyo","Tallinn","Taipei","Berlin",
  "Bergen","Bern","Boston","Bogota","Mumbai","Munich","Montreal","Madrid","Melbourne","Seoul","Seattle","Singapore","Stockholm",
  "Sydney","Vancouver","Vienna","Venice","Waterloo"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (url, d) => Math.max(0, Math.min(3000, Number(url.searchParams.get("ms")) || d));
const demoJson = (body, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });

async function demoApi(request, url) {
  const path = url.pathname.slice("/demo-api".length);
  if (path === "/search" && request.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 40);
    await sleep(ms(url, 200));
    return demoJson({ q, results: q ? CITIES.filter((c) => c.toLowerCase().startsWith(q)).slice(0, 5) : [] });
  }
  if (path === "/orders" && request.method === "POST") {
    await sleep(ms(url, 900));
    return demoJson({ orderId: "ord_" + crypto.randomUUID().slice(0, 8), placedAt: Date.now() }, 201);
  }
  if (path === "/stock" && request.method === "GET") {
    await sleep(ms(url, 120));
    if (url.searchParams.get("fail") === "1") return demoJson({ error: "inventory service unavailable" }, 503);
    return demoJson({ sku: "esp32-devkit", stock: 40 + Math.floor(Math.random() * 8), at: Date.now() });
  }
  return demoJson({ error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === `www.${CANONICAL}`) {
      url.hostname = CANONICAL;
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === "/forms/waitlist") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
      return waitlist(request, env);
    }
    if (url.pathname.startsWith("/forms/")) return new Response("Not found", { status: 404 });
    if (url.pathname.startsWith("/demo-api/")) return demoApi(request, url);

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
    const path = url.pathname;
    if (path === "/thanks") out.headers.set("x-robots-tag", "noindex");
    if (/\.(png|svg|ico|webmanifest)$/.test(path)) out.headers.set("cache-control", "public, max-age=604800");
    else if (/\.(css|js)$/.test(path)) out.headers.set("cache-control", "public, max-age=31536000, immutable");
    else if (/\.(txt|xml)$/.test(path)) out.headers.set("cache-control", "public, max-age=3600");
    else out.headers.set("cache-control", "public, max-age=300, must-revalidate");
    return out;
  },
};
