// Team lunch group order (React 19 + Jotai atoms in an explicit store; fetch + one WebSocket for two topics). The
// organiser (Priya) runs today's order from one restaurant: the order doc (restaurant, cutoff, open/locked, versioned)
// and the order lines are shared and live — colleagues add dishes and change their quantities from their own screens.
// Priya adds dishes for herself (POST /lines, or +1 on her existing line), fixes anyone's quantity with − / +
// (POST /lines/:id/inc|dec, relative; still allowed once locked), removes lines and locks the order against new dishes
// (versioned PATCH of the doc; reopen the same way). The lunch atom is registered with rt.guard (server results and
// pushes are written through it; clicks write the Jotai store directly). Item count and total are maintained next to
// the lines. Latent bugs by flag: quantities written as
// absolute values computed from the row that was clicked (qty=absolute-put: a colleague's change — or the previous
// click of a quick double +1 — is overwritten), the POST answer appended without looking for its WS echo
// (add=append: the new line shows twice), count/total adjusted by deltas in every handler (total=incremental: the
// HTTP answer and the echo both count the same change), locking without the doc version (lock=force: a cutoff change
// made meanwhile is locked in unseen) and reconnects that don't reload what was missed (reconnect=naive).
import { createRoot } from "react-dom/client";
import { atom, createStore, Provider, useAtomValue } from "jotai";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Dish = { id: number; name: string; price: number; tag: string };
type Line = { id: number; person: string; item: string; price: number; qty: number; updatedAt?: string };
type OrderDoc = { restaurant: string; cutoff: string; status: "open" | "locked"; organiser: string; note: string; version: number };
interface Lunch {
  doc: OrderDoc | null;
  menu: Dish[];
  lines: Line[];
  count: number;
  total: number;
  perPerson: Record<string, number>;
  adding: number[];
  locking: boolean;
  live: boolean;
  error: string;
  notice: string;
}
type Delta = { total: number; count: number };

const QTY = flag("qty", "relative");
const ADD = flag("add", "reconcile");
const TOTAL = flag("total", "derive");
const LOCK = flag("lock", "if-match");
const RECONNECT = flag("reconnect", "resync");
const ME = "Priya";

const store = createStore();
const lunchAtom = atom<Lunch>({ doc: null, menu: [], lines: [], count: 0, total: 0, perPerson: {}, adding: [], locking: false, live: false, error: "", notice: "" });
const lunch = rt.guard<Lunch>("lunch", { get: () => store.get(lunchAtom), set: (v) => store.set(lunchAtom, v), subscribe: (fn) => store.sub(lunchAtom, fn) });
const cents = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toFixed(2)}`;
const sortLines = (ls: Line[]) => [...ls].sort((a, b) => a.person.localeCompare(b.person) || a.item.localeCompare(b.item) || a.id - b.id);

function sums(ls: Line[]) {
  const perPerson: Record<string, number> = {};
  for (const l of ls) perPerson[l.person] = (perPerson[l.person] ?? 0) + l.qty;
  return { count: ls.reduce((a, l) => a + l.qty, 0), total: cents(ls.reduce((a, l) => a + l.qty * l.price, 0)), perPerson };
}
/** New lines; count/total recomputed (derive, or a full load) or adjusted by the change the caller saw. */
function withLines(l: Lunch, lines: Line[], delta?: Delta): Lunch {
  const sorted = sortLines(lines);
  const s = sums(sorted);
  if (TOTAL === "derive" || !delta) return { ...l, lines: sorted, ...s };
  return { ...l, lines: sorted, perPerson: s.perPerson, count: l.count + delta.count, total: cents(l.total + delta.total) };
}
/** A line from the server (HTTP answer or push); `known` is the change an HTTP handler knows it made. */
function upsert(l: Lunch, line: Line, known?: Delta): Lunch {
  const cur = l.lines.find((x) => x.id === line.id);
  if (cur && String(line.updatedAt ?? "") < String(cur.updatedAt ?? "")) return l;
  const delta = known ?? { count: line.qty - (cur?.qty ?? 0), total: line.qty * line.price - (cur ? cur.qty * cur.price : 0) };
  return withLines(l, cur ? l.lines.map((x) => (x.id === line.id ? line : x)) : [...l.lines, line], delta);
}
function drop(l: Lunch, id: number, known?: Delta): Lunch {
  const cur = l.lines.find((x) => x.id === id);
  if (!cur && !known) return l;
  return withLines(l, l.lines.filter((x) => x.id !== id), known ?? { count: -cur!.qty, total: -cur!.qty * cur!.price });
}
const newerDoc = (d: OrderDoc, cur: OrderDoc | null) => (!cur || Number(d.version) >= Number(cur.version) ? d : cur);

// ------------------------------------------------------------------------------------------------ server
async function load() {
  try {
    const [doc, menu, lines] = await Promise.all([api<OrderDoc>("/api/docs/order"), api<Dish[]>("/api/menu?limit=50"), api("/api/lines?limit=100")]);
    lunch.update((x) => ({ ...withLines(x, itemsOf<Line>(lines)), doc: newerDoc(doc, x.doc), menu: itemsOf<Dish>(menu), error: "" }));
  } catch (e) {
    lunch.update((x) => ({ ...x, error: errText(e, "loading today's order") }));
    setTimeout(() => void load(), 3000);
  }
}

async function addDish(d: Dish) {
  const l = lunch.get();
  if (l.adding.includes(d.id) || l.doc?.status !== "open") return;
  const mine = l.lines.find((x) => x.person === ME && x.item === d.name);
  if (mine) return bump(mine, 1);
  store.set(lunchAtom, (x) => ({ ...x, adding: [...x.adding, d.id], error: "", notice: "" }));
  try {
    const saved = await api<Line>("/api/lines", "POST", { person: ME, item: d.name, price: d.price, qty: 1 });
    const known = { count: 1, total: d.price };
    lunch.update((x) => ({ ...(ADD === "append" ? withLines(x, [...x.lines, saved], known) : upsert(x, saved, known)), notice: `Added ${d.name} for ${ME}.` }));
  } catch (e) {
    lunch.update((x) => ({ ...x, error: errText(e, `adding ${d.name}`) }));
  } finally {
    lunch.update((x) => ({ ...x, adding: x.adding.filter((i) => i !== d.id) }));
  }
}

async function bump(line: Line, by: 1 | -1) {
  if (!lunch.get().doc) return;
  if (by < 0 && line.qty <= 1) return remove(line);
  store.set(lunchAtom, (x) => ({ ...x, error: "", notice: "" }));
  try {
    const saved =
      QTY === "absolute-put"
        ? await api<Line>(`/api/lines/${line.id}`, "PUT", { person: line.person, item: line.item, price: line.price, qty: line.qty + by })
        : await api<Line>(`/api/lines/${line.id}/${by > 0 ? "inc" : "dec"}`, "POST");
    lunch.update((x) => upsert(x, saved, { count: by, total: by * saved.price }));
  } catch (e) {
    const gone = e instanceof HttpError && e.status === 404;
    lunch.update((x) => ({ ...(gone ? drop(x, line.id) : x), error: gone ? `${line.person} already removed ${line.item}.` : errText(e, `changing ${line.person}'s ${line.item}`) }));
  }
}

async function remove(line: Line) {
  if (!lunch.get().doc) return;
  store.set(lunchAtom, (x) => ({ ...x, error: "", notice: "" }));
  try {
    await api(`/api/lines/${line.id}`, "DELETE");
    lunch.update((x) => ({ ...drop(x, line.id, { count: -line.qty, total: -line.qty * line.price }), notice: `Removed ${line.person}'s ${line.item}.` }));
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) lunch.update((x) => drop(x, line.id));
    else lunch.update((x) => ({ ...x, error: errText(e, `removing ${line.item}`) }));
  }
}

async function toggleLock() {
  const l = lunch.get();
  if (l.locking || !l.doc) return;
  const status = l.doc.status === "open" ? "locked" : "open";
  store.set(lunchAtom, (x) => ({ ...x, locking: true, error: "", notice: "" }));
  try {
    const doc = await api<OrderDoc>("/api/docs/order", "PATCH", LOCK === "force" ? { status } : { status, version: l.doc.version });
    lunch.update((x) => ({ ...x, doc: newerDoc(doc, x.doc), notice: status === "locked" ? `Order locked — ${x.count} items for ${doc.restaurant}, cutoff ${doc.cutoff}.` : "Order reopened for changes." }));
  } catch (e) {
    const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as OrderDoc | undefined) : undefined;
    lunch.update((x) => ({ ...x, doc: cur ? newerDoc(cur, x.doc) : x.doc, error: cur ? `The order changed meanwhile (cutoff ${cur.cutoff}) — check it and try again.` : errText(e, status === "locked" ? "locking the order" : "reopening the order") }));
  } finally {
    lunch.update((x) => ({ ...x, locking: false }));
  }
}

// --------------------------------------------------------------------------------------------------- live
let everUp = false;
function connect() {
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/lines?topics=docs/order`);
  ws.onopen = () => {
    lunch.update((x) => ({ ...x, live: true }));
    if (everUp && RECONNECT === "resync") void load();
    everUp = true;
  };
  ws.onmessage = (ev) => {
    let m: { type: string; doc?: string; collection?: string; id?: number; item?: unknown };
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (m.doc === "order" && m.item) lunch.update((x) => ({ ...x, doc: newerDoc(m.item as OrderDoc, x.doc) }));
    else if (m.collection === "lines" && m.type === "deleted") lunch.update((x) => drop(x, Number(m.id)));
    else if (m.collection === "lines" && m.item) lunch.update((x) => upsert(x, m.item as Line));
  };
  ws.onclose = () => {
    lunch.update((x) => ({ ...x, live: false }));
    setTimeout(connect, 2000);
  };
}

// ----------------------------------------------------------------------------------------------------- UI
function App() {
  const l = useAtomValue(lunchAtom);
  const open = l.doc?.status === "open";
  const people = Object.keys(l.perPerson).sort();
  return (
    <main className="lunch">
      <header>
        <h1>Team lunch{l.doc ? ` · ${l.doc.restaurant}` : ""}</h1>
        {l.doc && (
          <p className="meta">
            Order by {l.doc.cutoff} · {open ? "open for orders" : "locked: no new dishes, the organiser can still fix quantities"} · organised by {l.doc.organiser}
          </p>
        )}
        {l.doc?.note ? <p className="note">Note: {l.doc.note}</p> : null}
        <p className="totals">
          {l.count} items · {money(l.total)} · {people.length} people
        </p>
        <button type="button" className="lock" disabled={!l.doc || l.locking} onClick={() => void toggleLock()}>
          {l.locking ? "Saving…" : open ? "Lock order" : "Reopen order"}
        </button>{" "}
        <span className="conn">{l.live ? "live" : "reconnecting…"}</span>
      </header>
      {l.error ? <p role="alert">{l.error}</p> : l.notice ? <p className="notice">{l.notice}</p> : null}
      <section className="menu">
        <h2>Menu</h2>
        <ul>
          {l.menu.map((d) => (
            <li key={d.id} className="menu-item">
              <span className="dish">{d.name}</span> <span className="tag">({d.tag})</span> · {money(d.price)}{" "}
              <button type="button" className="add" disabled={!open || l.adding.includes(d.id)} onClick={() => void addDish(d)}>
                Add
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="order">
        <h2>Order</h2>
        <table>
          <tbody>
            {l.lines.map((x) => (
              <tr key={x.id} className="line">
                <td className="person">{x.person}</td>
                <td className="item">{x.item}</td>
                <td className="qty">×{x.qty}</td>
                <td className="price">{money(x.qty * x.price)}</td>
                <td>
                  <button type="button" className="dec" aria-label="One less" disabled={!l.doc} onClick={() => void bump(x, -1)}>
                    −
                  </button>
                  <button type="button" className="inc" aria-label="One more" disabled={!l.doc} onClick={() => void bump(x, 1)}>
                    +
                  </button>
                  <button type="button" className="remove" disabled={!l.doc} onClick={() => void remove(x)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="people">{people.map((p) => `${p} ${l.perPerson[p]}`).join(" · ")}</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(
  <Provider store={store}>
    <App />
  </Provider>,
);
connect();
void load();
