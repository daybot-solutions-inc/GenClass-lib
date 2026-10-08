// Trip planner (React 19 + Jotai). Activity search is an async atom (re-runs when the query or kind atom changes,
// shown through loadable); the itinerary lives in a primitive atom registered with rt.guard so the async code writes
// it through GenClass (UI selections write the Jotai store directly). The remaining budget is a derived atom over
// the maintained `spent` field. Co-travellers edit the same trip, so bookings are refreshed every 10 s.
// Latent bugs by flag: availability answers applied to whatever activity is selected now (checkGuard=none: the
// spots of an older check show for the newer pick), double bookings (bookGuard=none), `spent` maintained by deltas
// and not undone when a booking fails (spent=incremental), a refresh that started before an optimistic write lands
// over it (refresh=blind), searches not aborted (searchAbort=false).
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { atom, createStore, Provider, useAtom, useAtomValue, useSetAtom } from "jotai";
import { loadable } from "jotai/utils";
import { rt, flag } from "../_shared/genclass";

type Activity = { id: number; title: string; city: string; kind: string; price: number; spots: number };
type Booking = { id: number | string; activityId: number; day: number; title: string; price: number; pending?: boolean };
type Check = { activityId: number; title: string; price: number; spots: number | null; status: "idle" | "checking" | "ok" | "full" | "error" };
interface Trip {
  day: number;
  bookings: Booking[];
  spent: number;
  budget: number;
  check: Check;
  saving: number;
  syncing: boolean;
  error: string;
}

const CHECK_GUARD = flag("checkGuard", "latest") as "latest" | "none";
const BOOK_GUARD = flag("bookGuard", "disable") as "disable" | "none";
const SPENT = flag("spent", "recompute") as "recompute" | "incremental";
const REFRESH = flag("refresh", "skip-while-saving") as "skip-while-saving" | "blind";
const SEARCH_ABORT = Boolean(flag("searchAbort", true));
const DAYS = [1, 2, 3, 4];
const NO_CHECK: Check = { activityId: 0, title: "", price: 0, spots: null, status: "idle" };

const total = (bs: Booking[]) => bs.reduce((a, b) => a + b.price, 0);

// ------------------------------------------------------------------------------------------------ atoms
const store = createStore();
const tripAtom = atom<Trip>({ day: 1, bookings: [], spent: 0, budget: 600, check: NO_CHECK, saving: 0, syncing: false, error: "" });
const queryAtom = atom("");
const kindAtom = atom("all");
const remainingAtom = atom((get) => get(tripAtom).budget - get(tripAtom).spent);

const resultsAtom = atom(async (get, { signal }) => {
  const q = get(queryAtom).trim();
  const kind = get(kindAtom);
  const qs = new URLSearchParams({ limit: "8" });
  if (q) qs.set("q", q);
  if (kind !== "all") qs.set("kind", kind);
  const r = await fetch(`/api/activities?${qs}`, SEARCH_ABORT ? { signal } : {});
  if (!r.ok) throw new Error(`Search failed (${r.status})`);
  return ((await r.json()) as { items: Activity[] }).items;
});
const resultsLoadable = loadable(resultsAtom);

// The itinerary is registered with GenClass: async writes go through this handle.
const trip = rt.guard<Trip>("trip", {
  get: () => store.get(tripAtom),
  set: (v) => store.set(tripAtom, v),
  subscribe: (fn) => store.sub(tripAtom, fn),
});

/** New bookings with `spent` kept in step (recomputed, or adjusted by the change). */
function withBookings(t: Trip, bookings: Booking[], delta: number): Trip {
  return { ...t, bookings, spent: SPENT === "recompute" ? total(bookings) : t.spent + delta };
}

// ---------------------------------------------------------------------------------------------- effects
let seq = 0;
let writeSeq = 0;

async function refresh() {
  const started = writeSeq;
  trip.update((t) => ({ ...t, syncing: true }));
  try {
    const r = await fetch("/api/bookings?limit=100");
    if (!r.ok) throw new Error(String(r.status));
    const items = ((await r.json()) as { items: Booking[] }).items;
    if (REFRESH === "skip-while-saving" && (trip.get().saving > 0 || writeSeq !== started)) {
      trip.update((t) => ({ ...t, syncing: false }));
      return;
    }
    trip.update((t) => ({ ...t, bookings: items, spent: total(items), syncing: false, error: t.error.startsWith("Could not refresh") ? "" : t.error }));
  } catch {
    trip.update((t) => ({ ...t, syncing: false, error: "Could not refresh the itinerary" }));
  }
}

async function checkAvailability(a: Activity) {
  trip.update((t) => ({ ...t, check: { activityId: a.id, title: a.title, price: a.price, spots: null, status: "checking" } }));
  try {
    const r = await fetch(`/api/activities/${a.id}`);
    if (!r.ok) throw new Error(String(r.status));
    const fresh = (await r.json()) as Activity;
    if (CHECK_GUARD === "latest" && trip.get().check.activityId !== a.id) return;
    trip.update((t) => ({ ...t, check: { ...t.check, price: fresh.price, spots: fresh.spots, status: fresh.spots > 0 ? "ok" : "full" } }));
  } catch {
    if (CHECK_GUARD === "latest" && trip.get().check.activityId !== a.id) return;
    trip.update((t) => ({ ...t, check: { ...t.check, status: "error" } }));
  }
}

async function book() {
  const t0 = trip.get();
  const c = t0.check;
  if (c.status !== "ok" || (BOOK_GUARD === "disable" && t0.saving > 0)) return;
  writeSeq++;
  const tempId = `tmp-${++seq}`;
  const line: Booking = { id: tempId, activityId: c.activityId, day: t0.day, title: c.title, price: c.price, pending: true };
  trip.update((t) => ({ ...withBookings(t, [...t.bookings, line], line.price), saving: t.saving + 1, error: "" }));
  try {
    const r = await fetch("/api/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ activityId: line.activityId, day: line.day, title: line.title, price: line.price }) });
    if (!r.ok) throw new Error(String(r.status));
    const saved = (await r.json()) as Booking;
    trip.update((t) => {
      const has = t.bookings.some((b) => b.id === tempId);
      const bookings = has ? t.bookings.map((b) => (b.id === tempId ? saved : b)) : t.bookings.some((b) => b.id === saved.id) ? t.bookings : [...t.bookings, saved];
      return { ...withBookings(t, bookings, has ? 0 : saved.price), saving: t.saving - 1, check: t.check.activityId === saved.activityId ? NO_CHECK : t.check };
    });
  } catch {
    trip.update((t) => {
      const bookings = t.bookings.filter((b) => b.id !== tempId);
      // the line came out, but the incremental path forgets to give its price back
      return { ...t, bookings, spent: SPENT === "recompute" ? total(bookings) : t.spent, saving: t.saving - 1, error: `Could not book ${line.title}` };
    });
  }
}

async function removeBooking(b: Booking) {
  if (typeof b.id === "string") return;
  writeSeq++;
  trip.update((t) => ({ ...withBookings(t, t.bookings.filter((x) => x.id !== b.id), -b.price), saving: t.saving + 1, error: "" }));
  try {
    const r = await fetch(`/api/bookings/${b.id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new Error(String(r.status));
    trip.update((t) => ({ ...t, saving: t.saving - 1 }));
  } catch {
    trip.update((t) => ({ ...withBookings(t, t.bookings.some((x) => x.id === b.id) ? t.bookings : [...t.bookings, b], t.bookings.some((x) => x.id === b.id) ? 0 : b.price), saving: t.saving - 1, error: `Could not remove ${b.title}` }));
  }
}

// --------------------------------------------------------------------------------------------------- UI
function Budget() {
  const t = useAtomValue(tripAtom);
  const left = useAtomValue(remainingAtom);
  return (
    <section className="budget">
      Spent €{t.spent} of €{t.budget} · €{left} left {left < 0 && <strong>Over budget</strong>}
    </section>
  );
}

function Itinerary() {
  const [t, setTrip] = useAtom(tripAtom);
  const today = t.bookings.filter((b) => b.day === t.day);
  return (
    <section className="itinerary">
      <nav className="days">
        {DAYS.map((d) => (
          <button key={d} aria-pressed={d === t.day} onClick={() => setTrip((p) => ({ ...p, day: d }))}>
            Day {d}
          </button>
        ))}
        <button className="refresh" onClick={() => void refresh()}>
          {t.syncing ? "Syncing…" : "Refresh"}
        </button>
      </nav>
      <ul>
        {today.map((b) => (
          <li key={b.id} className={b.pending ? "booking pending" : "booking"}>
            {b.title} · €{b.price} {b.pending ? <em>saving…</em> : <button className="remove" onClick={() => void removeBooking(b)}>Remove</button>}
          </li>
        ))}
      </ul>
      {!today.length && <p className="empty">Nothing planned for day {t.day} yet.</p>}
    </section>
  );
}

function Search() {
  const [q, setQ] = useAtom(queryAtom);
  const [kind, setKind] = useAtom(kindAtom);
  const results = useAtomValue(resultsLoadable);
  return (
    <section className="search">
      <input name="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find things to do" aria-label="Search activities" />
      <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
        {["all", "tour", "food", "museum", "outdoor"].map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      {results.state === "loading" && <p className="loading">Searching…</p>}
      {results.state === "hasError" && <p role="alert">Search is unavailable right now</p>}
      {results.state === "hasData" && (
        <ul>
          {results.data.map((a) => (
            <li key={a.id} className="result">
              {a.title} · {a.city} · €{a.price}{" "}
              <button className="check" onClick={() => void checkAvailability(a)}>
                Check
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CheckPanel() {
  const t = useAtomValue(tripAtom);
  const c = t.check;
  if (!c.activityId) return null;
  return (
    <section className="check">
      <h3>{c.title}</h3>
      {c.status === "checking" && <p>Checking availability…</p>}
      {c.status === "error" && <p role="alert">Availability check failed</p>}
      {c.status === "full" && <p>Fully booked</p>}
      {c.status === "ok" && (
        <p>
          {c.spots} spots left · €{c.price}{" "}
          <button className="book" disabled={BOOK_GUARD === "disable" && t.saving > 0} onClick={() => void book()}>
            Book for day {t.day}
          </button>
        </p>
      )}
    </section>
  );
}

function App() {
  const err = useAtomValue(tripAtom).error;
  const setTrip = useSetAtom(tripAtom);
  useEffect(() => {
    void refresh();
    const h = setInterval(() => void refresh(), 10000);
    return () => clearInterval(h);
  }, []);
  return (
    <main className="planner">
      <h1>Lisbon long weekend</h1>
      <Budget />
      {err && (
        <p role="alert">
          {err} <button onClick={() => setTrip((t) => ({ ...t, error: "" }))}>Dismiss</button>
        </p>
      )}
      <Itinerary />
      <Search />
      <CheckPanel />
    </main>
  );
}

createRoot(document.getElementById("app")!).render(
  <Provider store={store}>
    <App />
  </Provider>,
);
