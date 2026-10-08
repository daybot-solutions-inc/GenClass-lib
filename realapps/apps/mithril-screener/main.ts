// Stock screener with a watchlist (Mithril 2 hyperscript + m.request over XHR; state in runtime atoms, m.redraw on
// change). Screens re-query on every filter change; the watchlist's quotes refresh on a timer. No trading. Latent
// bugs by flag: screen responses applied in arrival order (screenSeq=blind: the table shows another sector),
// watch buttons live while the add posts (watchGuard=none: the duplicate answers 409), optimistic watch/unwatch
// without rollback (watchSave=optimistic) and quote polling on setInterval (quotePoll=interval: slow polls overlap).
import m from "mithril";
import { rt, flag } from "../_shared/genclass";

type Stock = { id: number; symbol: string; name: string; sector: string; price: number; pe: number; change: number };
type Watch = { id: number; symbol: string };
const SCREEN_SEQ = flag("screenSeq", "latest");
const WATCH_GUARD = flag("watchGuard", "pending") === "pending";
const WATCH_SAVE = flag("watchSave", "wait");
const QUOTE_POLL = flag("quotePoll", "chain");
const POLL_MS = Number(flag("pollMs", 3000));

const screen = rt.atom("screen", { sector: "all", sort: "pe", q: "", rows: [] as Stock[], loading: true, error: "" });
const watch = rt.atom("watch", { items: [] as Watch[], quotes: {} as Record<string, number>, pending: [] as string[], error: "", notice: "" });
screen.subscribe(() => m.redraw());
watch.subscribe(() => m.redraw());
const status = (e: any) => Number(e?.code ?? 0);

let seq = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;
async function runScreen(patch: Partial<ReturnType<typeof screen.get>> = {}) {
  const my = ++seq;
  screen.update((s) => ({ ...s, ...patch, loading: true, error: "" }));
  const { sector, sort, q } = screen.get();
  const params: Record<string, string> = { sort, limit: "30" };
  if (sector !== "all") params.sector = sector;
  if (q.trim()) params.q = q.trim();
  try {
    const body = await m.request<{ items: Stock[] }>({ url: "/api/stocks", params, background: true });
    if (SCREEN_SEQ === "latest" && my !== seq) return;
    screen.update((s) => ({ ...s, rows: body.items ?? [], loading: false }));
  } catch (e) {
    if (my === seq) screen.update((s) => ({ ...s, loading: false, error: `The screen could not run (${status(e) || "offline"}).` }));
  }
}

const pend = (sym: string, on: boolean) => watch.update((w) => ({ ...w, pending: on ? [...w.pending, sym] : w.pending.filter((x) => x !== sym) }));
async function add(sym: string) {
  const w0 = watch.get();
  if (WATCH_GUARD && w0.pending.includes(sym)) return;
  if (w0.items.some((x) => x.symbol === sym && x.id > 0)) return;
  pend(sym, true);
  if (WATCH_SAVE !== "wait") watch.update((w) => ({ ...w, items: [...w.items, { id: -1, symbol: sym }] }));
  try {
    const saved = await m.request<Watch>({ method: "POST", url: "/api/watchlist", body: { symbol: sym }, background: true });
    watch.update((w) => ({ ...w, items: [...w.items.filter((x) => x.symbol !== sym), saved], notice: `${sym} added to your watchlist.`, error: "" }));
    void quotes();
  } catch (e) {
    watch.update((w) => ({ ...w, items: WATCH_SAVE === "optimistic" ? w.items : w.items.filter((x) => !(x.symbol === sym && x.id < 0)), error: status(e) === 409 ? `${sym} is already on your watchlist.` : `Could not add ${sym} (${status(e) || "offline"}).` }));
  } finally {
    pend(sym, false);
  }
}
async function remove(it: Watch) {
  if (WATCH_GUARD && watch.get().pending.includes(it.symbol)) return;
  pend(it.symbol, true);
  if (WATCH_SAVE !== "wait") watch.update((w) => ({ ...w, items: w.items.filter((x) => x.id !== it.id) }));
  try {
    await m.request({ method: "DELETE", url: `/api/watchlist/${it.id}`, background: true });
    watch.update((w) => ({ ...w, items: w.items.filter((x) => x.id !== it.id), notice: `${it.symbol} removed.`, error: "" }));
  } catch (e) {
    watch.update((w) => ({ ...w, items: WATCH_SAVE === "optimistic-rollback" && !w.items.some((x) => x.id === it.id) ? [...w.items, it] : w.items, error: `Could not remove ${it.symbol} (${status(e) || "offline"}).` }));
  } finally {
    pend(it.symbol, false);
  }
}

async function quotes() {
  const syms = watch.get().items.filter((x) => x.id > 0).map((x) => x.symbol);
  if (!syms.length) return;
  try {
    const body = await m.request<{ items: Stock[] }>({ url: "/api/stocks", params: { limit: 30 }, background: true });
    const q: Record<string, number> = {};
    for (const s of body.items ?? []) if (syms.includes(s.symbol)) q[s.symbol] = s.price;
    watch.update((w) => ({ ...w, quotes: { ...w.quotes, ...q } }));
  } catch {
    /* keep the last quotes */
  }
}

const opt = (v: string, l: string, cur: string) => m("option", { value: v, selected: v === cur }, l);
const App = {
  view() {
    const s = screen.get();
    const w = watch.get();
    const watched = new Set(w.items.map((x) => x.symbol));
    return m(".screener", [
      m("h1", "Screener"),
      m(".filters", [
        m("label", ["Sector ", m("select[name=sector]", { onchange: (e: Event) => void runScreen({ sector: (e.target as HTMLSelectElement).value }) }, ["all", "tech", "energy", "health", "finance", "consumer"].map((x) => opt(x, x, s.sector)))]),
        m("label", ["Sort ", m("select[name=sort]", { onchange: (e: Event) => void runScreen({ sort: (e.target as HTMLSelectElement).value }) }, [opt("pe", "P/E", s.sort), opt("-price", "Price ↓", s.sort), opt("-change", "Change ↓", s.sort), opt("symbol", "Symbol", s.sort)])]),
        m("input[name=q][placeholder=Symbol or name]", {
          value: s.q,
          oninput: (e: Event) => {
            const q = (e.target as HTMLInputElement).value;
            screen.update((x) => ({ ...x, q }));
            clearTimeout(debounce);
            debounce = setTimeout(() => void runScreen(), 300);
          },
        }),
        s.loading ? m("span.muted", " Screening…") : null,
      ]),
      s.error ? m("p[role=alert]", s.error) : null,
      m("table", m("tbody", s.rows.map((r) => m("tr.stock", { key: r.id }, [m("td", r.symbol), m("td", r.name), m("td", r.sector), m("td", r.price.toFixed(2)), m("td", `P/E ${r.pe}`), m("td", `${r.change > 0 ? "+" : ""}${r.change}%`), m("td", watched.has(r.symbol) ? m("em", "Watching") : m("button.watch", { disabled: WATCH_GUARD && w.pending.includes(r.symbol), onclick: () => void add(r.symbol) }, "Watch"))])))),
      m("aside.watchlist", [
        m("h2", `Watchlist (${w.items.length})`),
        w.error ? m("p[role=alert]", w.error) : w.notice ? m("p.notice", w.notice) : null,
        m("ul", w.items.map((it) => m("li.watched", { key: it.symbol }, [`${it.symbol} ${w.quotes[it.symbol] !== undefined ? w.quotes[it.symbol]!.toFixed(2) : "…"} `, it.id > 0 ? m("button.unwatch", { onclick: () => void remove(it) }, "Remove") : m("em", "saving…")]))),
      ]),
    ]);
  },
};

m.mount(document.getElementById("app")!, App);
void runScreen();
(async () => {
  try {
    const items = await m.request<Watch[]>({ url: "/api/watchlist", background: true });
    watch.update((w) => ({ ...w, items: Array.isArray(items) ? items : [] }));
  } catch {
    watch.update((w) => ({ ...w, error: "Your watchlist could not be loaded." }));
  }
  if (QUOTE_POLL === "interval") setInterval(() => void quotes(), POLL_MS);
  else {
    const loop = async () => {
      await quotes();
      setTimeout(loop, POLL_MS);
    };
    void loop();
  }
})();
