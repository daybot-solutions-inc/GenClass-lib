// Neighbourhood map with clustered pin lists (Preact 10 + signals mirroring a runtime atom; fetch). The viewport is
// 2×2 tiles; panning loads every visible tile (one GET per tile, cached per tile) and pins are grouped into clusters
// by 50-unit cells, listed with counts; residents add pins in the viewport's centre tile. Latent bugs by flag: tile
// responses of an earlier viewport merged into the current one (viewportSeq=blind), no tile cache (cache=none: every
// pan refetches), the Add button live while posting (addGuard=none) and the clustered-pin count adjusted by hand
// (clusterCount=incremental).
import { render } from "preact";
import { rt, flag } from "../_shared/genclass";
import { atomSignal } from "../_shared/preact-atom";
import { api, itemsOf, errText } from "../_shared/w3-http";

type Pin = { id: number; tile: string; x: number; y: number; category: string; name: string };
const VIEWPORT_SEQ = flag("viewportSeq", "latest");
const CACHE = flag("cache", "per-tile");
const ADD_GUARD = flag("addGuard", "disable") === "disable";
const CLUSTER_COUNT = flag("clusterCount", "derive");

const map = rt.atom("map", { cx: 1, cy: 1, category: "all", pins: [] as Pin[], clustered: 0, open: "", draft: "", adding: false, loading: true, error: "", notice: "" });
type M = ReturnType<typeof map.get>;
const sig = atomSignal(map);
const cache = new Map<string, Pin[]>();
const tilesOf = (cx: number, cy: number) => [`${cx}-${cy}`, `${cx + 1}-${cy}`, `${cx}-${cy + 1}`, `${cx + 1}-${cy + 1}`];
const visible = (m: M, ps: Pin[]) => ps.filter((p) => m.category === "all" || p.category === m.category);

let seq = 0;
async function loadView() {
  const my = ++seq;
  const { cx, cy } = map.get();
  map.update((m) => ({ ...m, loading: true, error: "" }));
  try {
    const parts = await Promise.all(
      tilesOf(cx, cy).map(async (t) => {
        if (CACHE === "per-tile" && cache.has(t)) return cache.get(t)!;
        const ps = itemsOf<Pin>(await api(`/api/pins?tile=${t}&limit=20`));
        cache.set(t, ps);
        return ps;
      }),
    );
    if (VIEWPORT_SEQ === "latest" && my !== seq) return;
    const all = parts.flat();
    map.update((m) => {
      const pins = visible(m, VIEWPORT_SEQ === "latest" ? all : [...m.pins.filter((p) => !all.some((q) => q.id === p.id)), ...all]);
      return { ...m, pins, clustered: pins.length, loading: my === seq ? false : m.loading };
    });
  } catch (e) {
    if (my === seq) map.update((m) => ({ ...m, loading: false, error: errText(e, "loading the map") }));
  }
}
function pan(dx: number, dy: number) {
  map.update((m) => ({ ...m, cx: Math.max(0, Math.min(2, m.cx + dx)), cy: Math.max(0, Math.min(2, m.cy + dy)), open: "" }));
  void loadView();
}
function setCategory(category: string) {
  map.update((m) => ({ ...m, category }));
  void loadView();
}

async function addPin() {
  const m0 = map.get();
  if (ADD_GUARD && m0.adding) return;
  const name = m0.draft.trim();
  if (!name) return;
  map.update((m) => ({ ...m, adding: true, error: "", notice: "" }));
  const tile = `${m0.cx}-${m0.cy}`;
  try {
    const pin = await api<Pin>(`/api/pins`, "POST", { tile, x: m0.cx * 100 + 50, y: m0.cy * 100 + 50, category: m0.category === "all" ? "market" : m0.category, name });
    cache.delete(tile);
    map.update((m) => {
      if (m.cx !== m0.cx || m.cy !== m0.cy) return { ...m, notice: `Added “${pin.name}”.` };
      const pins = visible(m, [...m.pins, pin]);
      return { ...m, pins, clustered: CLUSTER_COUNT === "derive" ? pins.length : m.clustered + 1, draft: "", notice: `Added “${pin.name}”.` };
    });
  } catch (e) {
    map.update((m) => ({ ...m, error: errText(e, "adding the pin") }));
  } finally {
    map.update((m) => ({ ...m, adding: false }));
  }
}

function clusters(ps: Pin[]) {
  const by = new Map<string, Pin[]>();
  for (const p of ps) {
    const k = `${Math.floor(p.x / 50)}:${Math.floor(p.y / 50)}`;
    by.set(k, [...(by.get(k) ?? []), p]);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

function App() {
  const m = sig.value;
  return (
    <div class="mapapp">
      <h1>Neighbourhood map</h1>
      <p class="viewport">Tiles {m.cx}-{m.cy} to {m.cx + 1}-{m.cy + 1} · {m.clustered} pins {m.loading && "· loading…"}</p>
      <nav class="pan"><button onClick={() => pan(0, -1)}>North</button> <button onClick={() => pan(-1, 0)}>West</button> <button onClick={() => pan(1, 0)}>East</button> <button onClick={() => pan(0, 1)}>South</button></nav>
      <label>Show <select name="category" value={m.category} onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}>{["all", "cafe", "park", "museum", "market"].map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
      {m.error ? <p role="alert">{m.error}</p> : m.notice ? <p class="notice">{m.notice}</p> : null}
      <ul class="clusters">
        {clusters(m.pins).map(([k, ps]) => (
          <li key={k} class="cluster">
            Cell {k}: {ps.length} place(s) <button class="expand" onClick={() => map.update((x) => ({ ...x, open: x.open === k ? "" : k }))}>{m.open === k ? "Hide" : "Show"}</button>
            {m.open === k && <ul>{ps.map((p) => <li key={p.id} class="pin">{p.name} ({p.category})</li>)}</ul>}
          </li>
        ))}
      </ul>
      <form class="add-pin" onSubmit={(e) => { e.preventDefault(); void addPin(); }}>
        <input name="pinName" placeholder="Name a place" value={m.draft} onInput={(e) => map.update((x) => ({ ...x, draft: (e.target as HTMLInputElement).value }))} />{" "}
        <button type="submit" disabled={ADD_GUARD && m.adding}>Add pin here</button>
      </form>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
void loadView();
setInterval(() => {
  for (const t of tilesOf(map.get().cx, map.get().cy)) cache.delete(t);
  void loadView();
}, 8000);
