// genclass.dev/admin: the login page, the dashboard shell and its script (served at /admin/app.js under a strict CSP).
// Everything rendered from telemetry (hosts, routes, error text) is untrusted: the script only sets textContent.

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;700&family=Figtree:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">`;

const BASE_CSS = `
:root{--paper:#fff;--panel:#F5F8FB;--ink:#0E1F4D;--ink2:#3D4B6B;--ink3:#5A6684;--rule:#DFE4EC;--rule2:#C6CEDB;
--green:#14B86A;--green-d:#08794A;--green-t:#DCF5E8;--red:#F0451C;--red-d:#C42A12;--red-t:#FDE6E0;--amber:#D98A00;--amber-t:#FFF3D6;
--night:#0B1736;--night2:#13224A;--nline:#26355E;--ntext:#E8EDF8;--ndim:#97A3C2;
--display:"Outfit","Helvetica Neue",Arial,sans-serif;--sans:"Figtree","Helvetica Neue",Arial,sans-serif;--mono:"Geist Mono",ui-monospace,Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--panel);color:var(--ink);font:15px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
button,select,input{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--green);outline-offset:2px}`;

export function LOGIN_PAGE(msg) {
  const m = msg ? `<p class="err" role="alert">${String(msg).replace(/[<>&"]/g, "")}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>GenClass Admin</title><link rel="icon" href="/brand/mark-32.png?v=2">${FONTS}
<style>${BASE_CSS}
body{min-height:100vh;display:grid;place-items:center;padding:16px;background:radial-gradient(1200px 600px at 50% -10%,#E7F8EF,transparent),var(--panel)}
.card{width:min(380px,100%);background:#fff;border:1px solid var(--rule);border-radius:16px;padding:28px;box-shadow:0 30px 60px -40px rgba(14,31,77,.4)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:22px}.brand img{height:30px}
.brand span{font:500 12px var(--mono);color:var(--ink3);border:1px solid var(--rule);border-radius:999px;padding:2px 8px}
h1{font:700 22px var(--display);letter-spacing:-.02em;margin-bottom:4px}p{color:var(--ink3);font-size:14px}
label{display:block;font:500 13px var(--sans);color:var(--ink2);margin:18px 0 6px}
input{width:100%;min-height:44px;border:1px solid var(--rule2);border-radius:8px;padding:0 12px;font-size:16px}
button{width:100%;min-height:44px;margin-top:14px;border:0;border-radius:8px;background:var(--ink);color:#fff;font-weight:600;cursor:pointer}
button:hover{background:#1B2F66}.err{color:var(--red-d);background:var(--red-t);border-radius:8px;padding:8px 10px;margin-top:14px;font-size:13.5px}</style></head>
<body><form class="card" method="post" action="/admin/login">
<div class="brand"><img src="/brand/lockup-h.png?v=2" alt="genclass"><span>admin</span></div>
<h1>Sign in</h1><p>Usage, detections and fixes across every site running GenClass.</p>${m}
<label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Open dashboard</button></form></body></html>`;
}

export const ADMIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>GenClass Admin</title><link rel="icon" href="/brand/mark-32.png?v=2">${FONTS}
<style>${BASE_CSS}
.top{position:sticky;top:0;z-index:5;background:rgba(255,255,255,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--rule)}
.top .in{max-width:1400px;margin:0 auto;padding:10px 20px;display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.top img{height:28px;display:block}.tag{font:500 12px var(--mono);color:var(--ink3);border:1px solid var(--rule);border-radius:999px;padding:2px 8px}
.live{display:flex;align-items:center;gap:7px;font:12.5px var(--mono);color:var(--ink3)}
.live i{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px var(--green-t)}
.live.off i{background:var(--rule2);box-shadow:none}.live.err i{background:var(--red);box-shadow:0 0 0 3px var(--red-t)}
.ctl{margin-left:auto;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.seg{display:flex;border:1px solid var(--rule2);border-radius:8px;overflow:hidden}
.seg button{border:0;background:#fff;padding:6px 11px;font-size:13px;cursor:pointer;color:var(--ink2)}
.seg button[aria-pressed=true]{background:var(--ink);color:#fff}
.btn{border:1px solid var(--rule2);background:#fff;border-radius:8px;padding:6px 11px;font-size:13px;cursor:pointer;color:var(--ink);text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.btn:hover{border-color:var(--ink)}
.chk{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink2);cursor:pointer}
main{max-width:1400px;margin:0 auto;padding:20px;display:grid;gap:16px}
.banner{border:1px solid #F3D9A0;background:var(--amber-t);color:#6B4A00;border-radius:12px;padding:12px 14px;font-size:14px}
.banner:empty{display:none}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(190px,46%),1fr));gap:12px}
.kpi{background:#fff;border:1px solid var(--rule);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:4px;min-width:0}
.kpi .k{font:500 12px var(--mono);color:var(--ink3);text-transform:uppercase;letter-spacing:.04em}
.kpi .v{font:700 30px/1.1 var(--display);letter-spacing:-.02em}
.kpi .s{font-size:12.5px;color:var(--ink3)}
.kpi svg{width:100%;height:34px;margin-top:4px}
.kpi.good .v{color:var(--green-d)} .kpi.bad .v{color:var(--red-d)}
.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px}
.card{background:#fff;border:1px solid var(--rule);border-radius:14px;padding:16px;min-width:0}
.card h2{font:600 15px var(--sans);display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:12px}
.card h2 small{font:12px var(--mono);color:var(--ink3);font-weight:400}
.c8{grid-column:span 8}.c6{grid-column:span 6}.c4{grid-column:span 4}.c12{grid-column:span 12}
@media (max-width:1100px){.c8,.c6,.c4{grid-column:span 12}}
.chart svg{width:100%;height:220px;display:block}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12.5px;color:var(--ink2);margin-top:8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.bars{display:flex;flex-direction:column;gap:7px}
.bar{display:grid;grid-template-columns:minmax(90px,38%) 1fr auto;gap:10px;align-items:center;font-size:13px}
.bar span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink2)}
.bar div{height:8px;border-radius:4px;background:var(--panel);overflow:hidden}.bar div i{display:block;height:100%;border-radius:4px;background:var(--ink)}
.bar b{font:500 12.5px var(--mono)}
.bars.green .bar div i{background:var(--green)}.bars.red .bar div i{background:var(--red)}
.empty{font-size:13.5px;color:var(--ink3);border:1px dashed var(--rule2);border-radius:10px;padding:14px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font:500 11.5px var(--mono);color:var(--ink3);text-transform:uppercase;letter-spacing:.04em;padding:6px 8px;border-bottom:1px solid var(--rule)}
td{padding:8px;border-bottom:1px solid var(--rule);vertical-align:top;overflow-wrap:anywhere}
td.n,th.n{text-align:right;font-family:var(--mono)}
.scroll{overflow:auto;max-height:420px}.scroll table{min-width:620px}
.pill{display:inline-block;font:500 11.5px var(--mono);border-radius:999px;padding:1px 7px;background:var(--panel);color:var(--ink2)}
.pill.test{background:var(--amber-t);color:#7A5200}.pill.ok{background:var(--green-t);color:var(--green-d)}.pill.bad{background:var(--red-t);color:var(--red-d)}
.feed{background:var(--night);color:var(--ntext);border-color:var(--night)}
.feed h2 small{color:var(--ndim)}
.feed ol{list-style:none;display:flex;flex-direction:column;gap:6px;max-height:420px;overflow:auto}
.feed li{display:grid;grid-template-columns:70px 1fr;gap:10px;font-size:13px;padding:8px 10px;border:1px solid var(--nline);border-radius:8px;background:var(--night2)}
.feed li time{font:12px var(--mono);color:var(--ndim)}
.feed li b{color:#fff;font-weight:600}.feed li .h{display:block;font:12px var(--mono);color:var(--ndim);overflow-wrap:anywhere}
.feed li.detect{border-left:3px solid #F5A524}.feed li.action{border-left:3px solid var(--green)}
.feed .empty{display:block;color:var(--ndim);border-color:var(--nline)}
.mini{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.mini div{background:var(--panel);border-radius:10px;padding:10px 12px}.mini b{display:block;font:700 20px var(--display)}.mini span{font-size:12px;color:var(--ink3)}
.foot{font:12px var(--mono);color:var(--ink3);text-align:center;padding:8px 0 24px}
.notes{font-size:12.5px;line-height:1.5;padding-left:16px;display:flex;flex-direction:column;gap:6px}.notes b{font-weight:600}
</style></head><body>
<header class="top"><div class="in">
<a href="/"><img src="/brand/lockup-h.png?v=2" alt="genclass"></a><span class="tag">admin</span>
<span class="live off" id="live"><i></i><span id="live-t">connecting…</span></span>
<div class="ctl">
<div class="seg" role="group" aria-label="Range" id="range"><button data-d="1">24h</button><button data-d="7">7d</button><button data-d="14" aria-pressed="true">14d</button><button data-d="30">30d</button><button data-d="90">90d</button></div>
<label class="chk"><input type="checkbox" id="test"> Include test traffic</label>
<button class="btn" id="ingest" type="button">Sync telemetry</button>
<button class="btn" id="pause" type="button" aria-pressed="false">Pause</button>
<a class="btn" href="/admin/logout">Sign out</a>
</div></div></header>
<main>
<div class="banner" id="banner"></div>
<section class="kpis" id="kpis"></section>
<section class="grid">
<div class="card chart c8"><h2>Runtime activity <small id="act-sub"></small></h2><div id="act"></div><div class="legend" id="act-leg"></div></div>
<div class="card feed c4"><h2>Live feed <small>latest detections and fixes</small></h2><ol id="feed"></ol></div>
<div class="card c4"><h2>Errors found <small>by diagnosis</small></h2><div class="bars" id="b-diag"></div></div>
<div class="card c4"><h2>Fixes applied <small>interventions, before undos</small></h2><div class="bars green" id="b-act"></div></div>
<div class="card c4"><h2>Model health <small id="m-sub"></small></h2><div class="mini" id="m-mini"></div><div class="bars red" id="b-merr" style="margin-top:12px"></div></div>
<div class="card c4"><h2>Decisions by trigger <small>what the model was asked about</small></h2><div class="bars" id="b-trig"></div></div>
<div class="card c4"><h2>Decision latency <small id="lat-sub"></small></h2><div class="bars" id="b-lat"></div></div>
<div class="card c4"><h2>Held vs background <small>could it still act?</small></h2><div class="bars" id="b-held"></div><div class="bars" id="b-reason" style="margin-top:12px"></div></div>
<div class="card c4"><h2>Model backend <small>sessions and loads</small></h2><div class="bars" id="b-backend"></div></div>
<div class="card c4"><h2>Top routes <small>id-normalised, no query</small></h2><div class="bars" id="b-route"></div></div>
<div class="card c8"><h2>Adoption without a beacon <small id="ad-sub"></small></h2><div class="mini" id="ad-mini"></div><div id="ad-chart" style="margin-top:12px"></div><div class="legend" id="ad-leg"></div><div id="ad-deps" style="margin-top:12px"></div></div>
<div class="card c4"><h2>What this page cannot see <small>coverage</small></h2><ul class="notes">
<li><b>Who turned telemetry off is unknowable by design.</b> <code>telemetry: false</code> sends nothing, and that stays literally true. The Adoption card estimates the share instead: CDN model loads count every install, telemetry on or off.</li>
<li><b>Only pages with telemetry on.</b> Since 0.2.1 nothing is sent from localhost, *.local, *.test or private networks, nor with <code>telemetry: false</code>, <code>?genclass=no-telemetry</code>, the localStorage opt-out, Global Privacy Control, <code>createRuntime()</code>, Node/SSR, or sampled-out sessions.</li>
<li><b>Blocked deliveries.</b> A strict Content-Security-Policy without the collector in <code>connect-src</code>, tracker blockers, offline users and page exits before the last beacon all drop batches silently; over 60 batches a minute from one IP are rejected.</li>
<li><b>No people.</b> One random id per page load: no users, IPs, user agents, cross-page sessions, funnels or retention.</li>
<li><b>No page content.</b> No situation text unless the app opts in, no URLs beyond hostname and id-normalised path, no bodies, headers or storage.</li>
<li><b>No ground truth.</b> A detection is the model's opinion; nothing here says whether it was a real bug or whether a fix helped, apart from undos and breaker trips.</li>
<li><b>Not yet wired.</b> Per-app Cloud dashboards (/start tokens) need a runtime that sends the token; 0.2.1 does not. npm counts lag about a day.</li>
</ul></div>
<div class="card c12"><h2>Sites running GenClass <small id="hosts-sub"></small></h2><div class="scroll" id="hosts"></div></div>
<div class="card chart c8"><h2>npm downloads <small id="npm-sub"></small></h2><div id="npm"></div><div class="legend" id="npm-leg"></div></div>
<div class="card c4"><h2>Downloads by version <small>last 7 days</small></h2><div class="bars" id="b-ver"></div></div>
<div class="card c4"><h2>Runtime versions <small>sessions</small></h2><div class="bars" id="b-rt"></div></div>
<div class="card c4"><h2>Modes <small>sessions</small></h2><div class="bars" id="b-mode"></div></div>
<div class="card c4"><h2>Countries <small>sessions</small></h2><div class="bars" id="b-country"></div></div>
<div class="card c8"><h2>Waitlist <small id="wl-sub"></small></h2><div class="scroll" id="wl"></div></div>
<div class="card c4"><h2>GitHub &amp; projects</h2><div class="mini" id="gh"></div><div id="proj" style="margin-top:12px"></div></div>
</section>
<p class="foot" id="foot"></p>
</main>
<script src="/admin/app.js" defer></script></body></html>`;

export const ADMIN_JS = `(() => {
const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const E = (tag, attrs, kids) => { const e = tag.startsWith("svg:") ? document.createElementNS(NS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === "text") e.textContent = v; else if (k === "cls") e.setAttribute("class", v); else if (v !== undefined && v !== null) e.setAttribute(k, v); }
  for (const c of [].concat(kids || [])) if (c !== null && c !== undefined) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e; };
const fmt = (n) => n === null || n === undefined ? "–" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? (n / 1e3).toFixed(1) + "k" : Number(n).toLocaleString();
const ago = (iso) => { if (!iso) return "–"; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? Math.max(0, Math.round(s)) + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago"; };
const C = { sessions: "#0E1F4D", detections: "#F5A524", acted: "#14B86A", undos: "#F0451C", decisions: "#8FA0C4" };
let days = 14, test = false, paused = false, timer = null, data = null;
try { const s = JSON.parse(localStorage.getItem("gc-admin") || "{}"); if (s.days) days = s.days; test = !!s.test; } catch {}
const save = () => { try { localStorage.setItem("gc-admin", JSON.stringify({ days, test })); } catch {} };

function dayList(n) { const out = []; for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)); return out; }
function sum(rows, metric) { return rows.filter((r) => r.metric === metric).reduce((a, r) => a + r.n, 0); }
function byKey(rows, metric) { return rows.filter((r) => r.metric === metric).map((r) => [r.key || "?", r.n]); }

function spark(values, color) {
  const w = 200, h = 34, max = Math.max(1, ...values), step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => (i * step).toFixed(1) + "," + (h - 2 - (v / max) * (h - 6)).toFixed(1)).join(" ");
  return E("svg:svg", { viewBox: "0 0 " + w + " " + h, preserveAspectRatio: "none", "aria-hidden": "true" }, [
    E("svg:polyline", { points: "0," + h + " " + pts + " " + w + "," + h, fill: color, "fill-opacity": ".12", stroke: "none" }),
    E("svg:polyline", { points: pts, fill: "none", stroke: color, "stroke-width": "2", "vector-effect": "non-scaling-stroke" })]);
}
function kpi(label, value, sub, cls, sparkVals, color) {
  return E("div", { cls: "kpi " + (cls || "") }, [E("span", { cls: "k", text: label }), E("span", { cls: "v", text: value }), E("span", { cls: "s", text: sub }), sparkVals ? spark(sparkVals, color) : null]);
}
function lineChart(el, legendEl, labels, series) {
  el.replaceChildren(); legendEl.replaceChildren();
  const W = 800, H = 220, L = 40, B = 24, T = 10, R = 26, raw = Math.max(4, ...series.flatMap((s) => s.values)), mag = Math.pow(10, Math.floor(Math.log10(raw / 4))), max = Math.ceil(raw / 4 / mag) * mag * 4;
  const x = (i) => L + (labels.length > 1 ? i * (W - L - R) / (labels.length - 1) : (W - L - R) / 2), y = (v) => T + (H - T - B) * (1 - v / max);
  const svg = E("svg:svg", { viewBox: "0 0 " + W + " " + H, preserveAspectRatio: "none", role: "img", "aria-label": series.map((s) => s.name).join(", ") + " per day" });
  for (let g = 0; g <= 4; g++) { const v = max * g / 4, yy = y(v);
    svg.append(E("svg:line", { x1: L, x2: W - R, y1: yy, y2: yy, stroke: "#DFE4EC" }), E("svg:text", { x: L - 6, y: yy + 4, "text-anchor": "end", "font-size": "11", fill: "#5A6684", "font-family": "Geist Mono, monospace", text: fmt(Math.round(v)) })); }
  const every = Math.ceil(labels.length / 8);
  labels.forEach((d, i) => { if (i % every === 0 || i === labels.length - 1) svg.append(E("svg:text", { x: x(i), y: H - 6, "text-anchor": "middle", "font-size": "11", fill: "#5A6684", "font-family": "Geist Mono, monospace", text: d.slice(5) })); });
  for (const s of series) {
    const pts = s.values.map((v, i) => x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" ");
    if (s.area) svg.append(E("svg:polygon", { points: x(0) + "," + y(0) + " " + pts + " " + x(s.values.length - 1) + "," + y(0), fill: s.color, "fill-opacity": ".08" }));
    svg.append(E("svg:polyline", { points: pts, fill: "none", stroke: s.color, "stroke-width": "2.2", "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke" }));
    s.values.forEach((v, i) => { if (v) svg.append(E("svg:circle", { cx: x(i), cy: y(v), r: 2.6, fill: s.color }, E("svg:title", { text: s.name + " " + labels[i] + ": " + v }))); });
    legendEl.append(E("span", {}, [E("i", { style: "background:" + s.color }), s.name + " " + fmt(s.values.reduce((a, b) => a + b, 0))]));
  }
  el.append(svg);
}
function bars(el, pairs, empty, limit) {
  el.replaceChildren();
  pairs = pairs.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, limit || 8);
  if (!pairs.length) { el.append(E("p", { cls: "empty", text: empty })); return; }
  const max = Math.max(...pairs.map((p) => p[1]));
  for (const [k, n] of pairs) { const fill = E("i"); fill.style.width = (100 * n / max).toFixed(1) + "%"; el.append(E("div", { cls: "bar" }, [E("span", { text: k, title: k }), E("div", {}, fill), E("b", { text: fmt(n) })])); }
}
function table(el, head, rows, empty) {
  el.replaceChildren();
  if (!rows.length) { el.append(E("p", { cls: "empty", text: empty })); return; }
  el.append(E("table", {}, [E("thead", {}, E("tr", {}, head.map((h) => E("th", { cls: h.n ? "n" : "", text: h.t })))),
    E("tbody", {}, rows.map((r) => E("tr", {}, r.map((c, i) => E("td", { cls: head[i].n ? "n" : "" }, c)))))]));
}
const DIAG = { duplicate: "Duplicate request", stale: "Stale data", conflict: "Race / conflict", failing: "Failing API", transient: "Transient failure", slow: "Slow operation", overload: "Overload", inconsistent: "Inconsistent state", unusual: "Unusual behaviour" };

function render(d) {
  data = d;
  const labels = dayList(d.days);
  const seriesOf = (m) => labels.map((day) => d.series.filter((r) => r.day === day && r.metric === m).reduce((a, r) => a + r.n, 0));
  const S = { sessions: seriesOf("sessions"), decisions: seriesOf("decisions"), detections: seriesOf("detections"), acted: seriesOf("acted"), undos: seriesOf("undos") };
  const tot = (k) => S[k].reduce((a, b) => a + b, 0);
  const rtNpm = (d.npm && d.npm["@genclass/runtime"]) || { daily: [] };
  const npmDaily = rtNpm.daily.slice(-d.days);
  const npmTotal = npmDaily.reduce((a, r) => a + r.downloads, 0);
  const liveSites = d.hosts.filter((h) => !h.test).length;
  const resolved = Math.max(0, tot("acted") - tot("undos"));
  const wlTotal = d.waitlist.reduce((a, r) => a + r.n, 0);
  const range = d.days === 1 ? "last 24h" : "last " + d.days + " days";

  $("banner").replaceChildren();
  if (!test && !liveSites && d.testHosts.length) $("banner").append("No production sites have reported yet. Telemetry so far is test traffic only (" + d.testHosts.map((h) => h.host || "(no host)").slice(0, 5).join(", ") + "). Tick “Include test traffic” to see it.");

  $("kpis").replaceChildren(
    kpi("npm downloads", fmt(npmTotal), "@genclass/runtime · " + range + (rtNpm.latest ? " · latest " + rtNpm.latest : ""), "", npmDaily.map((r) => r.downloads), "#0E1F4D"),
    kpi("Live sites", fmt(liveSites), test ? "incl. " + d.hosts.filter((h) => h.test).length + " test hosts" : "production hosts with sessions", "", null),
    kpi("Sessions", fmt(tot("sessions")), fmt(tot("decisions")) + " decisions by the model", "", S.sessions, "#0E1F4D"),
    kpi("Errors found", fmt(tot("detections")), "detections above the report gate", tot("detections") ? "bad" : "", S.detections, "#F5A524"),
    kpi("Errors resolved", fmt(resolved), fmt(tot("acted")) + " fixes applied · " + fmt(tot("undos")) + " undone", resolved ? "good" : "", S.acted, "#14B86A"),
    kpi("Waitlist", fmt(wlTotal), d.waitlist.map((r) => (r.plan || "?") + " " + r.n).join(" · ") || "no sign-ups yet", "", null));

  $("act-sub").textContent = range;
  lineChart($("act"), $("act-leg"), labels, [
    { name: "Sessions", values: S.sessions, color: C.sessions, area: true },
    { name: "Errors found", values: S.detections, color: C.detections },
    { name: "Fixes applied", values: S.acted, color: C.acted },
    { name: "Undone", values: S.undos, color: C.undos }]);

  const feed = $("feed"); feed.replaceChildren();
  if (!d.recent.length) feed.append(E("li", { cls: "empty", text: "Nothing yet. Detections and fixes from every site appear here within a minute." }));
  for (const r of d.recent.slice(0, 40)) {
    const what = r.kind === "detect" ? (DIAG[r.diagnosis] || r.diagnosis || "detection") + (r.confidence ? " · " + Math.round(r.confidence * 100) + "%" : "") : "Fix: " + (r.action || "?") + " · " + (r.outcome || "");
    feed.append(E("li", { cls: r.kind }, [E("time", { text: ago(r.at), title: r.at }), E("div", {}, [E("b", { text: what }), E("span", { cls: "h", text: (r.host || "(no host)") + (r.trigger ? " · " + r.trigger : "") + (r.runtime ? " · v" + r.runtime : "") })])]));
  }

  bars($("b-diag"), byKey(d.breakdown, "detections").map(([k, n]) => [DIAG[k] || k, n]), "No errors found in this range.");
  bars($("b-act"), byKey(d.breakdown, "acted"), "No fixes applied in this range.");
  const ready = byKey(d.breakdown, "model_ready"), errs = byKey(d.breakdown, "model_error"), brk = byKey(d.breakdown, "breaker");
  const loads = ready.reduce((a, r) => a + r[1], 0), nerr = errs.reduce((a, r) => a + r[1], 0);
  $("m-sub").textContent = range;
  $("m-mini").replaceChildren(
    E("div", {}, [E("b", { text: fmt(loads) }), E("span", { text: "model loads (" + (ready.map(([k, n]) => k + " " + n).join(", ") || "–") + ")" })]),
    E("div", {}, [E("b", { text: d.modelLoadMs ? (d.modelLoadMs / 1000).toFixed(1) + "s" : "–" }), E("span", { text: "avg load time" })]),
    E("div", {}, [E("b", { text: loads + nerr ? Math.round(100 * loads / (loads + nerr)) + "%" : "–" }), E("span", { text: "load success" })]),
    E("div", {}, [E("b", { text: fmt(brk.reduce((a, r) => a + r[1], 0)) }), E("span", { text: "breaker trips" })]));
  bars($("b-merr"), errs, "No model errors.");

  bars($("b-trig"), byKey(d.breakdown, "decisions_by_trigger"), "No decisions in this range.");
  $("lat-sub").textContent = d.decisionLatencyMs ? "avg " + d.decisionLatencyMs + " ms per model call" : "per model call";
  bars($("b-lat"), byKey(d.breakdown, "latency_bucket"), "No decisions in this range.", 5);
  bars($("b-held"), byKey(d.breakdown, "held"), "No decisions in this range.", 2);
  bars($("b-reason"), byKey(d.breakdown, "passive_reason"), "No passive decisions.", 6);
  bars($("b-backend"), [].concat(byKey(d.breakdown, "model_ready").map(([k, n]) => ["device: " + k, n]), byKey(d.breakdown, "model_worker"), byKey(d.breakdown, "model_cache"),
    byKey(d.breakdown, "webgpu").map(([k, n]) => ["WebGPU " + k, n]), byKey(d.breakdown, "situation_text").map(([k, n]) => ["situation text " + k, n]), byKey(d.breakdown, "model_kind").map(([k, n]) => ["model " + k, n])), "No model loads in this range.", 12);
  bars($("b-route"), byKey(d.breakdown, "route"), "No sessions in this range.", 10);

  const ad = d.adoption || {}; const rtc = ad.runtime || { daily: [] }; const mdc = ad.model || { daily: [] };
  const cdnDays = mdc.daily.slice(-d.days); const modelLoads = cdnDays.reduce((a, r) => a + r.hits, 0);
  const sessionsAll = tot("sessions");
  const optOut = modelLoads > 0 ? Math.max(0, Math.min(1, 1 - sessionsAll / modelLoads)) : null;
  $("ad-sub").textContent = range + " · jsDelivr stats, 1–2 day delay";
  $("ad-mini").replaceChildren(
    E("div", {}, [E("b", { text: fmt(modelLoads) }), E("span", { text: "model loads from the CDN (every install, telemetry on or off)" })]),
    E("div", {}, [E("b", { text: fmt(rtc.daily.slice(-d.days).reduce((a, r) => a + r.hits, 0)) }), E("span", { text: "script-tag loads from the CDN" })]),
    E("div", {}, [E("b", { text: fmt(sessionsAll) }), E("span", { text: "sessions that sent telemetry" })]),
    E("div", {}, [E("b", { text: optOut === null ? "–" : Math.round(optOut * 100) + "%" }), E("span", { text: "estimated share with telemetry off (loads minus sessions)" })]));
  $("ad-chart").className = cdnDays.length ? "chart" : "";
  if (cdnDays.length) lineChart($("ad-chart"), $("ad-leg"), cdnDays.map((r) => r.day), [
    { name: "Model loads (CDN)", values: cdnDays.map((r) => r.hits), color: C.sessions, area: true },
    { name: "Telemetry sessions", values: cdnDays.map((r) => S.sessions[labels.indexOf(r.day)] || 0), color: C.acted }]);
  else { $("ad-chart").replaceChildren(E("p", { cls: "empty", text: "CDN stats unavailable right now." })); $("ad-leg").replaceChildren(); }
  const deps = ad.dependents;
  if (!deps) $("ad-deps").replaceChildren(E("p", { cls: "empty", text: "Public GitHub repos depending on @genclass/runtime: add the GITHUB_TOKEN secret (read-only, public repos) to list them here." }));
  else table($("ad-deps"), [{ t: "Public GitHub repos with @genclass/runtime in package.json (" + fmt(deps.total) + ")" }], deps.repos.map((r) => [E("a", { href: "https://github.com/" + r, target: "_blank", rel: "noopener", text: r })]), "No public repos depend on it yet (GitHub code search).");

  $("hosts-sub").textContent = d.hosts.length + " host" + (d.hosts.length === 1 ? "" : "s") + " · " + range;
  table($("hosts"), [{ t: "Host" }, { t: "Runtime" }, { t: "Sessions", n: 1 }, { t: "Errors found", n: 1 }, { t: "Fixes", n: 1 }, { t: "First seen" }, { t: "Last seen" }],
    d.hosts.map((h) => [E("span", {}, [h.host || "(no host)", " ", h.test ? E("span", { cls: "pill test", text: "test" }) : E("span", { cls: "pill ok", text: "live" })]),
      h.runtime || "–", fmt(h.sessions), fmt(h.detections || 0), fmt(h.acted || 0), ago(h.first_at), ago(h.last_at)]),
    test ? "No sessions in this range." : "No production sites in this range yet.");

  const npmSeries = ["@genclass/runtime", "@genclass/runtime-model", "genclass-runtime"].filter((p) => d.npm && d.npm[p] && d.npm[p].daily.length);
  const nl = (d.npm["@genclass/runtime"] || { daily: [] }).daily.slice(-d.days).map((r) => r.day);
  $("npm-sub").textContent = range + " · npm reports with ~1 day delay";
  if (nl.length) lineChart($("npm"), $("npm-leg"), nl, npmSeries.map((p, i) => ({ name: p, values: d.npm[p].daily.slice(-d.days).map((r) => r.downloads), color: ["#0E1F4D", "#14B86A", "#8FA0C4"][i], area: i === 0 })));
  else { $("npm").replaceChildren(E("p", { cls: "empty", text: "npm stats unavailable right now." })); $("npm-leg").replaceChildren(); }
  bars($("b-ver"), Object.entries(rtNpm.versions || {}), "No per-version data.", 10);
  bars($("b-rt"), byKey(d.breakdown, "runtime"), "No sessions.");
  bars($("b-mode"), byKey(d.breakdown, "mode"), "No sessions.");
  bars($("b-country"), byKey(d.breakdown, "country"), "No sessions.");

  $("wl-sub").textContent = wlTotal + " total · latest 25";
  table($("wl"), [{ t: "Email" }, { t: "Company" }, { t: "Plan" }, { t: "Apps" }, { t: "Page" }, { t: "When" }],
    d.waitlistRecent.map((w) => [w.email, w.company || "–", w.plan || "–", w.apps || "–", w.page || "–", ago(w.created_at && w.created_at.includes("T") ? w.created_at : (w.created_at || "").replace(" ", "T") + "Z")]), "No sign-ups yet.");

  const gh = d.github || {};
  $("gh").replaceChildren(
    E("div", {}, [E("b", { text: fmt(gh.stars) }), E("span", { text: "GitHub stars" })]),
    E("div", {}, [E("b", { text: fmt(gh.forks) }), E("span", { text: "forks" })]),
    E("div", {}, [E("b", { text: fmt(gh.issues) }), E("span", { text: "open issues" })]),
    E("div", {}, [E("b", { text: fmt(d.projects.length) }), E("span", { text: "Cloud projects" })]));
  table($("proj"), [{ t: "Project" }, { t: "Created" }, { t: "Last event" }], d.projects.slice(0, 10).map((p) => [p.name || "–", ago(p.created), ago(p.last_event)]), "No Cloud dashboard projects yet.");

  const ing = d.ingest || {};
  $("foot").textContent = "Telemetry: " + fmt(ing.objects || 0) + " batches · " + fmt(ing.events || 0) + " events ingested · last sync " + ago(ing.last) + " · page generated " + new Date(d.generatedAt).toLocaleTimeString();
}

async function load() {
  const live = $("live");
  try {
    const r = await fetch("/admin/api/stats?days=" + days + (test ? "&test=1" : ""), { cache: "no-store", credentials: "same-origin" });
    if (r.status === 401) { location.reload(); return; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    render(await r.json());
    live.className = "live" + (paused ? " off" : ""); $("live-t").textContent = paused ? "paused" : "live · every 15s";
  } catch (e) { live.className = "live err"; $("live-t").textContent = "update failed (" + e.message + ")"; }
}
function schedule() { clearInterval(timer); if (!paused) timer = setInterval(() => { if (!document.hidden) load(); }, 15000); }

document.querySelectorAll("#range button").forEach((b) => {
  b.setAttribute("aria-pressed", String(Number(b.dataset.d) === days));
  b.addEventListener("click", () => { days = Number(b.dataset.d); save(); document.querySelectorAll("#range button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); load(); });
});
$("test").checked = test;
$("test").addEventListener("change", (e) => { test = e.target.checked; save(); load(); });
$("pause").addEventListener("click", () => { paused = !paused; $("pause").textContent = paused ? "Resume" : "Pause"; $("pause").setAttribute("aria-pressed", String(paused)); schedule(); load(); });
$("ingest").addEventListener("click", async () => {
  const b = $("ingest"); b.disabled = true; b.textContent = "Syncing…";
  try { const r = await fetch("/admin/api/ingest", { method: "POST", credentials: "same-origin" }); const j = await r.json(); b.textContent = "Synced " + (j.processed || 0) + " batches"; }
  catch { b.textContent = "Sync failed"; }
  await load(); setTimeout(() => { b.disabled = false; b.textContent = "Sync telemetry"; }, 2500);
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && !paused) load(); });
load(); schedule();
})();`;
