// Ops status dashboard: polls six services every 2 s. The app keeps its own tiny observable store and hands it
// to GenClass with gc.guard(); refreshAll() doubles as the store's resync handler.
// Latent bugs (deliberate, realistic):
//   - setInterval polling never waits for the previous round, so slow rounds pile up and answer out of order;
//   - failures are retried immediately (no backoff) up to three attempts;
//   - after the last failed attempt the service shows "Unreachable" and an error banner pops up.
import type { AppContext } from "../../shared/demo-def.ts";
import { api } from "../../shared/api.ts";
import { SERVICES } from "../../server/worlds/status.ts";
import "./app.css";

type Shown = "unknown" | "operational" | "degraded" | "down" | "unreachable";

interface ServiceView {
  id: string;
  name: string;
  region: string;
  status: Shown;
  latencyMs: number | null;
  checkedAt: number | null;
  history: (number | null)[];
}

interface Banner {
  id: number;
  svc: string;
  text: string;
  at: number;
}

interface Dashboard {
  services: Record<string, ServiceView>;
  banners: Banner[];
  updatedAt: number | null;
}

/** The app's own minimal store (what a small vanilla app would write). */
function createStore<T>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (v: T) => {
      state = v;
      for (const f of subs) f();
    },
    subscribe: (f: () => void) => {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

const POLL_MS = 2000;
const LABEL: Record<Shown, string> = {
  unknown: "Checking…",
  operational: "Operational",
  degraded: "Degraded",
  down: "Major outage",
  unreachable: "Unreachable",
};

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

function sparkline(values: (number | null)[]): string {
  const w = 132;
  const hgt = 30;
  const pts = values.slice(-24);
  if (!pts.length) return `<svg viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none" aria-hidden="true"></svg>`;
  const max = Math.max(150, ...pts.map((v) => v ?? 0));
  const step = w / 23;
  let d = "";
  let pen = false;
  const fails: string[] = [];
  pts.forEach((v, i) => {
    const x = (i + (24 - pts.length)) * step;
    if (v === null) {
      fails.push(`<rect x="${x - 1.5}" y="${hgt - 4}" width="3" height="4" rx="1" class="fail"/>`);
      pen = false;
      return;
    }
    const y = hgt - 4 - (v / max) * (hgt - 8);
    d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  });
  return `<svg viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" vector-effect="non-scaling-stroke"/>${fails.join("")}</svg>`;
}

function ago(t: number | null): string {
  if (!t) return "never";
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 1.5 ? "just now" : `${Math.round(s)}s ago`;
}

export function mountStatus({ gc, el }: AppContext): void {
  const raw = createStore<Dashboard>({
    services: Object.fromEntries(
      SERVICES.map((s) => [s.id, { id: s.id, name: s.name, region: s.region, status: "unknown" as Shown, latencyMs: null, checkedAt: null, history: [] }]),
    ),
    banners: [],
    updatedAt: null,
  });
  const board = gc.guard("services", raw, { resync: () => refreshAll() });
  let bannerSeq = 0;

  async function poll(id: string, attempt = 1): Promise<void> {
    try {
      const res = await fetchWithTimeout(api(`status/${id}`), 4000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { status: Shown; latencyMs: number | null; checkedAt: number };
      board.update((b) => {
        const s = b.services[id];
        return {
          ...b,
          updatedAt: Date.now(),
          services: {
            ...b.services,
            [id]: { ...s, status: data.status, latencyMs: data.latencyMs, checkedAt: data.checkedAt, history: [...s.history, data.latencyMs ?? 0].slice(-24) },
          },
        };
      });
    } catch (e) {
      if (attempt < 3) return poll(id, attempt + 1);
      const msg = e instanceof Error && e.name === "AbortError" ? "timed out" : e instanceof Error ? e.message : "failed";
      board.update((b) => {
        const s = b.services[id];
        return {
          ...b,
          services: { ...b.services, [id]: { ...s, status: "unreachable", history: [...s.history, null].slice(-24) } },
          banners: [...b.banners, { id: ++bannerSeq, svc: id, text: `Couldn’t reach ${s.name} (${msg})`, at: Date.now() }].slice(-3),
        };
      });
    }
  }

  async function refreshAll(): Promise<void> {
    await Promise.all(SERVICES.map((s) => poll(s.id)));
  }

  el.innerHTML = `
    <div class="st">
      <header class="st-head">
        <div class="st-brand"><span class="st-logo"></span><div><b>Acme Cloud</b><small>System status</small></div></div>
        <div class="st-actions">
          <span class="st-updated" data-testid="updated"></span>
          <button class="st-refresh" type="button" data-testid="refresh">Refresh</button>
        </div>
      </header>
      <div class="st-overall" data-testid="overall"></div>
      <div class="st-banners" data-testid="banners" aria-live="polite"></div>
      <div class="st-grid" data-testid="services"></div>
      <footer class="st-foot">Polling every ${POLL_MS / 1000} s · <span data-testid="poll-count">0</span> polls this session</footer>
    </div>`;

  const grid = el.querySelector<HTMLElement>('[data-testid="services"]')!;
  const overall = el.querySelector<HTMLElement>('[data-testid="overall"]')!;
  const banners = el.querySelector<HTMLElement>('[data-testid="banners"]')!;
  const updated = el.querySelector<HTMLElement>('[data-testid="updated"]')!;
  const pollCount = el.querySelector<HTMLElement>('[data-testid="poll-count"]')!;
  let rounds = 0;

  grid.innerHTML = SERVICES.map(
    (s) => `
      <article class="st-card" data-testid="svc-${s.id}" data-state="unknown">
        <div class="st-card-top"><div><b>${s.name}</b><small>${s.region}</small></div><span class="st-pill"><i></i><span></span></span></div>
        <div class="st-spark"></div>
        <div class="st-card-foot"><span class="st-lat"></span><span class="st-checked"></span></div>
      </article>`,
  ).join("");

  el.querySelector('[data-testid="refresh"]')!.addEventListener("click", () => void refreshAll());
  banners.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-dismiss]");
    if (!b) return;
    const id = Number(b.dataset.dismiss);
    board.update((d) => ({ ...d, banners: d.banners.filter((x) => x.id !== id) }));
  });

  function render() {
    const d = board.get();
    const list = Object.values(d.services);
    for (const s of list) {
      const card = grid.querySelector<HTMLElement>(`[data-testid="svc-${s.id}"]`)!;
      card.dataset.state = s.status;
      card.querySelector(".st-pill span")!.textContent = LABEL[s.status];
      card.querySelector(".st-spark")!.innerHTML = sparkline(s.history);
      card.querySelector(".st-lat")!.textContent = s.latencyMs === null ? "–" : `${s.latencyMs} ms`;
      card.querySelector(".st-checked")!.textContent = `checked ${ago(s.checkedAt)}`;
    }
    const bad = list.filter((s) => s.status === "down" || s.status === "unreachable");
    const deg = list.filter((s) => s.status === "degraded");
    const unknown = list.some((s) => s.status === "unknown");
    overall.dataset.state = bad.length ? "bad" : deg.length ? "warn" : unknown ? "unknown" : "ok";
    overall.textContent = unknown
      ? "Checking services…"
      : bad.length
        ? `${bad.map((s) => s.name).join(", ")} ${bad.length === 1 ? "is" : "are"} having problems`
        : deg.length
          ? `${deg.map((s) => s.name).join(", ")} ${deg.length === 1 ? "is" : "are"} degraded`
          : "All systems operational";
    banners.innerHTML = d.banners
      .map((b) => `<div class="st-banner" data-testid="banner" data-id="${b.id}" role="alert"><span>${b.text}</span><button type="button" data-dismiss="${b.id}" aria-label="Dismiss">×</button></div>`)
      .join("");
    updated.textContent = d.updatedAt ? `Updated ${ago(d.updatedAt)}` : "";
  }
  board.subscribe(render);
  render();
  setInterval(render, 1000);

  void refreshAll();
  setInterval(() => {
    rounds++;
    pollCount.textContent = String(rounds);
    void refreshAll();
  }, POLL_MS);
}
