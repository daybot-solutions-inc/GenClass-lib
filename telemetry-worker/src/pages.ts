// HTML for https://genclass.dev/start (get a token) and https://genclass.dev/dashboard/<secret> (the dashboard).
// No external scripts, styles or fonts. Inline <script>/<style> run under a per-response CSP nonce; all dynamic text is
// inserted with textContent, never innerHTML.

export const CDN_SCRIPT = "https://cdn.jsdelivr.net/npm/@genclass/runtime";

export function securityHeaders(nonce: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    "content-security-policy":
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; ` +
      "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ...extra,
  };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** JSON safe to embed in <script type="application/json">. */
const embed = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const ICON =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0E1F4D"/><path d="M9 21l5-10 4 7 2-3 3 6" fill="none" stroke="#14B86A" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>');

const CSS = `
:root{
  --paper:#fff;--panel:#F5F8FB;--ink:#0E1F4D;--ink2:#3D4B6B;--ink3:#5A6684;--rule:#DFE4EC;--rule2:#C6CEDB;
  --accent:#08794A;--accent-f:#14B86A;--accent-t:#DCF5E8;--warn:#C42A12;--warn-t:#FDE6E0;--bar:#0E1F4D;--bar2:#14B86A;--bar3:#F0451C;
  --code:#0B1736;--codeink:#E8EDF8;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){:root{
  --paper:#0B1736;--panel:#13224A;--ink:#E8EDF8;--ink2:#C3CCE2;--ink3:#97A3C2;--rule:#26355E;--rule2:#34467A;
  --accent:#4FD08F;--accent-f:#14B86A;--accent-t:#123A2C;--warn:#FF8A6B;--warn-t:#3A1C1A;--bar:#9DB2E8;--bar2:#3ED68A;--bar3:#FF7A55;
  --code:#060E24;--codeink:#E8EDF8;
}}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--paper);color:var(--ink);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit}
:focus-visible{outline:2px solid var(--accent-f);outline-offset:2px}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px}
header.top{border-bottom:1px solid var(--rule)}
header.top .wrap{display:flex;align-items:center;gap:12px;height:56px}
.logo{display:flex;align-items:center;gap:9px;font-weight:700;font-size:18px;letter-spacing:-.02em;text-decoration:none}
.logo img{width:26px;height:26px}
header.top nav{margin-left:auto;display:flex;gap:16px;font-size:14px;color:var(--ink2)}
header.top nav a{text-decoration:none}
h1{font-size:clamp(26px,4vw,40px);line-height:1.1;letter-spacing:-.03em;font-weight:750}
h2{font-size:17px;letter-spacing:-.01em;font-weight:700;margin-bottom:10px}
p.lead{color:var(--ink2);font-size:16px;max-width:62ch;margin-top:10px}
.muted{color:var(--ink3)}
.small{font-size:13px}
.mono{font-family:var(--mono)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:0 16px;border-radius:8px;font:600 14px/1 var(--sans);cursor:pointer;border:1px solid var(--ink);background:var(--ink);color:var(--paper);text-decoration:none;white-space:nowrap}
.btn:disabled{opacity:.6;cursor:progress}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--rule2)}
.btn.ghost:hover{border-color:var(--ink)}
.btn.sm{min-height:30px;padding:0 10px;font-size:13px}
input[type=text]{min-height:42px;padding:0 12px;border-radius:8px;border:1px solid var(--rule2);background:var(--paper);color:var(--ink);font:15px var(--sans);width:100%}
.card{background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:16px;min-width:0}
.grid{display:grid;gap:12px}
.kpis{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
.cols{grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.charts{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
@media (max-width:420px){.cols{grid-template-columns:1fr}}
.kpi .v{font-size:26px;font-weight:750;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi .l{font-size:13px;color:var(--ink2)}
.kpi .s{font-size:12px;color:var(--ink3);margin-top:2px}
pre.code{background:var(--code);color:var(--codeink);border-radius:10px;padding:12px 14px;font:13px/1.55 var(--mono);overflow-x:auto;white-space:pre}
.snip>*+*{margin-top:6px}
.snip .between{align-items:center}
.note{border-left:3px solid var(--warn);background:var(--warn-t);padding:10px 12px;border-radius:6px;font-size:14px}
.ok{border-left-color:var(--accent-f);background:var(--accent-t)}
.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--rule2);border-radius:999px;padding:3px 10px;font-size:13px;color:var(--ink2)}
.pill .dot{width:8px;height:8px;border-radius:50%;background:var(--ink3)}
.pill.live .dot{background:var(--accent-f)}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tabs{display:inline-flex;border:1px solid var(--rule2);border-radius:8px;overflow:hidden}
.tabs button{border:0;background:transparent;color:var(--ink2);padding:7px 12px;font:600 13px var(--sans);cursor:pointer}
.tabs button[aria-pressed=true]{background:var(--ink);color:var(--paper)}
.bars{list-style:none;display:grid;gap:6px}
.bars li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;font-size:13px}
.bars .k{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono)}
.bars .n{font-variant-numeric:tabular-nums;color:var(--ink2)}
.bars .track{grid-column:1/-1;height:6px;border-radius:3px;background:var(--rule)}
.bars .fill{height:6px;border-radius:3px;background:var(--bar)}
.empty{color:var(--ink3);font-size:13px}
.chart svg{width:100%;height:120px;display:block}
.chart .axis{font-size:11px;color:var(--ink3);display:flex;justify-content:space-between;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--rule);white-space:nowrap}
th{color:var(--ink3);font-weight:600}
td.mono{font-family:var(--mono)}
.tablewrap{overflow-x:auto}
section{margin-top:22px}
details summary{cursor:pointer;font-weight:700}
footer{margin:36px 0 28px;color:var(--ink3);font-size:13px}
.hidden{display:none!important}
.field{display:grid;gap:6px;max-width:520px}
.field label{font-size:14px;font-weight:600}
.stack>*+*{margin-top:12px}
.mt-xl{margin-top:44px}.mt-l{margin-top:28px}.mt-s{margin-top:12px}.big{font-size:16px}.brk{word-break:break-all}.h2l{font-size:20px}.between{justify-content:space-between;align-items:flex-end}.minw0{min-width:0}
`;

const SNIPPETS_JS = `
function snippets(tok){
  return [
    ["Easy: one script tag", "Paste into your HTML. GenClass starts itself and protects the whole app.",
     '<script src="${CDN_SCRIPT}" data-token="' + tok + '"></' + 'script>'],
    ["Easy: with a bundler", "A meta tag plus one import (npm i @genclass/runtime).",
     '<meta name="genclass" content="token=' + tok + '">\\n\\n// in your entry file\\nimport "@genclass/runtime/auto";'],
    ["Function-specific", "Protect only the functions you choose; the dashboard shows each by name.",
     'import { GenClass, protect } from "@genclass/runtime";\\n\\nGenClass.init({ token: "' + tok + '", scope: "functions" });\\nconst save = protect("saveCart", saveCartImpl);'],
    ["Automatic setup", "Run in your project folder: it detects your setup and wires GenClass (and a token) in for you.",
     'npx @genclass/runtime init']
  ];
}
function copyBtn(getText){
  var b = document.createElement("button"); b.type = "button"; b.className = "btn sm ghost"; b.textContent = "Copy";
  b.addEventListener("click", function(){
    var t = getText();
    var done = function(){ b.textContent = "Copied"; setTimeout(function(){ b.textContent = "Copy"; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, function(){ b.textContent = "Select and copy"; });
    else b.textContent = "Select and copy";
  });
  return b;
}
function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function renderSnippets(host, tok){
  host.textContent = "";
  snippets(tok).forEach(function(s){
    var box = el("div", "snip");
    var head = el("div", "row between"); var h = el("h2", null, s[0]); h.style.marginBottom = "0";
    head.appendChild(h); head.appendChild(copyBtn(function(){ return s[2]; })); box.appendChild(head);
    box.appendChild(el("p", "muted small", s[1])); box.appendChild(el("pre", "code", s[2]));
    host.appendChild(box);
  });
}
`;

function shell(nonce: string, title: string, body: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<link rel="icon" href="${ICON}">
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap"><a class="logo" href="https://genclass.dev/"><img src="${ICON}" alt="">GenClass</a>
<nav><a href="https://genclass.dev/">Home</a><a href="/start">Get a token</a><a href="https://github.com/genclass-dev/GenClass-lib#readme">Docs</a></nav></div></header>
<main class="wrap">${body}</main>
<script nonce="${nonce}">${SNIPPETS_JS}${script}</script>
</body>
</html>`;
}

// ------------------------------------------------------------------------------------------------- /start

export function startPage(nonce: string): string {
  const body = `
<section class="stack mt-xl">
  <h1>Get a token for your web app</h1>
  <p class="lead">One token per app. Add it to GenClass and every page load, detection and fix shows up on your own
  private dashboard. Free, no account.</p>
</section>
<section>
  <form id="f" class="card stack" novalidate>
    <div class="field"><label for="name">App name <span class="muted small">(optional, shown on your dashboard)</span></label>
    <input id="name" type="text" maxlength="80" autocomplete="off" placeholder="e.g. Acme checkout"></div>
    <div class="row"><button class="btn" id="go" type="submit">Get a token</button><span id="err" class="small" role="alert"></span></div>
  </form>
</section>
<section id="out" class="hidden stack" aria-live="polite">
  <div class="card stack">
    <h2>Your token</h2>
    <p class="muted small">Public: it goes in your app's code and only lets data be sent.</p>
    <div class="row"><code id="tok" class="mono big brk"></code><span id="tokc"></span></div>
  </div>
  <div class="card stack">
    <h2>Your private dashboard link</h2>
    <div class="note"><strong>Save this link now.</strong> It is the only way back to your dashboard; we cannot recover it.
    Anyone with the link can see your app's stats, so do not commit it to code.</div>
    <div class="row"><a id="dash" class="mono brk"></a><span id="dashc"></span></div>
    <div class="row"><a id="open" class="btn" href="#">Open dashboard</a></div>
  </div>
  <div class="card stack"><h2 class="h2l">Install</h2><div id="snips" class="stack"></div></div>
</section>
<footer>Dashboards show counts only (never the situation text) and keep data for 90 days.
See <a href="https://github.com/genclass-dev/GenClass-lib/blob/main/PRIVACY.md">privacy</a> and
<a href="https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md">what is sent</a>.</footer>`;
  const script = `
(function(){
  var f = document.getElementById("f"), go = document.getElementById("go"), err = document.getElementById("err");
  f.addEventListener("submit", function(ev){
    ev.preventDefault(); err.textContent = ""; go.disabled = true; go.textContent = "Creating...";
    fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: document.getElementById("name").value }) })
      .then(function(r){ return r.json().then(function(j){ return { s: r.status, j: j }; }); })
      .then(function(x){
        if (x.s !== 201) throw new Error(x.s === 429 ? "Too many new tokens from your network. Try again in a minute." : (x.j && x.j.error) || "Something went wrong.");
        var j = x.j;
        document.getElementById("tok").textContent = j.token;
        document.getElementById("tokc").appendChild(copyBtn(function(){ return j.token; }));
        var d = document.getElementById("dash"); d.textContent = j.dashboardUrl; d.href = j.dashboardUrl;
        document.getElementById("dashc").appendChild(copyBtn(function(){ return j.dashboardUrl; }));
        document.getElementById("open").href = j.dashboardUrl;
        renderSnippets(document.getElementById("snips"), j.token);
        f.classList.add("hidden");
        var out = document.getElementById("out"); out.classList.remove("hidden"); out.scrollIntoView({ behavior: "smooth" });
      })
      .catch(function(e){ err.textContent = e.message || String(e); go.disabled = false; go.textContent = "Get a token"; });
  });
})();`;
  return shell(nonce, "Get a token | GenClass", body, script);
}

// ------------------------------------------------------------------------------------------------- 404

export function notFoundPage(nonce: string): string {
  return shell(
    nonce,
    "Dashboard not found | GenClass",
    `<section class="stack mt-xl"><h1>Dashboard not found</h1>
<p class="lead">This link does not match any GenClass dashboard. Check that you copied the whole link, or
<a href="/start">get a new token</a>.</p></section>`,
    "",
  );
}

// ------------------------------------------------------------------------------------------------- dashboard

export function dashboardPage(nonce: string, project: { name: string; token: string; created: string; lastEvent: string | null }): string {
  const body = `
<script type="application/json" id="project">${embed(project)}</script>
<section class="stack mt-l">
  <div class="row between">
    <div class="stack minw0">
      <h1 id="pname"></h1>
      <div class="row small"><span class="muted">Token</span><code id="ptok" class="mono brk"></code><span id="ptokc"></span>
      <span class="pill" id="status"><span class="dot"></span><span id="statust">Loading...</span></span></div>
    </div>
    <div class="row">
      <div class="tabs" role="group" aria-label="Time range">
        <button type="button" data-r="24h" aria-pressed="false">24 h</button><button type="button" data-r="7d" aria-pressed="true">7 d</button><button type="button" data-r="30d" aria-pressed="false">30 d</button>
      </div>
      <button class="btn ghost sm" id="refresh" type="button">Refresh</button>
    </div>
  </div>
  <p class="muted small" id="updated"></p>
</section>
<section id="nodata" class="hidden"><div class="note ok">No data yet. Add the token to your app (below), load a page, and
refresh in a minute. Events arrive in batches every 10 seconds and when a tab is hidden.</div></section>
<section><div class="grid kpis" id="kpis"></div></section>
<section><div class="grid charts" id="charts"></div></section>
<section><div class="grid cols" id="cards"></div></section>
<section class="card">
  <h2>Recent detections and interventions</h2>
  <div class="tablewrap"><table><thead><tr><th>Time</th><th>Route / function</th><th>Trigger</th><th>Diagnosis</th><th>Action</th><th>Confidence</th><th>Mode</th><th>Executed</th></tr></thead>
  <tbody id="recent"></tbody></table></div>
  <p class="empty hidden" id="recent0">Nothing detected in this period.</p>
</section>
<section class="card"><details id="install"><summary>Install snippets</summary><div id="snips" class="stack mt-s"></div></details></section>
<footer>Counts only; GenClass never shows or stores the situation text here. Data is kept 90 days (hourly detail 48 hours).
Keep this link private: anyone with it can see these stats. <a href="/start">Get another token</a>.</footer>`;
  const script = `
(function(){
  var P = JSON.parse(document.getElementById("project").textContent);
  var secret = location.pathname.split("/").filter(Boolean)[1] || "";
  var range = "7d";
  try { var saved = localStorage.getItem("gc.dash.range"); if (saved === "24h" || saved === "7d" || saved === "30d") range = saved; } catch (e) {}
  document.getElementById("pname").textContent = P.name;
  document.title = P.name + " | GenClass dashboard";
  document.getElementById("ptok").textContent = P.token;
  document.getElementById("ptokc").appendChild(copyBtn(function(){ return P.token; }));
  renderSnippets(document.getElementById("snips"), P.token);
  var nf = new Intl.NumberFormat();
  function fmt(n){ return nf.format(Math.round(n || 0)); }
  function ago(iso){
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 90) return Math.round(s) + " s ago"; if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 129600) return Math.round(s / 3600) + " h ago"; return Math.round(s / 86400) + " days ago";
  }
  function kpi(label, value, sub){
    var c = el("div", "card kpi"); c.appendChild(el("div", "l", label)); c.appendChild(el("div", "v", value));
    if (sub) c.appendChild(el("div", "s", sub)); return c;
  }
  function bars(title, list, opts){
    opts = opts || {};
    var c = el("div", "card"); c.appendChild(el("h2", null, title));
    if (opts.note) { var n = el("p", "muted small", opts.note); n.style.marginTop = "-6px"; n.style.marginBottom = "8px"; c.appendChild(n); }
    if (!list || !list.length) { c.appendChild(el("p", "empty", "None in this period.")); return c; }
    var max = Math.max.apply(null, list.map(function(x){ return x.count; })) || 1;
    var ul = el("ul", "bars");
    list.slice(0, opts.limit || 10).forEach(function(x){
      var li = el("li"); var k = el("span", "k", x.key); k.title = x.key; li.appendChild(k);
      li.appendChild(el("span", "n", fmt(x.count) + (x.extra ? " " + x.extra : "")));
      var tr = el("span", "track"); var fi = el("span", "fill"); fi.style.display = "block"; fi.style.width = Math.max(2, 100 * x.count / max) + "%";
      if (opts.color) fi.style.background = opts.color; tr.appendChild(fi); li.appendChild(tr); ul.appendChild(li);
    });
    c.appendChild(ul); return c;
  }
  var SVGNS = "http://www.w3.org/2000/svg";
  function chart(title, series, field, color, hourly){
    var c = el("div", "card chart"); var total = series.reduce(function(s, x){ return s + x[field]; }, 0);
    var h = el("h2", null, title + " "); h.appendChild(el("span", "muted small", fmt(total) + " total")); c.appendChild(h);
    var W = 600, H = 120, n = series.length, gap = n > 20 ? 2 : 4, bw = (W - gap * (n - 1)) / n;
    var max = Math.max.apply(null, series.map(function(x){ return x[field]; })) || 1;
    var svg = document.createElementNS(SVGNS, "svg"); svg.setAttribute("viewBox", "0 0 " + W + " " + H); svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img"); svg.setAttribute("aria-label", title + " per " + (hourly ? "hour" : "day"));
    var base = document.createElementNS(SVGNS, "rect"); base.setAttribute("x", 0); base.setAttribute("y", H - 1); base.setAttribute("width", W); base.setAttribute("height", 1);
    base.setAttribute("fill", "currentColor"); base.setAttribute("opacity", ".2"); svg.appendChild(base);
    series.forEach(function(x, i){
      var v = x[field], bh = v ? Math.max(2, (H - 6) * v / max) : 0;
      var r = document.createElementNS(SVGNS, "rect");
      r.setAttribute("x", i * (bw + gap)); r.setAttribute("y", H - bh); r.setAttribute("width", Math.max(1, bw)); r.setAttribute("height", bh); r.setAttribute("rx", 2);
      r.setAttribute("fill", color);
      var t = document.createElementNS(SVGNS, "title"); t.textContent = label(x.bucket, hourly) + ": " + fmt(v); r.appendChild(t); svg.appendChild(r);
    });
    c.appendChild(svg);
    var ax = el("div", "axis"); ax.appendChild(el("span", null, label(series[0].bucket, hourly))); ax.appendChild(el("span", null, label(series[n - 1].bucket, hourly)));
    c.appendChild(ax); return c;
  }
  function label(b, hourly){
    var d = new Date(hourly ? b + ":00:00Z" : b + "T00:00:00Z");
    return hourly ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
  }
  function css(name){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function render(S){
    var T = S.totals, B = S.breakdowns;
    var live = !!S.lastEvent;
    var st = document.getElementById("status"); st.classList.toggle("live", live);
    document.getElementById("statust").textContent = live ? "Last event " + ago(S.lastEvent) : "No data yet";
    document.getElementById("nodata").classList.toggle("hidden", live);
    var inst = document.getElementById("install"); if (!live) inst.open = true;
    document.getElementById("updated").textContent = "Updated " + new Date(S.generated).toLocaleTimeString() + ". Times in your timezone; days are UTC.";
    var modelErr = Math.max(T.modelErrors || 0, (B.model_error_events || []).reduce(function(s, x){ return s + x.count; }, 0));
    var k = document.getElementById("kpis"); k.textContent = "";
    k.appendChild(kpi("Page loads", fmt(T.sessions)));
    k.appendChild(kpi("Decisions", fmt(T.decisions), T.sessions ? (T.decisions / T.sessions).toFixed(1) + " per page load" : ""));
    k.appendChild(kpi("Detections", fmt(T.detections)));
    k.appendChild(kpi("Interventions", fmt(T.interventions), fmt(T.acted) + " decisions acted"));
    k.appendChild(kpi("Model latency", T.latency_ms_n ? fmt(T.latencyAvgMs) + " ms" : "-", T.latency_ms_n ? "average of " + fmt(T.latency_ms_n) : ""));
    k.appendChild(kpi("Model loads", fmt(T.model_ready), (T.model_load_failed ? fmt(T.model_load_failed) + " failed" : "0 failed") + (T.model_load_ms_n ? ", avg " + fmt(T.modelLoadAvgMs) + " ms" : "")));
    k.appendChild(kpi("Model errors", fmt(modelErr)));
    k.appendChild(kpi("Fail-opens", fmt(T.failOpens), "app ran unprotected"));
    var hourly = S.range === "24h";
    var ch = document.getElementById("charts"); ch.textContent = "";
    ch.appendChild(chart("Page loads", S.series, "sessions", css("--bar"), hourly));
    ch.appendChild(chart("Decisions", S.series, "decisions", css("--bar2"), hourly));
    ch.appendChild(chart("Detections", S.series, "detections", css("--bar3"), hourly));
    var fnDetect = {}, fnActed = {};
    (B.fn_detect || []).forEach(function(x){ fnDetect[x.key] = x.count; });
    (B.fn_acted || []).forEach(function(x){ fnActed[x.key] = x.count; });
    var fns = (B.fn || []).map(function(x){ return { key: x.key, count: x.count, extra: "(" + fmt(fnDetect[x.key]) + " det, " + fmt(fnActed[x.key]) + " fixed)" }; });
    var cards = document.getElementById("cards"); cards.textContent = "";
    var warn = css("--bar3"), ok = css("--bar2");
    [
      bars("Detections by diagnosis", B.detect_diagnosis, { color: warn }),
      bars("Interventions (actions applied)", B.intervention, { color: ok }),
      bars("Action outcomes", B.action_outcome),
      bars("Top protected functions", fns, { note: "Decisions per protect() name (detections, fixes)." }),
      bars("Top routes (decisions)", B.route),
      bars("Top pages (page loads)", B.page_route),
      bars("Triggers", B.trigger),
      bars("Diagnoses (all decisions)", B.diagnosis),
      bars("Model backend", B.backend, { note: "Where the model ran when it loaded." }),
      bars("Model load states", B.model_state),
      bars("Model latency", B.latency_bucket, { limit: 12 }),
      bars("Model errors", (B.model_errors && B.model_errors.length) ? B.model_errors : B.model_error_events, { color: warn }),
      bars("Fail-opens (reason:trigger)", B.fail_open, { color: warn }),
      bars("Modes", B.mode),
      bars("Runtime versions", B.runtime),
      bars("Model versions", B.model_version),
      bars("Hosts seen", B.host, { note: "Every hostname that sent data with this token. Unknown hosts may mean someone copied your token." })
    ].forEach(function(c){ cards.appendChild(c); });
    var tb = document.getElementById("recent"); tb.textContent = "";
    (S.recent || []).forEach(function(r){
      var tr = el("tr");
      var t = el("td", null, new Date(r.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })); t.title = r.t; tr.appendChild(t);
      tr.appendChild(el("td", "mono", [r.route, r.fn ? "fn " + r.fn : null].filter(Boolean).join("  ") || "-"));
      tr.appendChild(el("td", null, r.trigger || "-"));
      tr.appendChild(el("td", null, r.diagnosis || "-"));
      tr.appendChild(el("td", "mono", r.ran && r.action && r.ran !== r.action ? r.action + " (ran " + r.ran + ")" : (r.ran || r.action || "-")));
      tr.appendChild(el("td", null, typeof r.confidence === "number" ? Math.round(r.confidence * 100) + "%" : "-"));
      tr.appendChild(el("td", null, r.mode || "-"));
      tr.appendChild(el("td", null, r.executed == null ? "-" : r.executed ? "yes" : "no"));
      tb.appendChild(tr);
    });
    document.getElementById("recent0").classList.toggle("hidden", (S.recent || []).length > 0);
  }
  var btn = document.getElementById("refresh");
  function load(){
    btn.disabled = true;
    fetch("/api/projects/" + encodeURIComponent(secret) + "?range=" + range, { headers: { accept: "application/json" }, cache: "no-store" })
      .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(render)
      .catch(function(e){ document.getElementById("updated").textContent = "Could not load stats (" + e.message + "). Retrying shortly."; })
      .then(function(){ btn.disabled = false; });
  }
  document.querySelectorAll(".tabs button").forEach(function(b){
    b.setAttribute("aria-pressed", String(b.getAttribute("data-r") === range));
    b.addEventListener("click", function(){
      range = b.getAttribute("data-r");
      try { localStorage.setItem("gc.dash.range", range); } catch (e) {}
      document.querySelectorAll(".tabs button").forEach(function(o){ o.setAttribute("aria-pressed", String(o === b)); });
      load();
    });
  });
  btn.addEventListener("click", load);
  setInterval(function(){ if (document.visibilityState === "visible") load(); }, 60000);
  load();
})();`;
  return shell(nonce, `${project.name} | GenClass dashboard`, body, script);
}
