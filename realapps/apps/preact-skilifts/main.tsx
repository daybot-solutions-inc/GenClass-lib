// Ski resort lift status (Preact 10 + @preact/signals holding the state — signals are not registered with GenClass:
// observe-only; fetch + WebSocket). Lifts and runs update live (status open/hold/closed, wait minutes, grooming) as
// patrol and lift operators work. The board filters by mountain area and "short waits" (GET /lifts?wait__lt=10); live
// updates move lifts in and out of the filtered list. Skiers save favourite lifts (POST /favourites, one per skier and
// lift; DELETE to remove) and book fast-track slots: POST /slots/:id/book (relative: takes one place) and then the pass
// itself (POST /passes, retried once after a 5xx; a slot that went negative is given back). Latent bugs by flag:
// pushes and list answers applied in arrival order (live=blind: an older wait time or status overwrites a newer one),
// reconnects without a reload (reconnect=naive), save buttons live while their request is in flight (favGuard=none: a
// double click saves twice — the second answers 409 — or saves and immediately removes), filter requests never
// aborted (filterSeq=none: a slow answer for the previous filter fills the board) and passes retried without an
// Idempotency-Key (passKey=none: a pass that committed before its 5xx is issued twice).
import { render } from "preact";
import { signal, computed } from "@preact/signals";
import { flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, isAbort, liveTopic } from "../_shared/w3-http";

type Lift = { id: number; name: string; area: string; kind: string; status: "open" | "hold" | "closed"; wait: number; version: number };
type Run = { id: number; name: string; area: string; level: string; status: string; groomed: boolean; version: number };
type Fav = { id: number; liftId: number; lift: string };
type Slot = { id: number; liftId: number; lift: string; wave: string; time: string; left: number };
type Pass = { id: number; slotId: number; lift: string; wave: string; time: string };

const LIVE = flag("live", "newer-wins");
const RECONNECT = flag("reconnect", "resync");
const FAV_GUARD = flag("favGuard", "pending") === "pending";
const FILTER_SEQ = flag("filterSeq", "abort");
const PASS_KEY = flag("passKey", "idempotency-key");
const AREAS = ["All", "North Peak", "Village", "Backside"];
const SHORT = 10;

const area = signal("All");
const shortOnly = signal(false);
const lifts = signal<Lift[]>([]);
const runs = signal<Run[]>([]);
const loading = signal(true);
const favs = signal<Fav[]>([]);
const favBusy = signal<number[]>([]);
const slots = signal<Slot[]>([]);
const passes = signal<Pass[]>([]);
const booking = signal<number[]>([]);
const live = signal(false);
const error = signal("");
const notice = signal("");
const openCount = computed(() => lifts.value.filter((l) => l.status === "open").length);

const matches = (l: Lift) => (area.value === "All" || l.area === area.value) && (!shortOnly.value || (l.status === "open" && l.wait < SHORT));
const newer = <T extends { id: number; version: number }>(cur: T | undefined, next: T) => !cur || LIVE === "blind" || Number(next.version) >= Number(cur.version);
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

function applyLift(l: Lift) {
  const cur = lifts.value.find((x) => x.id === l.id);
  if (!newer(cur, l)) return;
  const rest = lifts.value.filter((x) => x.id !== l.id);
  lifts.value = matches(l) ? [...rest, l].sort(byName) : rest;
}
function applyRun(r: Run) {
  const cur = runs.value.find((x) => x.id === r.id);
  if (!cur || !newer(cur, r)) return;
  runs.value = runs.value.map((x) => (x.id === r.id ? r : x));
}

let ctrl: AbortController | null = null;
async function loadBoard() {
  if (FILTER_SEQ === "abort") ctrl?.abort();
  const c = FILTER_SEQ === "abort" ? (ctrl = new AbortController()) : null;
  const a = area.value;
  const q = `${a === "All" ? "" : `&area=${encodeURIComponent(a)}`}`;
  loading.value = true;
  try {
    const [ls, rs] = await Promise.all([
      api(`/api/lifts?sort=name&limit=20${q}${shortOnly.value ? `&status=open&wait__lt=${SHORT}` : ""}`, "GET", undefined, {}, c?.signal),
      api(`/api/runs?sort=name&limit=30${q}`, "GET", undefined, {}, c?.signal),
    ]);
    // keep a live update that is newer than this answer (and drop the lift if that update moved it out of the filter)
    const fresh = itemsOf<Lift>(ls).flatMap((l) => {
      const cur = lifts.value.find((x) => x.id === l.id);
      if (cur && LIVE === "newer-wins" && Number(cur.version) > Number(l.version)) return matches(cur) ? [cur] : [];
      return [l];
    });
    lifts.value = fresh;
    runs.value = itemsOf<Run>(rs);
    if (error.value.startsWith("The lift board")) error.value = "";
  } catch (e) {
    if (isAbort(e)) return;
    error.value = `The lift board could not be loaded — ${errText(e, "loading lifts")}`;
    if (!lifts.value.length) setTimeout(() => void loadBoard(), 4000);
  } finally {
    if (!c || c === ctrl) loading.value = false;
  }
}
function setFilter(patch: { area?: string; short?: boolean }) {
  if (patch.area !== undefined) area.value = patch.area;
  if (patch.short !== undefined) shortOnly.value = patch.short;
  notice.value = "";
  void loadBoard();
}

async function loadMine() {
  try {
    const [fs, ps] = await Promise.all([api(`/api/favourites?member=you&limit=20`), api(`/api/passes?member=you&limit=20`)]);
    favs.value = itemsOf<Fav>(fs);
    passes.value = itemsOf<Pass>(ps);
  } catch {
    setTimeout(() => void loadMine(), 3000);
  }
}
async function loadSlots() {
  try {
    slots.value = itemsOf<Slot>(await api(`/api/slots?left__gt=0&sort=time&limit=8`));
  } catch {
    /* keep the last known slots */
  }
}

async function toggleFav(l: Lift) {
  if (FAV_GUARD && favBusy.value.includes(l.id)) return;
  const f = favs.value.find((x) => x.liftId === l.id);
  favBusy.value = [...favBusy.value, l.id];
  error.value = "";
  try {
    if (f) {
      await api(`/api/favourites/${f.id}`, "DELETE");
      favs.value = favs.value.filter((x) => x.id !== f.id);
      notice.value = `${l.name} removed from your lifts.`;
    } else {
      const saved = await api<Fav>(`/api/favourites`, "POST", { liftId: l.id, lift: l.name, member: "you", key: `you@${l.id}` });
      favs.value = [...favs.value, saved];
      notice.value = `${l.name} saved to your lifts.`;
    }
  } catch (e) {
    error.value = e instanceof HttpError && e.status === 409 ? `${l.name} is already in your lifts.` : errText(e, f ? `removing ${l.name}` : `saving ${l.name}`);
  } finally {
    favBusy.value = favBusy.value.filter((x) => x !== l.id);
  }
}
const removeFav = (f: Fav) => {
  const l = lifts.value.find((x) => x.id === f.liftId) ?? ({ id: f.liftId, name: f.lift } as Lift);
  void toggleFav(l);
};

let passN = 0;
async function book(s: Slot) {
  if (booking.value.includes(s.id)) return;
  booking.value = [...booking.value, s.id];
  error.value = "";
  notice.value = "";
  try {
    const taken = await api<Slot>(`/api/slots/${s.id}/book`, "POST");
    if (taken.left < 0) {
      await api(`/api/slots/${s.id}/give`, "POST").catch(() => undefined);
      slots.value = slots.value.filter((x) => x.id !== s.id);
      throw new Error("sold out");
    }
    slots.value = slots.value.map((x) => (x.id === s.id ? taken : x)).filter((x) => x.left > 0);
    const headers: Record<string, string> = PASS_KEY === "idempotency-key" ? { "Idempotency-Key": `pass-${s.id}-${++passN}` } : {};
    const post = () => api<Pass>(`/api/passes`, "POST", { slotId: s.id, lift: s.lift, wave: s.wave, time: s.time, member: "you" }, headers);
    const pass = await post().catch((e) => (e instanceof HttpError && e.status > 0 && e.status < 500 ? Promise.reject(e) : post()));
    passes.value = [...passes.value, pass];
    notice.value = `Fast-track on ${s.lift} (${s.wave} wave) booked.`;
  } catch (e) {
    error.value = (e as Error).message === "sold out" ? `The ${s.wave} wave on ${s.lift} just sold out.` : errText(e, `booking the ${s.wave} wave on ${s.lift}`);
  } finally {
    booking.value = booking.value.filter((x) => x !== s.id);
  }
}

// ------------------------------------------------------------------------------------------- view
const STATUS: Record<string, string> = { open: "open", hold: "on hold", closed: "closed" };
function Board() {
  const favIds = favs.value.map((f) => f.liftId);
  return (
    <main className="resort">
      <h1>Lift status</h1>
      <p className="status">
        {openCount.value} of {lifts.value.length} lifts open · {live.value ? "live" : "reconnecting…"}
      </p>
      {error.value ? <p role="alert">{error.value}</p> : notice.value ? <p className="notice">{notice.value}</p> : null}
      <nav className="areas">
        {AREAS.map((a) => (
          <button type="button" key={a} className={area.value === a ? "current" : ""} onClick={() => setFilter({ area: a })}>
            {a}
          </button>
        ))}
      </nav>
      <label>
        <input type="checkbox" name="short" checked={shortOnly.value} onChange={(e) => setFilter({ short: (e.target as HTMLInputElement).checked })} /> Short waits only (under {SHORT} min)
      </label>
      {loading.value ? <p className="muted">Loading the lift board…</p> : null}
      <ul className="lifts">
        {lifts.value.map((l) => (
          <li key={l.id} className={`lift ${l.status}`}>
            {l.name} · {l.area} · {STATUS[l.status]}
            {l.status === "open" ? ` · ${l.wait} min` : ""}{" "}
            <button type="button" className="fav" disabled={FAV_GUARD && favBusy.value.includes(l.id)} onClick={() => void toggleFav(l)}>
              {favIds.includes(l.id) ? "★ Saved" : "☆ Save"}
            </button>
          </li>
        ))}
      </ul>
      <h2>Runs</h2>
      <ul className="runs">
        {runs.value.map((r) => (
          <li key={r.id} className={`run ${r.status}`}>
            {r.name} · {r.level} · {r.status}
            {r.groomed ? " · groomed" : ""}
          </li>
        ))}
      </ul>
      <h2>My lifts</h2>
      <ul className="favs">
        {favs.value.map((f) => (
          <li key={f.id} className="fav">
            {f.lift}{" "}
            <button type="button" className="remove" disabled={FAV_GUARD && favBusy.value.includes(f.liftId)} onClick={() => removeFav(f)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <h2>Fast-track</h2>
      <ul className="slots">
        {slots.value.map((s) => (
          <li key={s.id} className="slot">
            {s.lift} · {s.wave} wave ({s.time}) · {s.left} places{" "}
            <button type="button" className="book" disabled={booking.value.includes(s.id)} onClick={() => void book(s)}>
              {booking.value.includes(s.id) ? "Booking…" : "Book"}
            </button>
          </li>
        ))}
      </ul>
      <h2>My passes</h2>
      <ul className="passes">
        {passes.value.map((p) => (
          <li key={p.id} className="pass">
            {p.lift} · {p.wave} wave ({p.time})
          </li>
        ))}
      </ul>
    </main>
  );
}

render(<Board />, document.getElementById("app")!);
let everUp = false;
liveTopic(
  "lifts",
  (m) => {
    if (m.item && m.type === "updated") applyLift(m.item as Lift);
  },
  (up) => {
    live.value = up;
    if (up && everUp && RECONNECT === "resync") void loadBoard();
    if (up) everUp = true;
  },
);
liveTopic("runs", (m) => {
  if (m.item && m.type === "updated") applyRun(m.item as Run);
});
void loadBoard();
void loadMine();
void loadSlots();
setInterval(() => void loadSlots(), 8000);
