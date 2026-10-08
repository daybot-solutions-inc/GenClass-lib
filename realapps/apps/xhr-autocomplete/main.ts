// City / address autocomplete for a delivery-zone checker (plain TypeScript, raw XMLHttpRequest, no library; state
// in runtime atoms). Typeahead with debounce, keyboard selection (ArrowUp/ArrowDown/Enter/Escape), hover
// highlighting, a detail lookup for the chosen place and a client-side "recent searches" list. Latent bugs by
// flag: suggestions applied in arrival order (guard=none; guard=abort cancels the previous XHR instead of the
// default request-id check), the highlighted index kept when a new suggestion list arrives (resetActive=false),
// duplicate recent entries (recentDedupe=false) and detail responses applied out of order (detailGuard=none).
import { rt, flag } from "../_shared/genclass";

type Suggestion = { id: number; name: string; region: string; country: string; postcode: string };
type Place = Suggestion & { population: number; tz: string; lat: number; lon: number; zone: string };

const GUARD = flag("guard", "reqid") as "reqid" | "abort" | "none";
const DEBOUNCE = Number(flag("debounce", 200));
const RESET_ACTIVE = Boolean(flag("resetActive", true));
const RECENT_DEDUPE = Boolean(flag("recentDedupe", true));
const DETAIL_GUARD = flag("detailGuard", "latest") as "latest" | "none";
const MIN_LEN = 2;
const MAX_RECENT = 5;

const ac = rt.atom("ac", { query: "", suggestions: [] as Suggestion[], active: -1, open: false, loading: false, error: "" });
const place = rt.atom("place", { id: 0, detail: null as Place | null, loading: false, error: "" });
const recent = rt.atom("recent", { items: [] as { id: number; label: string }[] });

const label = (s: Suggestion) => `${s.name}, ${s.region}${s.country !== "US" ? `, ${s.country}` : ""}`;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ------------------------------------------------------------------------------------------------- XHR
function getJSON<T>(url: string, done: (data: T) => void, fail: (status: number) => void): XMLHttpRequest {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, true);
  xhr.setRequestHeader("Accept", "application/json");
  xhr.timeout = 6000;
  xhr.onreadystatechange = () => {
    if (xhr.readyState !== XMLHttpRequest.DONE || xhr.status === 0) return;
    if (xhr.status >= 200 && xhr.status < 300) {
      let data: T;
      try {
        data = JSON.parse(xhr.responseText) as T;
      } catch {
        fail(xhr.status);
        return;
      }
      done(data);
    } else fail(xhr.status);
  };
  xhr.onerror = () => fail(0);
  xhr.ontimeout = () => fail(408);
  xhr.send();
  return xhr;
}

// ----------------------------------------------------------------------------------------- suggestions
let seq = 0;
let current: XMLHttpRequest | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function search(q: string) {
  if (q.trim().length < MIN_LEN) {
    if (GUARD === "abort") current?.abort();
    seq++;
    ac.update((s) => ({ ...s, suggestions: [], open: false, active: -1, loading: false }));
    return;
  }
  const id = ++seq;
  if (GUARD === "abort") current?.abort();
  ac.update((s) => ({ ...s, loading: true, error: "" }));
  current = getJSON<{ results: Suggestion[]; count: number }>(
    `/api/places?q=${encodeURIComponent(q.trim())}&limit=6`,
    (d) => {
      if (GUARD === "reqid" && id !== seq) return;
      ac.update((s) => ({ ...s, suggestions: d.results, open: true, loading: false, active: RESET_ACTIVE ? -1 : s.active }));
    },
    (status) => {
      if (GUARD === "reqid" && id !== seq) return;
      ac.update((s) => ({ ...s, loading: false, error: status === 429 ? "Too many lookups — slow down a little." : "Suggestions are unavailable right now." }));
    },
  );
}

function onInput(v: string) {
  ac.update((s) => ({ ...s, query: v }));
  if (timer) clearTimeout(timer);
  if (DEBOUNCE > 0) timer = setTimeout(() => search(v), DEBOUNCE);
  else search(v);
}

// -------------------------------------------------------------------------------------------- selection
let detailSeq = 0;
function lookup(id: number) {
  const mine = ++detailSeq;
  place.set({ id, detail: null, loading: true, error: "" });
  getJSON<Place>(
    `/api/places/${id}`,
    (p) => {
      if (DETAIL_GUARD === "latest" && mine !== detailSeq) return;
      place.update((s) => ({ ...s, detail: p, loading: false }));
    },
    () => {
      if (DETAIL_GUARD === "latest" && mine !== detailSeq) return;
      place.update((s) => ({ ...s, loading: false, error: "We couldn't load delivery details for this place." }));
    },
  );
}

function remember(id: number, text: string) {
  recent.update((r) => {
    const rest = RECENT_DEDUPE ? r.items.filter((x) => x.id !== id) : r.items;
    return { items: [{ id, label: text }, ...rest].slice(0, MAX_RECENT) };
  });
  try {
    localStorage.setItem("recent-places", JSON.stringify(recent.get().items));
  } catch {
    /* private mode */
  }
}

function choose(index: number) {
  const s = ac.get();
  const sug = s.suggestions[index];
  if (!sug) return;
  const text = label(sug);
  input.value = text;
  ac.update((x) => ({ ...x, query: text, open: false, active: -1 }));
  remember(sug.id, text);
  lookup(sug.id);
}

// ----------------------------------------------------------------------------------------------- render
const root = document.getElementById("app")!;
root.innerHTML = `
  <h1>Check delivery to your area</h1>
  <form class="finder" role="search" autocomplete="off">
    <label for="place-q">City or ZIP</label>
    <div class="combo"><input id="place-q" name="q" role="combobox" aria-autocomplete="list" aria-controls="place-list" placeholder="Start typing a city…"><button type="button" class="clear-q" aria-label="Clear">×</button></div>
    <ul id="place-list" class="suggestions" role="listbox"></ul>
    <p class="ac-status" aria-live="polite"></p>
    <div class="ac-error"></div>
  </form>
  <section class="detail"></section>
  <section class="recents"><h2>Recent searches</h2><ul class="recent"></ul><button type="button" class="clear-recent">Clear history</button></section>`;
const input = root.querySelector<HTMLInputElement>("#place-q")!;
const list = root.querySelector<HTMLUListElement>("#place-list")!;

function renderAc() {
  const s = ac.get();
  list.hidden = !s.open || !s.suggestions.length;
  list.innerHTML = s.open ? s.suggestions.map((x, i) => `<li class="suggestion${i === s.active ? " active" : ""}" role="option" aria-selected="${i === s.active}" data-i="${i}">${esc(label(x))} <small>${esc(x.postcode)}</small></li>`).join("") : "";
  root.querySelector(".ac-status")!.textContent = s.loading ? "Searching…" : s.open && !s.suggestions.length && s.query.trim().length >= MIN_LEN ? "No matching places." : "";
  root.querySelector(".ac-error")!.innerHTML = s.error ? `<p role="alert">${esc(s.error)}</p>` : "";
}
function renderPlace() {
  const p = place.get();
  const el = root.querySelector(".detail")!;
  if (!p.id) el.innerHTML = "";
  else if (p.loading) el.innerHTML = `<p class="muted">Checking delivery zone…</p>`;
  else if (p.error) el.innerHTML = `<p role="alert">${esc(p.error)}</p>`;
  else if (p.detail) {
    const d = p.detail;
    el.innerHTML = `<h2>${esc(label(d))}</h2><p>Delivery zone <strong>${esc(d.zone)}</strong> · ${esc(d.tz)}</p><p>Population ${d.population.toLocaleString("en-US")} · ${Math.abs(d.lat).toFixed(2)}°${d.lat >= 0 ? "N" : "S"} ${Math.abs(d.lon).toFixed(2)}°${d.lon >= 0 ? "E" : "W"}</p>`;
  }
}
function renderRecent() {
  const r = recent.get();
  root.querySelector(".recent")!.innerHTML = r.items.length ? r.items.map((x) => `<li><button type="button" class="recent-item" data-id="${x.id}">${esc(x.label)}</button></li>`).join("") : `<li class="muted">No recent searches.</li>`;
}
ac.subscribe(renderAc);
place.subscribe(renderPlace);
recent.subscribe(renderRecent);

// ----------------------------------------------------------------------------------------------- events
input.addEventListener("input", () => onInput(input.value));
input.addEventListener("keydown", (e) => {
  const s = ac.get();
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!s.suggestions.length) return;
    const n = s.suggestions.length;
    const next = e.key === "ArrowDown" ? (s.active + 1) % n : (s.active - 1 + n) % n;
    ac.update((x) => ({ ...x, open: true, active: next }));
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (s.open && s.suggestions.length) choose(s.active >= 0 ? s.active : 0);
  } else if (e.key === "Escape") {
    ac.update((x) => ({ ...x, open: false, active: -1 }));
  }
});
input.addEventListener("blur", () => setTimeout(() => ac.update((x) => ({ ...x, open: false })), 150));
input.addEventListener("focus", () => {
  if (ac.get().suggestions.length) ac.update((x) => ({ ...x, open: true }));
});
list.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
list.addEventListener("mouseover", (e) => {
  const li = (e.target as Element).closest("li.suggestion") as HTMLElement | null;
  if (li && Number(li.dataset.i) !== ac.get().active) ac.update((x) => ({ ...x, active: Number(li.dataset.i) }));
});
list.addEventListener("click", (e) => {
  const li = (e.target as Element).closest("li.suggestion") as HTMLElement | null;
  if (li) choose(Number(li.dataset.i));
});
root.querySelector(".clear-q")!.addEventListener("click", () => {
  input.value = "";
  onInput("");
  input.focus();
});
root.querySelector(".recent")!.addEventListener("click", (e) => {
  const b = (e.target as Element).closest("button.recent-item") as HTMLElement | null;
  if (!b) return;
  const id = Number(b.dataset.id);
  input.value = b.textContent ?? "";
  ac.update((x) => ({ ...x, query: input.value, open: false, active: -1 }));
  remember(id, input.value);
  lookup(id);
});
root.querySelector(".clear-recent")!.addEventListener("click", () => {
  recent.set({ items: [] });
  try {
    localStorage.removeItem("recent-places");
  } catch {
    /* ignore */
  }
});
root.querySelector("form")!.addEventListener("submit", (e) => e.preventDefault());

try {
  const saved = JSON.parse(localStorage.getItem("recent-places") ?? "[]") as { id: number; label: string }[];
  if (Array.isArray(saved) && saved.length) recent.set({ items: saved.slice(0, MAX_RECENT) });
} catch {
  /* ignore */
}
renderAc();
renderPlace();
renderRecent();
