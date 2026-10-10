(() => {
const $ = id => document.getElementById(id);

document.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); } catch {}
  const k = b.querySelector(".k"); b.classList.add("done"); k.textContent = "Copied";
  setTimeout(() => { b.classList.remove("done"); k.textContent = "Copy"; }, 1600);
}));

const tabs = [...document.querySelectorAll('[role="tab"]')];
function select(i, focus) {
  tabs.forEach((b, j) => { b.setAttribute("aria-selected", i === j); b.tabIndex = i === j ? 0 : -1; $(b.getAttribute("aria-controls")).hidden = i !== j; });
  if (focus) tabs[i].focus();
}
tabs.forEach((b, i) => {
  b.addEventListener("click", () => select(i));
  b.addEventListener("keydown", e => {
    if (e.key === "ArrowRight") select((i + 1) % tabs.length, true);
    if (e.key === "ArrowLeft") select((i + tabs.length - 1) % tabs.length, true);
  });
});
if (tabs.length) select(0);

const CITIES = ["San Francisco","San Diego","San Jose","San Antonio","Santa Fe","Santiago","Sapporo","Salvador","Paris","Panama City","Palermo","Perth","Porto","Prague","Lisbon","London","Los Angeles","Lima","Lagos","Toronto","Tokyo","Tallinn","Taipei","Berlin","Bergen","Bern","Boston","Bogotá","Mumbai","Munich","Montreal","Madrid","Melbourne","Seoul","Seattle","Singapore","Stockholm","Sydney","Vancouver","Vienna","Venice","Waterloo"];
const q = $("q");
if (!q) return;
let seq = 0, base = 0, offShown = -1, onShown = -1, offQ = "", onQ = "", typed = "", sOff = 0, sDisc = 0, timer = null;
const latency = n => { const r = Math.abs((Math.sin(n * 12.9898) * 43758.5453) % 1); return n % 3 === 1 ? 900 + r * 500 : 140 + r * 260; };
const search = s => { const k = s.trim().toLowerCase(); return k ? CITIES.filter(c => c.toLowerCase().startsWith(k)).slice(0, 5) : []; };
function render(lane, forQ, list) {
  $(lane + "For").textContent = forQ ? `"${forQ}"` : "nothing yet";
  const ul = $(lane + "Res"); ul.replaceChildren();
  for (const c of (list.length ? list : ["No matches"])) { const li = document.createElement("li"); li.textContent = c; ul.append(li); }
}
function status(id, cls, text) { const el = $(id); el.replaceChildren(); const s = document.createElement("span"); s.className = cls; s.textContent = text; el.append(s); }
function onType() {
  const s = q.value; typed = s;
  if (!s.trim()) return;
  const id = ++seq, ms = latency(id - base);
  const row = document.createElement("div"); row.className = "req";
  const lq = document.createElement("span"); lq.className = "q"; lq.textContent = `#${id - base} q=${s}`;
  const t = document.createElement("div"); t.className = "t"; const bar = document.createElement("i"); t.append(bar);
  const lm = document.createElement("span"); lm.className = "ms"; lm.textContent = `${Math.round(ms)} ms`;
  row.append(lq, t, lm);
  const reqs = $("reqs"); reqs.prepend(row); while (reqs.children.length > 6) reqs.lastChild.remove();
  bar.style.transition = `width ${ms}ms linear`;
  requestAnimationFrame(() => requestAnimationFrame(() => bar.style.width = "100%"));
  setTimeout(() => {
    if (id <= base) return;
    const res = search(s), late = id < offShown;
    if (late) row.classList.add("late");
    offShown = id; offQ = s; render("off", s, res);
    if (late && s !== typed) { sOff++; $("sOff").textContent = sOff; }
    const stale = offQ !== typed;
    $("laneOff").classList.toggle("stale", stale);
    if (stale) status("offSt", "no", `Stale: the box says "${typed}", the results are for "${offQ}"`);
    else status("offSt", "", "In sync");
    if (id < onShown) {
      sDisc++; $("sDisc").textContent = sDisc;
      status("onSt", "ok", `[GenClass] Prevented a stale write: "${s}" landed after "${onQ}" was shown (stale; discard)`);
    } else {
      onShown = id; onQ = s; render("on", s, res);
      status("onSt", "", `In sync, delivered #${id - base}`);
    }
  }, ms);
}
q.addEventListener("input", onType);
function reset() {
  clearInterval(timer); timer = null; $("auto").textContent = "Auto-type";
  base = seq; offShown = onShown = -1; offQ = onQ = typed = ""; sOff = sDisc = 0;
  q.value = ""; $("sOff").textContent = 0; $("sDisc").textContent = 0; $("reqs").replaceChildren();
  $("offRes").replaceChildren(); $("onRes").replaceChildren(); $("offFor").textContent = $("onFor").textContent = "nothing yet";
  $("laneOff").classList.remove("stale"); $("offSt").textContent = $("onSt").textContent = "Waiting for input.";
}
$("reset").addEventListener("click", reset);
$("auto").addEventListener("click", () => {
  reset();
  const words = ["san francisco", "paris", "toronto", "melbourne"]; let w = 0, c = 0;
  $("auto").textContent = "Typing…";
  timer = setInterval(() => {
    const word = words[w];
    if (c <= word.length) { q.value = word.slice(0, c++); if (q.value) onType(); }
    else if (c++ > word.length + 9) { c = 0; w++; q.value = ""; if (w >= words.length) { clearInterval(timer); timer = null; $("auto").textContent = "Auto-type"; } }
  }, 170);
});
})();

// GenClass Cloud preview: sidebar sections
(() => {
  document.querySelectorAll("[data-app]").forEach(app => {
    const btns = [...app.querySelectorAll("[data-view]")];
    btns.forEach(b => b.addEventListener("click", () => {
      btns.forEach(x => x.setAttribute("aria-current", x === b ? "true" : "false"));
      app.querySelectorAll("[data-panel]").forEach(p => { p.hidden = p.dataset.panel !== b.dataset.view; });
    }));
  });
})();

// Early-access form
(() => {
  document.querySelectorAll("form[data-waitlist]").forEach(form => {
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const msg = form.querySelector(".msg"), btn = form.querySelector("button[type=submit]");
      const data = Object.fromEntries(new FormData(form));
      data.page = location.pathname;
      msg.className = "msg"; msg.textContent = "Sending…"; btn.disabled = true;
      try {
        const r = await fetch("/forms/waitlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Something went wrong. Please try again.");
        msg.className = "msg ok"; msg.textContent = "You're on the list. We'll be in touch soon."; form.reset();
      } catch (err) {
        msg.className = "msg err"; msg.textContent = err.message;
      } finally { btn.disabled = false; }
    });
  });
})();
