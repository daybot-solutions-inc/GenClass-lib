// City search typeahead, written the way a lot of real typeaheads are: debounce, fetch, set state.
// Latent bug (deliberate, realistic): no request ordering guard (no AbortController, no request id), so a slow
// response for an older query can overwrite the results of a newer one.
import type { AppContext } from "../../shared/demo-def.ts";
import { api } from "../../shared/api.ts";
import "./app.css";

interface City {
  id: number;
  name: string;
  country: string;
  population: number;
}

interface SearchState {
  input: string;
  query: string;
  items: City[];
  total: number;
  loading: boolean;
  error: string | null;
}

const SUGGESTIONS = ["Santiago", "Portland", "Brisbane", "Salvador", "Marseille"];

function formatPopulation(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function highlightMatch(name: string, query: string): string {
  const q = query.trim().toLowerCase();
  const i = q ? name.toLowerCase().indexOf(q) : -1;
  if (i < 0) return escapeHtml(name);
  return `${escapeHtml(name.slice(0, i))}<mark>${escapeHtml(name.slice(i, i + q.length))}</mark>${escapeHtml(name.slice(i + q.length))}`;
}

export function mountSearch({ gc, el }: AppContext): void {
  const search = gc.atom<SearchState>("search", { input: "", query: "", items: [], total: 0, loading: false, error: null });

  el.innerHTML = `
    <div class="sx">
      <header class="sx-head">
        <div class="sx-logo" aria-hidden="true">✈</div>
        <div>
          <div class="sx-title">Where to next?</div>
          <div class="sx-sub">Search 340 cities by name</div>
        </div>
      </header>
      <label class="sx-box">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input data-testid="search-input" type="search" autocomplete="off" spellcheck="false" placeholder="Search a city…" aria-label="Search a city" />
        <span class="sx-spin" aria-hidden="true"></span>
        <button class="sx-clear" type="button" aria-label="Clear search">×</button>
      </label>
      <div class="sx-meta" data-testid="search-meta"></div>
      <ul class="sx-list" data-testid="search-results" role="listbox" aria-label="Matching cities"></ul>
      <div class="sx-empty" data-testid="search-empty"></div>
    </div>`;

  const input = el.querySelector<HTMLInputElement>('[data-testid="search-input"]')!;
  const list = el.querySelector<HTMLUListElement>('[data-testid="search-results"]')!;
  const meta = el.querySelector<HTMLDivElement>('[data-testid="search-meta"]')!;
  const empty = el.querySelector<HTMLDivElement>('[data-testid="search-empty"]')!;
  const box = el.querySelector<HTMLLabelElement>(".sx-box")!;
  const clear = el.querySelector<HTMLButtonElement>(".sx-clear")!;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  async function runSearch(q: string) {
    if (!q.trim()) {
      search.set((s) => ({ ...s, query: "", items: [], total: 0, loading: false, error: null }));
      return;
    }
    try {
      const res = await fetch(api(`search?q=${encodeURIComponent(q)}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { query: string; total: number; items: City[] };
      search.set((s) => ({ ...s, query: data.query, items: data.items, total: data.total, loading: false, error: null }));
    } catch {
      search.set((s) => ({ ...s, loading: false, error: "Search is unavailable right now. Try again in a moment." }));
    }
  }

  input.addEventListener("input", () => {
    const value = input.value;
    search.set((s) => ({ ...s, input: value, loading: value.trim() !== "" }));
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(value), 150);
  });

  clear.addEventListener("click", () => {
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  });

  empty.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-suggest]");
    if (!b) return;
    input.value = b.dataset.suggest!;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  });

  function render(s: SearchState) {
    box.classList.toggle("loading", s.loading);
    box.classList.toggle("has-text", s.input !== "");
    if (s.error) {
      meta.innerHTML = `<span class="sx-error">${escapeHtml(s.error)}</span>`;
    } else if (s.query) {
      meta.innerHTML = s.total
        ? `<b>${s.total}</b> ${s.total === 1 ? "city matches" : "cities match"} <q>${escapeHtml(s.query)}</q>${s.total > s.items.length ? ` · top ${s.items.length}` : ""}`
        : `No city matches <q>${escapeHtml(s.query)}</q>`;
    } else meta.textContent = "";

    list.innerHTML = s.items
      .map(
        (c, i) => `
        <li data-id="${c.id}" role="option" style="--i:${i}">
          <span class="sx-pin" style="--h:${(c.id * 47) % 360}">${escapeHtml(c.name.slice(0, 1))}</span>
          <span class="sx-name">${highlightMatch(c.name, s.query)}<small>${escapeHtml(c.country)}</small></span>
          <span class="sx-pop">${formatPopulation(c.population)}</span>
        </li>`,
      )
      .join("");

    if (!s.input && !s.items.length) {
      empty.hidden = false;
      empty.innerHTML = `<div>Try</div>${SUGGESTIONS.map((x) => `<button type="button" data-suggest="${x}">${x}</button>`).join("")}`;
    } else empty.hidden = true;
  }

  search.subscribe(render);
  render(search.get());
}
