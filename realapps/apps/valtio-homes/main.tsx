// Home listings with infinite "Load more" and saved homes (React 19 + Valtio proxy state read with useSnapshot;
// axios). The proxy is registered with rt.guard: async results are written through the guarded handle, the filter
// selects mutate the proxy directly. Listings come newest first in offset pages, so a home listed while you scroll
// shifts every later page by one. Saving a home is optimistic (heart fills at once, POST /favorites; DELETE to unsave).
// Latent bugs by flag: pages appended without checking ids (append=blind: the shifted page repeats a home), a Load
// more button that stays live while a page loads (moreGuard=none: the same offset is fetched twice), filter changes
// that don't retire in-flight pages (filterSeq=blind: a Toronto page lands in the Ottawa list), saves not rolled
// back when they fail (fav=optimistic), hearts clickable while their save posts (favGuard=none: the second click
// DELETEs the temporary id) and a saved counter kept by hand that a rollback forgets (favCount=incremental).
import { createRoot } from "react-dom/client";
import axios from "axios";
import { proxy, snapshot, subscribe, useSnapshot } from "valtio";
import { rt, flag } from "../_shared/genclass";

type Listing = { id: number; title: string; city: string; beds: number; price: number; sqft: number; listedAt: number };
type Fav = { id: number; listingId: number };
interface Homes {
  city: string;
  beds: string;
  items: Listing[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  favs: Record<string, number>;
  favCount: number;
  pending: number[];
  error: string;
  notice: string;
}

const APPEND = flag("append", "dedupe");
const MORE_GUARD = flag("moreGuard", "pending") === "pending";
const FILTER_SEQ = flag("filterSeq", "latest");
const FAV = flag("fav", "rollback");
const FAV_GUARD = flag("favGuard", "pending") === "pending";
const FAV_COUNT = flag("favCount", "derive");
const PAGE = 6;

const state = proxy<Homes>({ city: "all", beds: "any", items: [], total: 0, loading: true, loadingMore: false, favs: {}, favCount: 0, pending: [], error: "", notice: "" });
const homes = rt.guard<Homes>("homes", {
  get: () => snapshot(state) as Homes,
  set: (v) => void Object.assign(state, structuredClone(v)),
  subscribe: (fn) => subscribe(state, () => fn()),
});
/** Mutate a copy of the current state and write it through GenClass. */
const commit = (fn: (d: Homes) => void) =>
  homes.update((s) => {
    const d = structuredClone(s) as Homes;
    fn(d);
    return d;
  });
const http = axios.create({ baseURL: "/api", timeout: 10000 });
const status = (e: unknown) => (axios.isAxiosError(e) ? (e.response?.status ?? 0) : 0);
const why = (e: unknown, what: string) => (status(e) ? `${what} failed (${status(e)}).` : `Network problem — ${what} did not go through.`);
const money = (n: number) => `$${n.toLocaleString("en-US")}`;
const setCount = (d: Homes) => {
  if (FAV_COUNT === "derive") d.favCount = Object.keys(d.favs).length;
};

// ------------------------------------------------------------------------------------------- listings
let gen = 0;
async function query(reset: boolean) {
  const s = homes.get();
  if (!reset && MORE_GUARD && (s.loadingMore || s.loading)) return;
  const my = reset ? ++gen : gen;
  const params: Record<string, string | number> = { sort: "-listedAt", offset: reset ? 0 : s.items.length, limit: PAGE };
  if (s.city !== "all") params.city = s.city;
  if (s.beds !== "any") params.beds = s.beds;
  commit((d) => {
    if (reset) d.loading = true;
    else d.loadingMore = true;
    d.error = "";
  });
  try {
    const { data } = await http.get<{ data: Listing[]; meta: { total: number } }>("/listings", { params });
    if (FILTER_SEQ === "latest" && my !== gen) return;
    const page = Array.isArray(data?.data) ? data.data : [];
    commit((d) => {
      if (reset) d.items = page;
      else if (APPEND === "dedupe") d.items.push(...page.filter((p) => !d.items.some((i) => i.id === p.id)));
      else d.items.push(...page);
      d.total = Number(data?.meta?.total ?? d.total);
      d.loading = false;
      d.loadingMore = false;
    });
  } catch (e) {
    if (my === gen)
      commit((d) => {
        d.loading = false;
        d.loadingMore = false;
        d.error = why(e, reset ? "Loading homes" : "Loading more homes");
      });
  }
}

function pickFilter(key: "city" | "beds", value: string) {
  state[key] = value;
  state.notice = "";
  void query(true);
}

// ------------------------------------------------------------------------------------------- saved homes
let tmp = 0;
async function toggleFav(l: Listing) {
  const s = homes.get();
  if (FAV_GUARD && s.pending.includes(l.id)) return;
  const favId = s.favs[l.id];
  commit((d) => {
    d.pending.push(l.id);
    d.error = "";
    if (favId) delete d.favs[l.id];
    else d.favs[l.id] = --tmp;
    if (FAV_COUNT === "incremental") d.favCount += favId ? -1 : 1;
    setCount(d);
  });
  try {
    if (favId) {
      await http.delete(`/favorites/${favId}`);
      commit((d) => void (d.notice = `Removed “${l.title}” from saved homes.`));
    } else {
      const { data } = await http.post<Fav>("/favorites", { listingId: l.id });
      commit((d) => {
        if (d.favs[l.id] !== undefined) d.favs[l.id] = data.id;
        d.notice = `Saved “${l.title}”.`;
      });
    }
  } catch (e) {
    commit((d) => {
      if (FAV === "rollback") {
        if (favId) d.favs[l.id] = favId;
        else delete d.favs[l.id];
        setCount(d);
      }
      d.error = status(e) === 409 ? `“${l.title}” is already saved.` : why(e, favId ? "Unsaving the home" : "Saving the home");
    });
  } finally {
    commit((d) => void (d.pending = d.pending.filter((x) => x !== l.id)));
  }
}

async function loadFavs() {
  try {
    const { data } = await http.get<{ data: Fav[] }>("/favorites", { params: { limit: 50 } });
    const list = Array.isArray(data?.data) ? data.data : [];
    commit((d) => {
      // saves in flight keep their local heart
      const favs: Record<string, number> = {};
      for (const f of list) favs[f.listingId] = f.id;
      for (const id of d.pending) {
        if (d.favs[id] !== undefined) favs[id] = d.favs[id]!;
        else delete favs[id];
      }
      d.favs = favs;
      d.favCount = Object.keys(favs).length;
    });
  } catch {
    /* keep the hearts we have */
  }
}

// ------------------------------------------------------------------------------------------- view
function App() {
  const s = useSnapshot(state);
  return (
    <main className="homes">
      <h1>Homes for sale</h1>
      <div className="filters">
        <label>
          City{" "}
          <select name="city" value={s.city} onChange={(e) => pickFilter("city", e.target.value)}>
            {["all", "Toronto", "Ottawa", "Montreal", "Waterloo"].map((c) => (
              <option key={c} value={c}>
                {c === "all" ? "All cities" : c}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Bedrooms{" "}
          <select name="beds" value={s.beds} onChange={(e) => pickFilter("beds", e.target.value)}>
            {["any", "1", "2", "3", "4"].map((b) => (
              <option key={b} value={b}>
                {b === "any" ? "Any" : `${b} bd`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="summary">
        {s.loading ? "Searching…" : `Showing ${s.items.length} of ${s.total} homes`} · ♥ {s.favCount} saved
      </p>
      {s.error ? <p role="alert">{s.error}</p> : s.notice ? <p className="notice">{s.notice}</p> : null}
      <ul className="listings">
        {s.items.map((l, i) => {
          const saved = s.favs[l.id] !== undefined;
          return (
            <li className="listing" key={`${l.id}-${i}`}>
              {l.title} · {l.city} · {l.sqft} sq ft · {money(l.price)}{" "}
              <button type="button" className="fav" aria-pressed={saved} disabled={FAV_GUARD && s.pending.includes(l.id)} onClick={() => void toggleFav(l as Listing)}>
                {saved ? "♥ Saved" : "♡ Save"}
              </button>
            </li>
          );
        })}
      </ul>
      {!s.loading && s.items.length < s.total ? (
        <button type="button" className="more" disabled={MORE_GUARD && s.loadingMore} onClick={() => void query(false)}>
          {s.loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
void query(true);
void loadFavs();
setInterval(() => void loadFavs(), 8000);
