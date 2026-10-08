// Product search typeahead (React 19 + runtime-backed state via useGenClassState). Latent bug (flag guard=none):
// responses are applied in arrival order, so a slow response for an older query can overwrite newer results.
import { createRoot } from "react-dom/client";
import { useEffect, useRef } from "react";
import { useGenClassState } from "@genclass/runtime/react";
import { flag } from "../_shared/genclass";

type Product = { id: number; name: string; price: number; category: string; stock: number };
const GUARD = flag("guard", "none") as "none" | "abort" | "reqid";
const DEBOUNCE = Number(flag("debounce", 0));
const MIN_LEN = Number(flag("minLen", 1));

function Search() {
  const [s, setS] = useGenClassState("search", { query: "", category: "all", results: [] as Product[], total: 0, loading: false, error: "" });
  const reqId = useRef(0);
  const ctl = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = (query: string, category: string) => {
    if (query.trim().length < MIN_LEN) {
      setS((p) => ({ ...p, results: [], total: 0, loading: false }));
      return;
    }
    const id = ++reqId.current;
    if (GUARD === "abort") ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setS((p) => ({ ...p, loading: true, error: "" }));
    const qs = new URLSearchParams({ q: query });
    if (category !== "all") qs.set("category", category);
    fetch(`/api/products?${qs}`, GUARD === "abort" ? { signal: c.signal } : undefined)
      .then((r) => {
        if (!r.ok) throw new Error(`Search failed (${r.status})`);
        return r.json();
      })
      .then((data: { items: Product[]; total: number }) => {
        if (GUARD === "reqid" && id !== reqId.current) return;
        setS((p) => ({ ...p, results: data.items, total: data.total, loading: false }));
      })
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        if (GUARD === "reqid" && id !== reqId.current) return;
        setS((p) => ({ ...p, loading: false, error: e.message }));
      });
  };

  const onQuery = (q: string) => {
    setS((p) => ({ ...p, query: q }));
    if (DEBOUNCE > 0) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => run(q, s.category), DEBOUNCE);
    } else run(q, s.category);
  };

  return (
    <section>
      <h1>Shop</h1>
      <label>
        Search <input name="q" value={s.query} onChange={(e) => onQuery(e.target.value)} placeholder="Search products" />
      </label>
      <label>
        Category{" "}
        <select name="category" value={s.category} onChange={(e) => { const c = e.target.value; setS((p) => ({ ...p, category: c })); run(s.query, c); }}>
          <option value="all">all</option>
          <option value="home">home</option>
          <option value="office">office</option>
          <option value="garden">garden</option>
        </select>
      </label>
      {s.loading && <p className="loading">Loading…</p>}
      {s.error && <p role="alert">{s.error}</p>}
      <p className="count">{s.total} results</p>
      <ul>
        {s.results.map((p) => (
          <li key={p.id} className="result">
            {p.name} — ${p.price} <button className="details" onClick={() => openDetail(p.id)}>Details</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

let openDetail: (id: number) => void = () => undefined;

function Detail() {
  const [d, setD] = useGenClassState("detail", { id: 0, item: null as Product | null, loading: false, error: "" });
  openDetail = (id: number) => {
    setD({ id, item: null, loading: true, error: "" });
    fetch(`/api/products/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Could not load product (${r.status})`))))
      .then((item: Product) => setD((p) => ({ ...p, item, loading: false })))
      .catch((e: Error) => setD((p) => ({ ...p, loading: false, error: e.message })));
  };
  useEffect(() => undefined, []);
  if (!d.id) return null;
  return (
    <aside>
      {d.loading && <p>Loading product…</p>}
      {d.error && <p role="alert">{d.error}</p>}
      {d.item && (
        <div className="detail">
          <h2>{d.item.name}</h2>
          <p>${d.item.price} · {d.item.stock} in stock</p>
        </div>
      )}
      <button className="close" onClick={() => setD({ id: 0, item: null, loading: false, error: "" })}>Close</button>
    </aside>
  );
}

createRoot(document.getElementById("app")!).render(
  <>
    <Search />
    <Detail />
  </>,
);
