// Live GenClass lab on genclass.dev: the real @genclass/runtime (script tag from jsDelivr, model on this device).
// "Without GenClass" lanes use the browser's original fetch (captured before the runtime loaded); "With GenClass"
// lanes use the page's fetch, which GenClass observes, and write through a GenClass atom so it can protect them.
(() => {
  const $ = (id) => document.getElementById(id);
  const lab = $("lab");
  if (!lab) return;
  const RAW = window.__gcRawFetch || window.fetch.bind(window);
  const GC = window.GenClass;
  let rt = null;
  try {
    rt = GC && GC.init({
      mode: "guard",
      aggressiveness: "eager",
      telemetry: false,
      report: "console",
      observe: { untrustedEvents: true },
      requests: { protect: ["/forms/"], ignore: ["/cdn-cgi/", "cloudflareinsights"] },
      model: { loadIf: { saveData: "skip" } },
    });
  } catch (e) { console.warn("GenClass did not start", e); }
  const live = (p) => (rt ? window.fetch(p.url, p.init) : RAW(p.url, p.init));
  const text = (el, s) => { el.textContent = s; };
  const li = (ul, s, cls) => { const x = document.createElement("li"); x.textContent = s; if (cls) x.className = cls; ul.append(x); };

  // ---------- tabs ----------
  const tabs = [...lab.querySelectorAll('[role="tab"]')];
  let active = "lab-search";
  function show(i) {
    tabs.forEach((t, j) => { t.setAttribute("aria-selected", String(i === j)); t.tabIndex = i === j ? 0 : -1; $(t.getAttribute("aria-controls")).hidden = i !== j; });
    active = tabs[i].getAttribute("aria-controls");
  }
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => show(i));
    t.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") { show((i + 1) % tabs.length); tabs[(i + 1) % tabs.length].focus(); }
      if (e.key === "ArrowLeft") { show((i + tabs.length - 1) % tabs.length); tabs[(i + tabs.length - 1) % tabs.length].focus(); }
    });
  });

  // ---------- inspector ----------
  const feed = $("gc-feed");
  let nDec = 0, nAct = 0;
  const pct = (p) => (typeof p === "number" ? Math.round(p * 100) + "%" : "");
  function feedItem(html, cls) {
    if (feed.firstElementChild && feed.firstElementChild.classList.contains("mut")) feed.replaceChildren();
    const x = document.createElement("li"); if (cls) x.className = cls; x.append(...html); feed.prepend(x);
    while (feed.children.length > 40) feed.lastElementChild.remove();
  }
  const span = (s, c) => { const e = document.createElement("span"); e.textContent = s; if (c) e.className = c; return e; };
  function explainNode(id) {
    const d = document.createElement("details");
    const s = document.createElement("summary"); s.textContent = "what the model read"; d.append(s);
    d.addEventListener("toggle", () => {
      if (!d.open || d.dataset.done) return; d.dataset.done = "1";
      let ex = null; try { ex = rt.explain(id); } catch {}
      const pre = document.createElement("pre");
      pre.textContent = !ex ? "(not available)" : typeof ex === "string" ? ex : (ex.situation || ex.text || JSON.stringify(ex, null, 2));
      d.append(pre);
    });
    return d;
  }
  function setStatus(s) {
    if (!s) return;
    const st = $("gc-state"); st.textContent = s.state; st.className = "pill2 " + s.state;
    if (s.model) text($("gc-model"), s.model + (s.version ? " " + s.version : ""));
    if (s.device) text($("gc-backend"), s.device + (s.variant ? " · " + s.variant : "") + (s.loadMs ? " · loaded in " + (s.loadMs / 1000).toFixed(1) + " s" : ""));
  }
  if (!rt) {
    setStatus({ state: "unavailable" });
    feedItem([span("GenClass could not start here (blocked script or old browser). Both sides run without it.")], "mut");
  } else {
    setStatus(rt.status);
    rt.on("status", setStatus);
    rt.on("decide", (d) => {
      nDec++; text($("gc-n"), String(nDec));
      const head = span(`${d.trigger} · ${d.diagnosis} ${pct(d.diagnosisConfidence)}`, "k");
      const what = d.executed && d.action !== d.candidate && d.tier === "passive"
        ? span(` → ${d.action}`)
        : d.executed ? span(` → ${d.action} ${pct(d.confidence)}`, d.tier === "passive" ? "" : "ok")
        : span(` → would ${d.candidate || d.action}; not run (${d.reason || "gate"})`, "mut");
      feedItem([head, what, span(` ${d.subject}`, "subj"), explainNode(d.id)], d.diagnosis === "expected" ? "exp" : "");
    });
    rt.on("act", (a) => {
      nAct++; text($("gc-a"), String(nAct));
      feedItem([span("ACTED ", "ok"), span(a.changed || a.action)], "act");
    });
    lab.querySelectorAll(".insp-ctl [data-mode]").forEach((b) => b.addEventListener("click", () => {
      try { rt.setMode(b.dataset.mode); } catch {}
      lab.querySelectorAll(".insp-ctl [data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      text($("ls-mode"), b.dataset.mode);
    }));
    $("gc-aggr").addEventListener("change", (e) => { try { rt.setAggressiveness(e.target.value); } catch {} });
  }

  // ---------- 1. search race ----------
  const q = $("lab-q");
  const results = rt ? rt.atom("search.results", { q: "", items: [] }) : null;
  let seq = 0, offShownSeq = -1, onState = { q: "", items: [] }, typed = "";
  const latency = (n) => (n % 3 === 1 ? 1300 : 140 + ((n * 37) % 200));
  function renderLane(side, val) {
    text($(`ls-${side}-for`), val.q ? `"${val.q}"` : "–");
    const ul = $(`ls-${side}-res`); ul.replaceChildren();
    (val.items.length ? val.items : [val.q ? "no matches" : ""]).filter(Boolean).forEach((c) => li(ul, c));
    const stale = !!val.q && val.q !== typed.trim().toLowerCase();
    $(`ls-${side}`).classList.toggle("stale", !!stale);
    text($(`ls-${side}-st`), stale ? `Stale: the box says "${typed.trim()}"` : val.q ? "In sync with the box" : "");
  }
  if (results) results.subscribe((v) => { onState = v; renderLane("on", v); });
  function onType() {
    typed = q.value;
    const term = typed.trim().toLowerCase();
    if (!term) return;
    const n = ++seq, wait = latency(n), url = `/demo-api/search?q=${encodeURIComponent(term)}&ms=${wait}`;
    RAW(url).then((r) => r.json()).then((j) => { offShownSeq = n; renderLane("off", { q: j.q, items: j.results }); }).catch(() => {});
    live({ url }).then((r) => r.json()).then((j) => {
      if (results) results.set({ q: j.q, items: j.results }); else renderLane("on", { q: j.q, items: j.results });
    }).catch(() => {});
  }
  q.addEventListener("input", onType);
  let typing = null;
  $("lab-auto").addEventListener("click", () => {
    clearInterval(typing); const words = ["paris", "toronto", "san francisco"]; let w = 0, c = 0; q.value = ""; q.focus();
    typing = setInterval(() => {
      const word = words[w];
      if (c <= word.length) { q.value = word.slice(0, c++); q.dispatchEvent(new Event("input", { bubbles: true })); }
      else if (c++ > word.length + 12) { c = 0; w++; if (w >= words.length) clearInterval(typing); }
    }, 160);
  });

  // ---------- 2. double submit ----------
  const orders = { off: new Set(), on: new Set() };
  const cart = rt ? rt.atom("checkout.lastOrder", { id: null }) : null;
  function place(side) {
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sku: "esp32-devkit", qty: 1 }) };
    const p = side === "off" ? RAW("/demo-api/orders?ms=1000", init) : live({ url: "/demo-api/orders?ms=1000", init });
    p.then((r) => r.json()).then((j) => {
      if (side === "on" && cart) cart.set({ id: j.orderId });
      if (!orders[side].has(j.orderId)) { orders[side].add(j.orderId); li($(`lo-${side}-res`), j.orderId); }
      text($(`lo-${side}-n`), String(orders[side].size));
      $(`lo-${side}`).classList.toggle("stale", orders[side].size > 1);
    }).catch(() => {});
  }
  $("lo-off-btn").addEventListener("click", () => place("off"));
  $("lo-on-btn").addEventListener("click", () => place("on"));
  $("lo-dbl").addEventListener("click", () => {
    ["off", "on"].forEach((s) => { const b = $(`lo-${s}-btn`); b.click(); setTimeout(() => b.click(), 130); });
  });
  $("lo-reset").addEventListener("click", () => {
    ["off", "on"].forEach((s) => { orders[s].clear(); text($(`lo-${s}-n`), "0"); $(`lo-${s}-res`).replaceChildren(); $(`lo-${s}`).classList.remove("stale"); });
  });

  // ---------- 3. failing API ----------
  let broken = false, timer = null;
  const stock = rt ? rt.atom("inventory.stock", { n: null }) : null;
  function poll() {
    const url = `/demo-api/stock?fail=${broken ? 1 : 0}`;
    ["off", "on"].forEach((side) => {
      const p = side === "off" ? RAW(url) : live({ url });
      p.then(async (r) => {
        if (!r.ok) { text($(`lk-${side}-st`), `Error ${r.status} from the inventory API`); $(`lk-${side}`).classList.add("stale"); return; }
        const j = await r.json();
        if (side === "on" && stock) stock.set({ n: j.stock });
        text($(`lk-${side}-v`), String(j.stock)); text($(`lk-${side}-st`), "Live"); $(`lk-${side}`).classList.remove("stale");
      }).catch(() => { text($(`lk-${side}-st`), "Network error"); });
    });
  }
  $("lk-toggle").addEventListener("click", () => {
    broken = !broken;
    text($("lk-toggle"), broken ? "Fix the API" : "Break the API");
    text($("lk-api"), broken ? "API: returning 503" : "API: healthy");
  });
  const io = new IntersectionObserver(([e]) => {
    clearInterval(timer);
    if (e.isIntersecting) timer = setInterval(() => { if (active === "lab-stock" && !document.hidden) poll(); }, 1500);
  });
  io.observe(lab);
})();
