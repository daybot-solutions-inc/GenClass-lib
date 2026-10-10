#!/usr/bin/env python3
"""Builds genclass.dev: src/pages/*.html (meta header + body) -> public/<slug>.html, plus sitemap, styles."""
import json, math, re, hashlib, pathlib, datetime

ROOT = pathlib.Path(__file__).parent
SRC, PUB = ROOT / "src", ROOT / "public"
SITE = "https://genclass.dev"
TODAY = datetime.date.today().isoformat()
GH = "https://github.com/daybot-solutions-inc/GenClass-lib"
NPM = "https://www.npmjs.com/package/@genclass/runtime"

css = (SRC / "css/base.css").read_text() + "\n" + (SRC / "css/components.css").read_text()
(PUB / "styles.css").write_text(css)
CSSV = hashlib.sha1(css.encode()).hexdigest()[:8]
JSV = hashlib.sha1((PUB / "app.js").read_bytes()).hexdigest()[:8]

NAV = [("Cloud", "/cloud", "cloud"), ("Enterprise", "/enterprise", "enterprise"), ("Pricing", "/pricing", "pricing"),
       ("Docs", "/docs", "docs"), ("Benchmarks", "/benchmarks", "benchmarks"), ("Guides", "/guides", "guides")]

def nav(active):
    links = "".join(f'<a href="{h}"{" class=\"on\" aria-current=\"page\"" if k == active else ""}>{t}</a>' for t, h, k in NAV)
    mlinks = "".join(f'<a href="{h}">{t}</a>' for t, h, k in NAV) + f'<a href="{GH}">GitHub</a><a href="/docs">Get started</a>'
    return f'''<header class="nav">
  <div class="wrap">
    <a class="logo" href="/" aria-label="GenClass home"><img class="lk" src="/brand/lockup-h.png?v=1" alt="genclass" width="144" height="32"></a>
    <nav aria-label="Main">{links}</nav>
    <a class="gh" href="{GH}">GitHub</a>
    <details class="mnav"><summary aria-label="Open menu">Menu</summary><div class="panel">{mlinks}</div></details>
    <a class="btn" href="/docs">Get started</a>
  </div>
</header>'''

FOOTER = f'''<footer class="end">
  <div class="wrap">
    <img class="lockup" src="/brand/lockup-stack.png?v=1" alt="genclass: AI runtime, self healing" width="220" height="183" loading="lazy">
    <h2>Free to run. Built to scale.</h2>
    <div class="row">
      <button class="cmd" type="button" data-copy="npm install @genclass/runtime" aria-label="Copy the install command"><span><span class="p">$</span> npm i @genclass/runtime</span><span class="k">Copy</span></button>
      <a class="btn green" href="/cloud#early-access">Join Cloud early access</a>
    </div>
    <div class="foot-cols">
      <div><b>Product</b><a href="/">Runtime</a><a href="/cloud">GenClass Cloud</a><a href="/enterprise">Enterprise</a><a href="/pricing">Pricing</a></div>
      <div><b>Developers</b><a href="/docs">Docs</a><a href="/docs/api">API reference</a><a href="/docs/options">Options</a><a href="/how-it-works">How it works</a><a href="/benchmarks">Benchmarks</a><a href="{GH}">GitHub</a><a href="{NPM}">npm</a></div>
      <div><b>Guides</b><a href="/guides/race-conditions-react">Race conditions in React</a><a href="/guides/prevent-duplicate-submissions">Duplicate submissions</a><a href="/guides/stale-responses-out-of-order">Out-of-order responses</a></div>
      <div><b>Company</b><a href="/privacy">Privacy</a><a href="{GH}/blob/main/LICENSE">License (Apache-2.0)</a><a href="{GH}/blob/main/packages/runtime-model/MODEL_CARD.md">Model card</a></div>
    </div>
    <div class="foot">
      <span>© 2026 Daybot Solutions Inc. GenClass runtime is open source under Apache-2.0.</span>
    </div>
  </div>
</footer>'''

ORG = {"@type": "Organization", "@id": f"{SITE}/#org", "name": "GenClass", "url": f"{SITE}/",
       "logo": f"{SITE}/icon-512.png", "sameAs": [GH, NPM]}
WEBSITE = {"@type": "WebSite", "@id": f"{SITE}/#site", "url": f"{SITE}/", "name": "GenClass", "publisher": {"@id": f"{SITE}/#org"}}

def page(meta, body):
    path = meta["path"]; url = SITE + (path if path != "/" else "/")
    title, desc = meta["title"], meta["description"]
    graph = [ORG, WEBSITE]
    crumbs = meta.get("crumbs")
    if crumbs:
        items = [{"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE}/"}]
        items += [{"@type": "ListItem", "position": i + 2, "name": n, "item": SITE + h} for i, (n, h) in enumerate(crumbs)]
        graph.append({"@type": "BreadcrumbList", "itemListElement": items})
        trail = '<a href="/">Home</a>' + "".join(f'<span aria-hidden="true">/</span>{"<a href=" + chr(34) + h + chr(34) + ">" + n + "</a>" if i < len(crumbs) - 1 else "<span>" + n + "</span>"}' for i, (n, h) in enumerate(crumbs))
        body = body.replace("<!--@crumbs-->", f'<nav class="crumbs" aria-label="Breadcrumb">{trail}</nav>')
    graph += meta.get("jsonld", [])
    robots = "noindex, follow" if meta.get("noindex") else "index, follow, max-image-preview:large, max-snippet:-1"
    og_type = meta.get("og_type", "website")
    extra = ""
    if og_type == "article":
        extra = f'<meta property="article:published_time" content="{meta.get("published", TODAY)}">\n<meta property="article:modified_time" content="{TODAY}">\n'
    head = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{url}">
<meta name="robots" content="{robots}">
<meta name="theme-color" content="#FFFFFF">
<meta name="author" content="GenClass">
<meta property="og:type" content="{og_type}">
<meta property="og:site_name" content="GenClass">
<meta property="og:url" content="{url}">
<meta property="og:title" content="{meta.get("og_title", title)}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{SITE}/og.png?v=4">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="GenClass: the self-healing runtime for web apps">
<meta property="og:locale" content="en_US">
{extra}<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{meta.get("og_title", title)}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{SITE}/og.png?v=4">
<link rel="icon" href="/brand/mark-32.png?v=2" sizes="32x32" type="image/png">
<link rel="icon" href="/brand/mark-64.png?v=2" sizes="64x64" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="sitemap" type="application/xml" href="/sitemap.xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700;800&amp;family=Figtree:wght@400;500;600&amp;family=Geist+Mono:wght@400;500&amp;display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css?v={CSSV}">
<script type="application/ld+json">{json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False)}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
'''
    return head + nav(meta.get("nav")) + f'\n<main id="main">\n{body}\n</main>\n' + FOOTER + f'\n<script src="/app.js?v={JSV}" defer></script>\n</body>\n</html>\n'

# ---------- shared blocks ----------
def bars():
    raw = [80 + 40 * math.sin(i * .55) + 25 * math.sin(i * 1.7 + 1) + i * 1.6 for i in range(30)]
    s = sum(raw); vals = [round(v / s * 3291) for v in raw]; vals[-1] += 3291 - sum(vals)
    top = max(vals)
    return "".join(f'<i style="height: {v / top * 100:.1f}%" title="{v}"></i>' for v in vals)

ICONS = {
 "overview": '<path d="M3 13h4v7H3zM10 4h4v16h-4zM17 9h4v11h-4z"/>',
 "interventions": '<path d="M12 3l8 4v5c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V7z"/><path d="M8.5 12l2.4 2.4L15.5 10"/>',
 "releases": '<path d="M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9c0 6-12 3-12 6"/>',
 "alerts": '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
 "policies": '<path d="M4 6h16M4 12h10M4 18h6"/><circle cx="18" cy="15" r="3"/>',
 "settings": '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
}

def dashboard():
    side = "".join(f'<button type="button" data-view="{k}" aria-current="{"true" if k == "overview" else "false"}"><svg viewBox="0 0 24 24" aria-hidden="true">{p}</svg>{k.capitalize()}</button>' for k, p in ICONS.items())
    return f'''<div class="app" data-app>
  <div class="app-top"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="url">app.genclass.dev / acme / storefront-web</span><span class="badge n sample">Preview · sample data</span></div>
  <div class="app-body">
    <div class="app-side" role="tablist" aria-label="GenClass Cloud sections">
      <div class="proj"><img src="/brand/mark-64.png?v=2" alt="" width="26" height="26"><div><b>storefront-web</b><span>production</span></div></div>
      {side}
    </div>
    <div class="app-main">
      <div class="view" data-panel="overview">
        <div class="app-head"><h3>Reliability overview</h3><div class="ctl"><span class="sel">Production</span><span class="sel">Last 30 days</span></div></div>
        <div class="kpis">
          <div class="kpi"><div class="k">Anomalies detected</div><div class="v">12,847</div><div class="d mut">across 1.9M sessions</div></div>
          <div class="kpi"><div class="k">Interventions applied</div><div class="v">3,291</div><div class="d up">stale writes, duplicates, retries</div></div>
          <div class="kpi"><div class="k">Undone by users</div><div class="v">14</div><div class="d up">0.43% of interventions</div></div>
          <div class="kpi"><div class="k">P95 inference</div><div class="v">82 ms</div><div class="d mut">on-device, WebGPU + WASM</div></div>
        </div>
        <div class="panels">
          <div class="pnl"><h4>Interventions per day <span>30 days</span></h4><div class="spark" aria-hidden="true">{bars()}</div><div class="axisx"><span>Sep 10</span><span>Sep 25</span><span>Oct 9</span></div></div>
          <div class="pnl"><h4>By category <span>3,291 total</span></h4><div class="cat">
            <div><div class="r"><span>Stale writes prevented</span><b>1,420</b></div><div class="t"><i style="width: 100%"></i></div></div>
            <div><div class="r"><span>Duplicate requests merged</span><b>1,030</b></div><div class="t"><i style="width: 72.5%"></i></div></div>
            <div><div class="r"><span>Retries and recovery</span><b>841</b></div><div class="t"><i style="width: 59.2%"></i></div></div>
          </div></div>
        </div>
        <div class="pnl" style="margin-top: 10px"><h4>Live events <span>streaming</span></h4><div class="feed">
          <div class="ev"><span class="tm">12:04:11</span><span class="badge">stale · discard</span><span class="msg">GET /api/search?q=pa landed after q=paris was shown</span><span class="mut" style="font-size: 12px">/search</span></div>
          <div class="ev"><span class="tm">12:03:57</span><span class="badge">duplicate · coalesce</span><span class="msg">POST /api/orders repeated 140 ms after #212; one order placed</span><span class="mut" style="font-size: 12px">/checkout</span></div>
          <div class="ev"><span class="tm">12:03:40</span><span class="badge o">failing · observed</span><span class="msg">GET /api/inventory failed 5 times in 8 s</span><span class="mut" style="font-size: 12px">/product</span></div>
          <div class="ev"><span class="tm">12:02:18</span><span class="badge n">transient · retry</span><span class="msg">PUT /api/cart/42 retried once with its idempotency key</span><span class="mut" style="font-size: 12px">/cart</span></div>
        </div></div>
      </div>
      <div class="view" data-panel="interventions" hidden>
        <div class="app-head"><h3>Interventions</h3><div class="ctl"><span class="sel">All categories</span><span class="sel">Last 24 hours</span></div></div>
        <div class="tbl-wrap" style="margin-top: 14px"><table class="rel">
          <thead><tr><th>Time</th><th>Diagnosis</th><th>Action</th><th>Endpoint</th><th>Confidence</th><th>Undo</th></tr></thead>
          <tbody>
            <tr><td>12:04:11</td><td>stale</td><td><span class="badge">discard</span></td><td>GET /api/search</td><td>0.98</td><td class="mut">available</td></tr>
            <tr><td>12:03:57</td><td>duplicate</td><td><span class="badge">coalesce</span></td><td>POST /api/orders</td><td>0.96</td><td class="mut">n/a</td></tr>
            <tr><td>12:02:18</td><td>transient</td><td><span class="badge n">retry</span></td><td>PUT /api/cart/42</td><td>0.93</td><td class="mut">n/a</td></tr>
            <tr><td>11:58:02</td><td>conflict</td><td><span class="badge">discard</span></td><td>GET /api/board</td><td>0.97</td><td class="mut">available</td></tr>
            <tr><td>11:51:44</td><td>stale</td><td><span class="badge">defer</span></td><td>GET /api/profile</td><td>0.94</td><td class="mut">n/a</td></tr>
          </tbody></table></div>
      </div>
      <div class="view" data-panel="releases" hidden>
        <div class="app-head"><h3>Release comparison</h3><div class="ctl"><span class="sel">v2.14.0 vs v2.13.2</span></div></div>
        <div class="tbl-wrap" style="margin-top: 14px"><table class="rel">
          <thead><tr><th>Per 10k sessions</th><th>v2.13.2</th><th>v2.14.0</th><th>Change</th></tr></thead>
          <tbody>
            <tr><td>Stale overwrites detected</td><td>41.2</td><td>18.6</td><td class="up">−55%</td></tr>
            <tr><td>Duplicate submits</td><td>9.8</td><td>9.1</td><td class="up">−7%</td></tr>
            <tr><td>Failing-request storms</td><td>2.1</td><td>3.4</td><td class="dn">+62%</td></tr>
            <tr><td>Interventions applied</td><td>17.0</td><td>15.3</td><td class="mut">−10%</td></tr>
          </tbody></table></div>
        <div class="pnl" style="margin-top: 12px"><h4>Guard-mode rollout <span>v2.14.0</span></h4><p style="font-size: 14px; color: var(--ink2); margin-top: 8px">Guard runs on 25% of sessions; the rest observe. Promote when interventions undone stay under 1%.</p></div>
      </div>
      <div class="view" data-panel="alerts" hidden>
        <div class="app-head"><h3>Alerts</h3><div class="ctl"><span class="sel">Slack · #web-reliability</span></div></div>
        <div class="feed" style="margin-top: 10px">
          <div class="ev"><span class="tm">rule</span><span class="toggle"><i></i>on</span><span class="msg">Failure storm on any /api/checkout route</span><span class="mut" style="font-size: 12px">page</span></div>
          <div class="ev"><span class="tm">rule</span><span class="toggle"><i></i>on</span><span class="msg">Interventions undone above 1% in an hour</span><span class="mut" style="font-size: 12px">email</span></div>
          <div class="ev"><span class="tm">rule</span><span class="toggle"><i></i>on</span><span class="msg">New release raises stale overwrites by 20%</span><span class="mut" style="font-size: 12px">slack</span></div>
          <div class="ev"><span class="tm">rule</span><span class="toggle off"><i></i>off</span><span class="msg">P95 inference above 150 ms</span><span class="mut" style="font-size: 12px">slack</span></div>
        </div>
      </div>
      <div class="view" data-panel="policies" hidden>
        <div class="app-head"><h3>Policies</h3><div class="ctl"><span class="sel">Profile: balanced</span></div></div>
        <div class="tbl-wrap" style="margin-top: 14px"><table class="rel">
          <thead><tr><th>Route</th><th>Mode</th><th>Protected endpoints</th><th>Sessions</th></tr></thead>
          <tbody>
            <tr><td>/search</td><td><span class="badge">guard</span></td><td class="mut">none</td><td>100%</td></tr>
            <tr><td>/checkout</td><td><span class="badge">guard</span></td><td>POST /api/payments</td><td>25%</td></tr>
            <tr><td>/account</td><td><span class="badge n">observe</span></td><td>all</td><td>100%</td></tr>
            <tr><td>/admin</td><td><span class="badge o">off</span></td><td>n/a</td><td>0%</td></tr>
          </tbody></table></div>
      </div>
      <div class="view" data-panel="settings" hidden>
        <div class="app-head"><h3>Connect your app</h3></div>
        <p style="font-size: 14.5px; color: var(--ink2); margin-top: 10px">Paste the publishable project key. It can only send aggregate metrics, and the runtime keeps protecting your app if the cloud is unreachable.</p>
        <div class="console" style="margin-top: 12px"><div class="d">// early access: proposed API</div><div>GenClass.init({{ cloud: {{ projectKey: <span class="b">"gc_pub_7Hq2…"</span> }} }});</div></div>
      </div>
    </div>
  </div>
  <p class="app-note">Product preview with sample data. GenClass Cloud is in early access; figures here illustrate the dashboard and are not customer results.</p>
</div>'''

def waitlist(plan, heading, text):
    opts = "".join(f'<option value="{v}"{" selected" if v == plan else ""}>{l}</option>' for v, l in [("cloud", "GenClass Cloud (Teams)"), ("enterprise", "GenClass Enterprise"), ("community", "Community updates")])
    return f'''<div class="formcard" id="early-access">
  <div><h2>{heading}</h2><p>{text}</p><p style="font-size: 14px">The open-source runtime needs no account. This list is only for the paid products and is never shared.</p></div>
  <form class="wl" method="post" action="/forms/waitlist" data-waitlist>
    <label>Work email<input type="email" name="email" required autocomplete="email" placeholder="you@company.com"></label>
    <div class="row2"><label>Company<input type="text" name="company" autocomplete="organization"></label>
    <label>Production apps<select name="apps"><option value="1">1</option><option value="2-5">2 to 5</option><option value="6-20">6 to 20</option><option value="21+">21 or more</option></select></label></div>
    <label>Interested in<select name="plan">{opts}</select></label>
    <label class="hp" aria-hidden="true">Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
    <button class="btn green" type="submit">Request early access</button>
    <div class="msg" role="status" aria-live="polite"></div>
    <small>By submitting you agree to be contacted about GenClass. See <a href="/privacy">privacy</a>.</small>
  </form>
</div>'''

def blocks(s):
    s = s.replace("<!--@dashboard-->", dashboard())
    s = re.sub(r'<!--@waitlist (\w+) "([^"]*)" "([^"]*)"-->', lambda m: waitlist(m.group(1), m.group(2), m.group(3)), s)
    for name in ("trace", "demo", "figs", "data", "status", "how"):
        p = SRC / "partials" / f"{name}.html"
        if p.exists(): s = s.replace(f"<!--@{name}-->", p.read_text())
    return s

# ---------- build ----------
urls = []
for f in sorted((SRC / "pages").glob("**/*.html")):
    txt = f.read_text()
    m = re.match(r"<!--meta\s*(\{.*?\})\s*-->\n", txt, re.S)
    meta = json.loads(m.group(1)); body = blocks(txt[m.end():])
    out = PUB / ("index.html" if meta["path"] == "/" else meta["path"].strip("/") + ".html")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page(meta, body))
    if not meta.get("noindex"): urls.append((meta["path"], meta.get("priority", "0.7")))

# ---------- reference docs rendered from the repo's markdown (source of truth stays in the repo) ----------
REPO = ROOT.parent
MD_DOCS = [
    ("docs/runtime/API.md", "/docs/api", "API Reference", "GenClass Runtime API Reference",
     "Complete API reference for @genclass/runtime: init and modes, options, state, operations, asking the model, events, policy, explain, undo, plugins and adapters."),
    ("docs/runtime/OPTIONS-SPEC.md", "/docs/options", "Options Reference", "GenClass Options Reference",
     "Every GenClass init option: activation, route scopes, protected endpoints, breaker, shadow mode, veto, action limits, hold budgets and sinks."),
    ("docs/runtime/ARCHITECTURE.md", "/docs/architecture", "Architecture", "GenClass Runtime Architecture",
     "How the GenClass runtime is built: observers, causality, stores, facts, triage, the policy gate, actions and the on-device model host."),
    ("packages/runtime/TELEMETRY.md", "/docs/telemetry", "Telemetry", "GenClass Telemetry and Privacy",
     "What anonymous diagnostics the GenClass runtime sends during the beta, what it never sends, and every way to turn it off."),
    ("packages/runtime/INTERCEPTION.md", "/docs/interception", "Interception surface", "GenClass Interception Surface",
     "Every browser API GenClass wraps or observes, what each mode may change, what it never does, and how it restores the originals."),
    ("docs/runtime/THREAT-MODEL.md", "/docs/threat-model", "Threat model", "GenClass Threat Model",
     "The GenClass security threat model: model supply chain, crafted responses, page scripts, telemetry and denial of service, with mitigations."),
    ("SECURITY.md", "/security", "Security", "GenClass Security Policy",
     "How to report a vulnerability in GenClass, supported versions and the security design of the runtime."),
    ("bench/perf/RESULTS.md", "/benchmarks/performance", "Performance", "GenClass Browser Performance Benchmarks",
     "Reproducible browser performance results for GenClass: bytes, model load, inference latency, main-thread cost, memory and emulated mobile."),
    ("compat/RESULTS.md", "/docs/compatibility", "Compatibility", "GenClass Framework Compatibility Matrix",
     "GenClass tested across React, Next.js, Vue, SvelteKit, Angular and Solid with TanStack Query, SWR, Redux, Zustand, Apollo and more."),
]
try:
    import markdown as _md
except ImportError:
    raise SystemExit("build.py needs the 'markdown' package for the reference docs (pip install markdown==3.7)")

def gh_link(src_dir, target):
    if re.match(r"^(https?:|mailto:|#)", target): return target
    path, _, frag = target.partition("#")
    full = (pathlib.PurePosixPath(src_dir) / path).as_posix()
    parts = []
    for seg in full.split("/"):
        if seg == "..": parts and parts.pop()
        elif seg not in (".", ""): parts.append(seg)
    full = "/".join(parts)
    for s_, p_, *_ in MD_DOCS:
        if full == s_ and (REPO / s_).exists(): return p_ + (("#" + frag) if frag else "")
    return f"{GH}/blob/main/{full}" + (("#" + frag) if frag else "")

doc_links = [(p_, nav_t) for s_, p_, nav_t, *_ in MD_DOCS if (REPO / s_).exists()]
for src, path, nav_t, title, desc in MD_DOCS:
    f = REPO / src
    if not f.exists() or _md is None: continue
    text = f.read_text()
    h1 = re.search(r"^# (.+)$", text, re.M)
    heading = h1.group(1).strip() if h1 else nav_t
    if h1: text = text[:h1.start()] + text[h1.end():]
    src_dir = str(pathlib.PurePosixPath(src).parent)
    text = re.sub(r"\]\(([^)\s]+)\)", lambda m: "](" + gh_link(src_dir, m.group(1)) + ")", text)
    md = _md.Markdown(extensions=["tables", "fenced_code", "toc", "sane_lists"], extension_configs={"toc": {"toc_depth": "2"}})
    html_body = md.convert(text)
    toc = "".join(f'<a href="#{t["id"]}">{t["name"]}</a>' for t in md.toc_tokens[:24] if t["level"] <= 2) if hasattr(md, "toc_tokens") else ""
    if not toc:
        toc = "".join(f'<a href="#{i}">{n}</a>' for i, n in re.findall(r'<h2 id="([^"]+)">(.*?)</h2>', html_body))
    side = "<b>Reference</b>" + "".join(f'<a href="{p_}">{t_}</a>' for p_, t_ in doc_links) + (f"<b>On this page</b>{toc}" if toc else "")
    crumbs = [("Docs", "/docs"), (nav_t, path)] if path.startswith("/docs/") else ([("Benchmarks", "/benchmarks"), (nav_t, path)] if path.startswith("/benchmarks/") else [(nav_t, path)])
    meta = {"path": path, "nav": "docs" if path.startswith("/docs") else ("benchmarks" if path.startswith("/benchmarks") else ""), "priority": "0.6",
            "crumbs": crumbs, "title": title, "description": desc,
            "jsonld": [{"@type": "TechArticle", "headline": heading, "author": {"@id": f"{SITE}/#org"}, "publisher": {"@id": f"{SITE}/#org"},
                        "dateModified": TODAY, "isBasedOn": f"{GH}/blob/main/{src}"}]}
    body = f"""<div class="page-hero"><div class="wrap"><!--@crumbs--><h1>{heading}</h1>
<p class="lede">Rendered from <a href="{GH}/blob/main/{src}"><code>{src}</code></a> in the GenClass repository.</p></div></div>
<section style="padding-top: 24px"><div class="wrap doc"><nav class="toc" aria-label="Reference">{side}</nav><article class="prose">{html_body}</article></div></section>"""
    out = PUB / (path.strip("/") + ".html"); out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page(meta, body)); urls.append((path, "0.6"))

sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
for p, pr in sorted(urls, key=lambda x: -float(x[1])):
    sm.append(f"  <url><loc>{SITE}{p}</loc><lastmod>{TODAY}</lastmod><priority>{pr}</priority></url>")
sm.append("</urlset>")
(PUB / "sitemap.xml").write_text("\n".join(sm) + "\n")
print("built", len(urls), "indexable pages:", ", ".join(p for p, _ in urls))
