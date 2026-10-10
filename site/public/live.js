// Live GenClass lab on genclass.dev: the real @genclass/runtime (script tag from jsDelivr, model on this device).
// "Without GenClass" uses the browser's original fetch (captured before the runtime loaded); "With GenClass" uses the
// page's fetch, which GenClass observes. The demo runs at maximum aggressiveness (gain margins 0) unless
// ?lab-thr=default (production margins) or ?lab-thr=<n>; ?lab-mode= picks the mode.
(() => {
  const $ = (id) => document.getElementById(id);
  const lab = $("lab");
  if (!lab) return;
  const RAW = window.__gcRawFetch || window.fetch.bind(window);
  const GC = window.GenClass;
  const qs = new URLSearchParams(location.search);
  const thr = qs.get("lab-thr") ?? "0";
  let rt = null;
  try {
    rt = GC && GC.init({
      mode: qs.get("lab-mode") || "guard",
      ...(thr !== "default" ? { policy: { thresholds: { guard: Number(thr), heal: Number(thr) } } } : {}),
      aggressiveness: "eager",
      telemetry: false,
      report: "console",
      observe: { untrustedEvents: true },
      requests: { protect: ["/forms/"], ignore: ["/cdn-cgi/", "cloudflareinsights"] },
      model: { loadIf: { saveData: "skip" } },
    });
  } catch (e) { console.warn("GenClass did not start", e); }
  const text = (el, s) => { if (el) el.textContent = s; };
  const el = (tag, cls, s) => { const x = document.createElement(tag); if (cls) x.className = cls; if (s !== undefined) x.textContent = s; return x; };
  const pct = (p) => Math.round(p * 100) + "%";

  // ---------- status ----------
  let ready = false;
  const go = $("dup-go");
  function setStatus(s) {
    if (!s) return;
    if (s.device) text($("gc-backend"), s.device + (s.variant ? " · " + s.variant : "") + (s.loadMs ? " · loaded in " + (s.loadMs / 1000).toFixed(1) + " s" : ""));
    if (s.state === "ready") {
      ready = true;
      text($("gc-live"), "GenClass 0.2.0 running on your device");
      lab.classList.add("is-ready");
    } else if (s.state === "loading" || s.state === "unloaded") {
      text($("gc-live"), "Loading the GenClass model on your device…");
    } else {
      text($("gc-live"), "Model unavailable here: GenClass only observes");
    }
    go.disabled = !ready && (s.state === "loading" || s.state === "unloaded");
    text(go, go.disabled ? "Loading model…" : "Double-click both");
  }
  if (rt) { setStatus(rt.status); rt.on("status", setStatus); }
  else { text($("gc-live"), "GenClass could not start in this browser"); }

  // ---------- problem feed ----------
  const feed = $("gc-feed");
  const cards = new Map(), byDecision = new Map();
  let nChecked = 0, nBugs = 0, nFixed = 0;
  const TITLE = {
    duplicate: "Duplicate request: the same change is being sent twice",
    stale: "Stale response about to overwrite newer data",
    conflict: "Two operations racing over the same state",
    failing: "An API keeps failing",
    transient: "A one-off failure that will likely succeed on retry",
    slow: "A request is far slower than usual",
    overload: "Work is firing far more often than usual",
    inconsistent: "State contradicts itself",
    unusual: "This request behaves unlike its usual self",
  };
  // One card per problem: repeats of the same diagnosis on the same endpoint bump a counter instead of piling up.
  const keyOf = (d) => d.diagnosis + " " + String(d.subject).replace(/\s*\(#\d+\).*$/, "").replace(/\?.*$/, "");
  function card(d) {
    if (feed.querySelector(".feed-empty")) feed.replaceChildren();
    const key = keyOf(d);
    let li = cards.get(key);
    if (li) {
      li.dataset.n = String(Number(li.dataset.n) + 1);
      text(li.querySelector(".bug-n"), "×" + li.dataset.n);
    } else {
      li = el("li", "bug " + d.diagnosis); li.dataset.n = "1";
      const top = el("div", "bug-top");
      top.append(el("b", "", TITLE[d.diagnosis] || d.diagnosis), el("span", "bug-n"), el("span", "bug-conf"));
      const bar = el("div", "bug-bar"); bar.append(el("i"));
      li.append(top, bar, el("div", "bug-subj"), el("div", "bug-ev"), el("div", "bug-out"));
      const det = el("details"); det.append(el("summary", "", "What the model read"));
      det.addEventListener("toggle", () => {
        if (!det.open) return;
        det.querySelector("pre")?.remove();
        let ex = null; try { ex = rt.explain(li.dataset.id); } catch {}
        det.append(el("pre", "", !ex ? "(not available)" : typeof ex === "string" ? ex : (ex.situation || ex.text || JSON.stringify(ex, null, 2))));
      });
      li.append(det);
      cards.set(key, li);
    }
    li.dataset.id = d.id;
    byDecision.set(d.id, li);
    text(li.querySelector(".bug-conf"), pct(d.diagnosisConfidence) + " sure");
    li.querySelector(".bug-bar i").style.width = pct(d.diagnosisConfidence);
    text(li.querySelector(".bug-subj"), d.subject);
    const ev = d.facts && d.facts.find((f) => f && f.length > 12);
    text(li.querySelector(".bug-ev"), ev ? "Evidence: " + ev : "");
    if (!li.classList.contains("fixed")) text(li.querySelector(".bug-out"), d.executed && d.tier !== "passive" ? "Fixing…" : "Flagged, left as is" + (/mode/.test(d.reason || "") ? " (fixing this needs heal mode)" : ""));
    feed.prepend(li);
    while (feed.children.length > 12) { const last = feed.lastElementChild; [...cards].forEach(([k, v]) => v === last && cards.delete(k)); last.remove(); }
  }
  if (rt) {
    rt.on("decide", () => { nChecked++; text($("gc-n"), String(nChecked)); });
    rt.on("detect", (d) => { nBugs++; text($("gc-bugs"), String(nBugs)); card(d); });
    rt.on("act", (a) => {
      if (!a.ok || a.tier === "passive") return;
      nFixed++; text($("gc-a"), String(nFixed));
      const li = byDecision.get(a.decisionId);
      if (li) { li.classList.add("fixed"); text(li.querySelector(".bug-out"), "Fixed: " + a.changed); }
      if (a.action === "coalesce") lastCoalesce = a.changed;
    });
  }

  // ---------- 1. the double-click invoice ----------
  let lastCoalesce = "";
  const lanes = { off: { ids: [], clicks: 0 }, on: { ids: [], clicks: 0 } };
  let invNo = 1041;
  function resetLane(s) {
    lanes[s] = { ids: [], clicks: 0 };
    const ul = $(`inv-${s}-list`); ul.replaceChildren(el("li", "inv-empty", "No emails yet"));
    text($(`inv-${s}-v`), ""); $(`inv-${s}`).classList.remove("bad", "good");
  }
  function verdict(s) {
    const L = lanes[s], n = L.ids.length, v = $(`inv-${s}-v`);
    if (!n || L.pending) return;
    const box = $(`inv-${s}`);
    if (n > 1) {
      box.classList.add("bad"); box.classList.remove("good");
      v.replaceChildren(el("b", "", `${n} identical invoices sent`), document.createTextNode(` from ${L.clicks} clicks. The server ran the POST ${n} times.`));
    } else {
      box.classList.add("good"); box.classList.remove("bad");
      v.replaceChildren(el("b", "", "1 invoice sent"),
        document.createTextNode(L.clicks > 1 ? ` from ${L.clicks} clicks. The extra clicks reused the first request's response.` : "."));
    }
  }
  function send(s) {
    const L = lanes[s];
    L.clicks++; L.pending = (L.pending || 0) + 1;
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invoice: "INV-" + invNo, to: "customer@acme.com", amount: 2400 }) };
    const f = s === "off" || !rt ? RAW : window.fetch;
    f("/demo-api/orders?ms=1500", init).then(async (r) => {
      const j = await r.json();
      const coalesced = /coalesc/i.test(r.headers.get("x-genclass") || "");
      if (L !== lanes[s]) return;
      if (!L.ids.includes(j.orderId)) {
        L.ids.push(j.orderId);
        const ul = $(`inv-${s}-list`);
        if (ul.querySelector(".inv-empty")) ul.replaceChildren();
        const row = el("li", L.ids.length > 1 ? "dup" : "");
        const t = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
        row.append(el("span", "inv-from", "Acme Billing"), el("span", "inv-subj", `Invoice INV-${invNo} · $2,400.00 due Oct 24`), el("span", "inv-t", L.ids.length > 1 ? "Duplicate" : t));
        ul.append(row);
      }
      if (coalesced && s === "on") {
        const qn = $("dup-quote"); qn.hidden = false;
        qn.replaceChildren(el("b", "", "GenClass: "), document.createTextNode(lastCoalesce || "Did not send the repeated POST; reused the in-flight response (x-genclass: coalesced)."));
      }
    }).catch(() => {}).finally(() => { if (L === lanes[s]) { L.pending--; verdict(s); } });
  }
  $("inv-off-btn").addEventListener("click", () => send("off"));
  $("inv-on-btn").addEventListener("click", () => send("on"));
  go.addEventListener("click", () => {
    invNo++; resetLane("off"); resetLane("on"); $("dup-quote").hidden = true; lastCoalesce = "";
    ["off", "on"].forEach((s) => { const b = $(`inv-${s}-btn`); [0, 280, 560].forEach((t) => setTimeout(() => b.click(), t)); });
  });

  // ---------- 2. search race (with GenClass) ----------
  const q = $("lab-q");
  const results = rt ? rt.atom("search.results", { q: "", items: [] }) : null;
  let seq = 0, typed = "", shown = { q: "", items: [] };
  const latency = (n) => (n % 3 === 1 ? 1300 : 140 + ((n * 37) % 200));
  function renderSearch(v) {
    shown = v;
    text($("ls-on-for"), v.q ? `"${v.q}"${v.items.length ? " · " + v.items.length + " results" : ""}` : "–");
    const term = typed.trim().toLowerCase(), flag = $("ls-flag");
    const stale = !!v.q && v.q !== term;
    flag.className = "mini-flag " + (v.q ? (stale ? "bad" : "good") : "");
    text(flag, v.q ? (stale ? `out of date: the box says "${typed.trim()}"` : "matches the box") : "");
  }
  if (results) results.subscribe(renderSearch);
  q.addEventListener("input", () => {
    typed = q.value;
    const term = typed.trim().toLowerCase();
    renderSearch(shown);
    if (!term) return;
    const n = ++seq, url = `/demo-api/search?q=${encodeURIComponent(term)}&ms=${latency(n)}`;
    const f = rt ? window.fetch : RAW;
    f(url).then((r) => r.json()).then((j) => {
      const v = { q: j.q, items: j.results };
      if (results) results.set(v); else renderSearch(v);
    }).catch(() => {});
  });
  let typing = null;
  $("lab-auto").addEventListener("click", () => {
    clearInterval(typing); const words = ["paris", "toronto", "san francisco"]; let w = 0, c = 0; q.value = ""; q.focus();
    typing = setInterval(() => {
      const word = words[w];
      if (c <= word.length) { q.value = word.slice(0, c++); q.dispatchEvent(new Event("input", { bubbles: true })); }
      else if (c++ > word.length + 12) { c = 0; w++; if (w >= words.length) clearInterval(typing); }
    }, 160);
  });

  // ---------- 3. failing API (with GenClass) ----------
  let broken = false, timer = null;
  const stock = rt ? rt.atom("inventory.stock", { n: null }) : null;
  function poll() {
    const f = rt ? window.fetch : RAW;
    f(`/demo-api/stock?fail=${broken ? 1 : 0}`).then(async (r) => {
      const v = $("lk-on-v");
      if (!r.ok) { text(v, `Error ${r.status}`); v.className = "bad"; return; }
      const j = await r.json();
      if (stock) stock.set({ n: j.stock });
      text(v, `${j.stock} in stock`); v.className = "";
    }).catch(() => text($("lk-on-v"), "Network error"));
  }
  $("lk-toggle").addEventListener("click", () => { broken = !broken; text($("lk-toggle"), broken ? "Fix the API" : "Break the API"); poll(); });
  new IntersectionObserver(([e]) => {
    clearInterval(timer);
    if (e.isIntersecting) { poll(); timer = setInterval(() => { if (!document.hidden) poll(); }, 1500); }
  }).observe($("lk-on-v"));
})();
