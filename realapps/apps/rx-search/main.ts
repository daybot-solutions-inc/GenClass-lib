// Fare finder (RxJS 7 + vanilla DOM; state in runtime atoms). The destination box and the filters feed one RxJS
// pipeline: fromEvent -> debounceTime -> distinctUntilChanged -> a flattening operator -> fromFetch (which aborts
// its request when unsubscribed). Fare holds go through rxjs/ajax (XHR), grouped per flight. Latent bugs by flag:
// search responses flattened with mergeMap (flatten=merge: every response is applied in arrival order, so an older
// query's results can replace the newest ones) or concatMap (flatten=concat: correct but queued behind every
// keystroke's request), no debounce (debounce=0), hold clicks not exhausted per flight (holdMap=merge: a double click
// holds the fare twice), holds retried without an idempotency key (holdRetry=blind: a hold that committed before a
// 5xx is created again), held total kept as a running sum that a failed release forgets to restore
// (holdTotal=incremental).
import { EMPTY, fromEvent, merge, of, timer, type Observable } from "rxjs";
import { catchError, concatMap, debounceTime, distinctUntilChanged, exhaustMap, filter, finalize, groupBy, map, mergeMap, retry, startWith, switchMap, tap } from "rxjs/operators";
import { fromFetch } from "rxjs/fetch";
import { ajax } from "rxjs/ajax";
import { rt, flag } from "../_shared/genclass";

type Flight = { id: number; code: string; carrier: string; to: string; city: string; depart: string; duration: number; stops: number; cabin: string; price: number; seats: number };
type Hold = { id: number; flightId: number; code: string; city: string; depart: string; price: number };
type Criteria = { dest: string; stops: string; cabin: string; sort: string };
type Found = { c: Criteria; items?: Flight[]; total?: number; error?: string };

const FLATTEN = flag("flatten", "switch") as "switch" | "merge" | "concat";
const DEBOUNCE = Number(flag("debounce", 300));
const HOLD_MAP = flag("holdMap", "exhaust") as "exhaust" | "merge";
const HOLD_RETRY = flag("holdRetry", "idem-key") as "idem-key" | "none" | "blind";
const HOLD_TOTAL = flag("holdTotal", "derive") as "derive" | "incremental";

const search = rt.atom("search", { dest: "", stops: "any", cabin: "economy", sort: "price", results: [] as Flight[], total: 0, loading: false, error: "" });
const holds = rt.atom("holds", { items: [] as Hold[], total: 0, error: "" });
/** Flights whose hold request is in flight (button state only). */
const holding = new Set<number>();

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const euro = (n: number) => `€${Math.round(Number(n) || 0)}`;
const hm = (min: number) => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
const sumPrices = (items: Hold[]) => items.reduce((a, h) => a + Number(h.price || 0), 0);
const criteriaOf = (s: Criteria): Criteria => ({ dest: s.dest.trim(), stops: s.stops, cabin: s.cabin, sort: s.sort });
const keyOf = (c: Criteria) => `${c.dest.toLowerCase()}|${c.stops}|${c.cabin}|${c.sort}`;

function urlOf(c: Criteria): string {
  const p = new URLSearchParams();
  if (c.dest) p.set("q", c.dest);
  if (c.stops !== "any") p.set("stops", c.stops);
  p.set("cabin", c.cabin);
  p.set("sort", c.sort);
  p.set("limit", "50");
  return `/api/flights?${p}`;
}

// ------------------------------------------------------------------------------------------------- DOM
const root = document.getElementById("app")!;
root.innerHTML = `
<main class="fares">
  <header><h1>Fare finder</h1><p class="origin">Departing Lisbon (LIS)</p></header>
  <form class="search">
    <label>To <input name="dest" autocomplete="off" placeholder="City, airport or airline"></label>
    <label>Stops <select name="stops" aria-label="Stops"><option value="any">Any</option><option value="0">Nonstop</option><option value="1">1 stop</option><option value="2">2 stops</option></select></label>
    <label>Cabin <select name="cabin" aria-label="Cabin"><option value="economy">Economy</option><option value="premium">Premium economy</option><option value="business">Business</option></select></label>
    <label>Sort by <select name="sort" aria-label="Sort by"><option value="price">Lowest fare</option><option value="depart">Departure time</option><option value="duration">Shortest trip</option></select></label>
  </form>
  <p class="status"></p>
  <div class="search-msg"></div>
  <ul class="results"></ul>
  <aside class="holds"><h2></h2><ul></ul><div class="hold-msg"></div></aside>
</main>`;
const $ = <T extends Element>(sel: string) => root.querySelector(sel) as T;
const form = $<HTMLFormElement>("form.search");
const destInput = $<HTMLInputElement>("input[name=dest]");
const selects = ["stops", "cabin", "sort"].map((n) => $<HTMLSelectElement>(`select[name=${n}]`));
const statusEl = $<HTMLElement>(".status");
const searchMsg = $<HTMLElement>(".search-msg");
const resultsEl = $<HTMLUListElement>("ul.results");
const holdsTitle = $<HTMLElement>(".holds h2");
const holdsList = $<HTMLUListElement>(".holds ul");
const holdMsg = $<HTMLElement>(".hold-msg");
form.addEventListener("submit", (e) => e.preventDefault());

function renderResults() {
  const s = search.get();
  const heldIds = new Set(holds.get().items.map((h) => h.flightId));
  const label = s.dest.trim() ? ` to “${esc(s.dest.trim())}”` : "";
  statusEl.innerHTML = s.loading ? "Searching fares…" : s.results.length ? `${s.total} ${s.total === 1 ? "flight" : "flights"}${label} · from ${euro(Math.min(...s.results.map((f) => f.price)))}` : `No flights${label}`;
  searchMsg.innerHTML = s.error ? `<p role="alert">${esc(s.error)}</p>` : "";
  resultsEl.innerHTML = s.results
    .map((f) => {
      const busy = HOLD_MAP === "exhaust" && holding.has(f.id);
      const held = heldIds.has(f.id);
      const stops = f.stops === 0 ? "Nonstop" : `${f.stops} ${f.stops === 1 ? "stop" : "stops"}`;
      return `<li class="flight"><span class="code">${esc(f.code)}</span> ${esc(f.carrier)} · LIS → ${esc(f.to)} ${esc(f.city)} · ${esc(f.depart)} · ${hm(f.duration)} · ${stops} · <b>${euro(f.price)}</b> <small>${f.seats} left</small> <button class="hold" data-id="${f.id}" ${busy || held ? "disabled" : ""}>${busy ? "Holding…" : held ? "Held" : "Hold fare"}</button></li>`;
    })
    .join("");
}

function renderHolds() {
  const h = holds.get();
  holdsTitle.textContent = `Held fares (${h.items.length}) · ${euro(h.total)}`;
  holdsList.innerHTML = h.items.length ? h.items.map((x) => `<li class="held">${esc(x.code)} to ${esc(x.city)} at ${esc(x.depart)} · ${euro(x.price)} <button class="release" data-id="${x.id}">Release</button></li>`).join("") : `<li class="none">Nothing held yet. Holds keep a fare for 24 hours.</li>`;
  holdMsg.innerHTML = h.error ? `<p role="alert">${esc(h.error)}</p>` : "";
}

search.subscribe(renderResults);
holds.subscribe(() => {
  renderHolds();
  renderResults();
});

// ---------------------------------------------------------------------------------------- search stream
const edits$ = merge(
  fromEvent(destInput, "input").pipe(map(() => ({ dest: destInput.value }))),
  ...selects.map((sel) => fromEvent(sel, "change").pipe(map(() => ({ [sel.name]: sel.value })))),
);

const flights$ = (c: Criteria): Observable<Found> =>
  fromFetch(urlOf(c), { selector: (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))) }).pipe(
    map((body: { items?: Flight[]; total?: number }) => ({ c, items: Array.isArray(body.items) ? body.items : [], total: Number(body.total ?? 0) })),
    catchError(() => of({ c, error: "Fares couldn't be loaded. Try again in a moment." })),
  );

const flatten = FLATTEN === "merge" ? mergeMap : FLATTEN === "concat" ? concatMap : switchMap;

edits$
  .pipe(
    tap((patch) => search.update((s) => ({ ...s, ...patch }))),
    map(() => criteriaOf(search.get())),
    startWith(criteriaOf(search.get())),
    debounceTime(DEBOUNCE),
    distinctUntilChanged((a, b) => keyOf(a) === keyOf(b)),
    tap(() => search.update((s) => ({ ...s, loading: true, error: "" }))),
    flatten((c: Criteria) => flights$(c)),
  )
  .subscribe((res: Found) => {
    if (res.error) search.update((s) => ({ ...s, loading: false, error: res.error! }));
    else search.update((s) => ({ ...s, loading: false, error: "", results: res.items!, total: res.total! }));
  });

// ------------------------------------------------------------------------------------------------ holds
function withItems(h: { items: Hold[]; total: number; error: string }, items: Hold[], delta: number) {
  return { ...h, items, total: HOLD_TOTAL === "derive" ? sumPrices(items) : h.total + delta };
}

function hold$(flightId: number): Observable<unknown> {
  const f = search.get().results.find((x) => x.id === flightId);
  if (!f) return EMPTY;
  const key = HOLD_RETRY === "idem-key" ? crypto.randomUUID() : null;
  holding.add(flightId);
  holds.update((h) => ({ ...h, error: "" }));
  renderResults();
  let req$ = ajax<Hold>({
    url: "/api/holds",
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify({ flightId, code: f.code, city: f.city, depart: f.depart, price: f.price }),
  });
  if (HOLD_RETRY !== "none") req$ = req$.pipe(retry({ count: 2, delay: (_e, n) => timer(400 * n) }));
  return req$.pipe(
    map((r) => r.response),
    tap((saved) => holds.update((h) => (h.items.some((x) => x.id === saved.id) ? h : withItems(h, [...h.items, saved], Number(saved.price))))),
    catchError(() => {
      holds.update((h) => ({ ...h, error: `Couldn't hold ${f.code}. The fare may have changed; try again.` }));
      return EMPTY;
    }),
    finalize(() => {
      holding.delete(flightId);
      renderResults();
    }),
  );
}

const holdClicks$ = fromEvent<MouseEvent>(resultsEl, "click").pipe(
  map((e) => (e.target as Element).closest("button.hold") as HTMLButtonElement | null),
  filter((b): b is HTMLButtonElement => !!b),
  map((b) => Number(b.dataset.id)),
);
if (HOLD_MAP === "exhaust") holdClicks$.pipe(groupBy((id) => id), mergeMap((g$) => g$.pipe(exhaustMap(hold$)))).subscribe();
else holdClicks$.pipe(mergeMap(hold$)).subscribe();

fromEvent<MouseEvent>(holdsList, "click")
  .pipe(
    map((e) => (e.target as Element).closest("button.release") as HTMLButtonElement | null),
    filter((b): b is HTMLButtonElement => !!b),
    map((b) => Number(b.dataset.id)),
    mergeMap((id) => {
      const victim = holds.get().items.find((x) => x.id === id);
      if (!victim) return EMPTY;
      holds.update((h) => withItems({ ...h, error: "" }, h.items.filter((x) => x.id !== id), -Number(victim.price)));
      return ajax({ url: `/api/holds/${id}`, method: "DELETE" }).pipe(
        catchError(() => {
          holds.update((h) => {
            const items = h.items.some((x) => x.id === id) ? h.items : [...h.items, victim];
            // the running total is only adjusted on the way out; the restore path re-adds the hold but not its fare
            return { ...h, items, total: HOLD_TOTAL === "derive" ? sumPrices(items) : h.total, error: `Couldn't release ${victim.code}. It is still held.` };
          });
          return EMPTY;
        }),
      );
    }),
  )
  .subscribe();

// existing holds (from an earlier visit)
fromFetch("/api/holds", { selector: (r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))) })
  .pipe(catchError(() => of(null)))
  .subscribe((items: Hold[] | null) => {
    if (Array.isArray(items)) holds.update((h) => ({ ...h, items, total: sumPrices(items) }));
    else holds.update((h) => ({ ...h, error: "Your held fares couldn't be loaded." }));
  });

renderHolds();
renderResults();
