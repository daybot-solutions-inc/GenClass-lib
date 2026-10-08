// Stock watchlist (React 19 + MobX 6 + mobx-react-lite observers, fetch). Quotes are polled; the portfolio's total
// value is a field the code maintains (not a computed). The MobX store is registered with rt.guard: async writes
// go through the guarded atom, form typing writes the MobX store directly (traced only). Latent bugs by flag:
// overlapping polls whose late responses overwrite newer prices (overlap=none), total value not recomputed on one
// path (total=skip-on-*), double adds (addGuard=none), out-of-order share echoes (echo=apply).
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { observable, runInAction, reaction, toJS, comparer } from "mobx";
import { observer } from "mobx-react-lite";
import { rt, flag } from "../_shared/genclass";

type Holding = { id: number; symbol: string; shares: number };
type Quote = { id: number; symbol: string; price: number };
const OVERLAP = flag("overlap", "skip") as "skip" | "none" | "abort";
const POLL_MS = Number(flag("pollMs", 3000));
const TOTAL = flag("total", "recompute") as "recompute" | "skip-on-remove" | "skip-on-add";
const ADD_GUARD = flag("addGuard", "disable") as "disable" | "none";
const ECHO = flag("echo", "ignore-stale") as "ignore-stale" | "apply";

const store = observable({
  holdings: [] as Holding[],
  quotes: {} as Record<string, number>,
  totalValue: 0,
  polling: false,
  symbolDraft: "",
  sharesDraft: "10",
  adding: false,
  busy: [] as number[],
  error: "",
});
type Portfolio = ReturnType<typeof toJS<typeof store>>;

const portfolio = rt.guard<Portfolio>("portfolio", {
  get: () => toJS(store),
  set: (v) => runInAction(() => Object.assign(store, v)),
  subscribe: (fn) => reaction(() => toJS(store), () => fn(), { equals: comparer.structural }),
});

const valueOf = (hs: Holding[], q: Record<string, number>) => Math.round(hs.reduce((a, h) => a + h.shares * (q[h.symbol] ?? 0), 0) * 100) / 100;

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

// ---------------------------------------------------------------------------------------------- polling
let pollInFlight = false;
let pollCtl: AbortController | null = null;

async function pollQuotes() {
  if (OVERLAP === "skip" && pollInFlight) return;
  if (OVERLAP === "abort") pollCtl?.abort();
  const ctl = new AbortController();
  pollCtl = ctl;
  pollInFlight = true;
  portfolio.update((p) => ({ ...p, polling: true }));
  try {
    const list = await json<Quote[]>("/api/quotes", OVERLAP === "abort" ? { signal: ctl.signal } : undefined);
    const quotes: Record<string, number> = {};
    for (const q of list) quotes[q.symbol] = q.price;
    portfolio.update((p) => ({ ...p, quotes, totalValue: valueOf(p.holdings, quotes), polling: false, error: p.error.startsWith("Quotes") ? "" : p.error }));
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    portfolio.update((p) => ({ ...p, polling: false, error: "Quotes are delayed" }));
  } finally {
    if (pollCtl === ctl) pollInFlight = false;
  }
}

async function loadHoldings() {
  try {
    const r = await json<{ items: Holding[] }>("/api/holdings");
    portfolio.update((p) => ({ ...p, holdings: r.items, totalValue: valueOf(r.items, p.quotes) }));
  } catch {
    portfolio.update((p) => ({ ...p, error: "Could not load your watchlist" }));
  }
}

// ---------------------------------------------------------------------------------------------- actions
async function addHolding() {
  const symbol = store.symbolDraft.trim().toUpperCase();
  const shares = Number(store.sharesDraft) || 0;
  if (!symbol || shares <= 0) return;
  if (ADD_GUARD === "disable" && store.adding) return;
  if (store.holdings.some((h) => h.symbol === symbol)) {
    runInAction(() => (store.error = `${symbol} is already on your watchlist`));
    return;
  }
  runInAction(() => {
    store.adding = true;
    store.error = "";
  });
  try {
    const h = await json<Holding>("/api/holdings", { method: "POST", body: JSON.stringify({ symbol, shares }) });
    portfolio.update((p) => {
      const holdings = [...p.holdings, h];
      return { ...p, holdings, totalValue: TOTAL === "skip-on-add" ? p.totalValue : valueOf(holdings, p.quotes), adding: false, symbolDraft: p.symbolDraft.trim().toUpperCase() === symbol ? "" : p.symbolDraft };
    });
  } catch {
    portfolio.update((p) => ({ ...p, adding: false, error: `Could not add ${symbol}` }));
  }
}

const latestShareReq = new Map<number, number>();
let shareReq = 0;

async function changeShares(id: number, delta: number) {
  const h = store.holdings.find((x) => x.id === id);
  if (!h || h.shares + delta < 0) return;
  const next = h.shares + delta;
  const req = ++shareReq;
  latestShareReq.set(id, req);
  runInAction(() => {
    h.shares = next;
    store.totalValue = valueOf(store.holdings, store.quotes);
  });
  try {
    const saved = await json<Holding>(`/api/holdings/${id}`, { method: "PATCH", body: JSON.stringify({ shares: next }) });
    if (ECHO === "ignore-stale" && latestShareReq.get(id) !== req) return;
    portfolio.update((p) => {
      const holdings = p.holdings.map((x) => (x.id === id ? { ...x, shares: saved.shares } : x));
      return { ...p, holdings, totalValue: valueOf(holdings, p.quotes) };
    });
  } catch {
    if (latestShareReq.get(id) !== req) return;
    portfolio.update((p) => {
      const holdings = p.holdings.map((x) => (x.id === id ? { ...x, shares: x.shares - delta } : x));
      return { ...p, holdings, totalValue: valueOf(holdings, p.quotes), error: `Could not update ${h.symbol}` };
    });
  }
}

async function removeHolding(id: number) {
  if (store.busy.includes(id)) return;
  runInAction(() => store.busy.push(id));
  try {
    const r = await fetch(`/api/holdings/${id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
    portfolio.update((p) => {
      const holdings = p.holdings.filter((x) => x.id !== id);
      return { ...p, holdings, totalValue: TOTAL === "skip-on-remove" ? p.totalValue : valueOf(holdings, p.quotes), busy: p.busy.filter((x) => x !== id) };
    });
  } catch {
    portfolio.update((p) => ({ ...p, busy: p.busy.filter((x) => x !== id), error: "Could not remove the position" }));
  }
}

// --------------------------------------------------------------------------------------------------- UI
const Watchlist = observer(function Watchlist() {
  useEffect(() => {
    void pollQuotes().then(loadHoldings);
    const h = setInterval(() => void pollQuotes(), POLL_MS);
    return () => clearInterval(h);
  }, []);
  return (
    <main className="portfolio">
      <header>
        <h1>Watchlist</h1>
        <p className="total">Total value ${store.totalValue.toFixed(2)}</p>
        <button className="refresh-quotes" onClick={() => void pollQuotes()}>
          {store.polling ? "Updating…" : "Refresh quotes"}
        </button>
      </header>
      {store.error && <p role="alert">{store.error}</p>}
      <table>
        <tbody>
          {store.holdings.map((h) => (
            <tr key={h.id} className="holding">
              <td>{h.symbol}</td>
              <td>{h.shares} sh</td>
              <td>${(store.quotes[h.symbol] ?? 0).toFixed(2)}</td>
              <td>${(h.shares * (store.quotes[h.symbol] ?? 0)).toFixed(2)}</td>
              <td>
                <button className="buy" onClick={() => void changeShares(h.id, 1)}>
                  +1
                </button>
                <button className="sell" onClick={() => void changeShares(h.id, -1)}>
                  −1
                </button>
                <button className="remove" disabled={store.busy.includes(h.id)} onClick={() => void removeHolding(h.id)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void addHolding();
        }}
      >
        <input name="symbol" value={store.symbolDraft} onChange={(e) => runInAction(() => (store.symbolDraft = e.target.value))} placeholder="Symbol" aria-label="Symbol" />
        <input name="shares" type="number" value={store.sharesDraft} onChange={(e) => runInAction(() => (store.sharesDraft = e.target.value))} aria-label="Shares" />
        <button className="add-holding" type="submit" disabled={ADD_GUARD === "disable" && store.adding}>
          {store.adding ? "Adding…" : "Add"}
        </button>
      </form>
    </main>
  );
});

createRoot(document.getElementById("app")!).render(<Watchlist />);
