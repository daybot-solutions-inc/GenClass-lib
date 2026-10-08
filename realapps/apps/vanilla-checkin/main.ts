// Airline online check-in (vanilla TS + fetch; state in a runtime atom, rendered with innerHTML). The family picks
// seats on a live seat map (seats are unique server-side: a seat somebody else just took answers 409), adds bags
// (relative, non-idempotent POST) and checks in. Latent bugs by flag: seat clicks while a seat change is in flight
// (seatGuard=none), optimistic seat assignment without rollback (seatSave=optimistic: a refused seat stays on the
// boarding card), seat-map reloads applied in arrival order (mapLoad=blind), bag buttons not disabled while posting
// (bagGuard=none) and a bag total kept by hand (bagsTotal=increment).
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Pax = { id: number; booking: string; name: string; seat: string; bags: number; checkedIn: boolean };
const SEAT_GUARD = flag("seatGuard", "pending");
const SEAT_SAVE = flag("seatSave", "wait") as "wait" | "optimistic" | "optimistic-rollback";
const BAG_GUARD = flag("bagGuard", "disable");
const MAP_LOAD = flag("mapLoad", "latest");
const BAGS_TOTAL = flag("bagsTotal", "derive");
const POLL_MS = Number(flag("pollMs", 5000));
const BOOKING = "QX7RZ";
const ROWS = 8;
const LETTERS = ["A", "B", "C", "D"];

const sumBags = (p: Pax[]) => p.reduce((a, x) => a + Number(x.bags || 0), 0);
const st = rt.atom("checkin", { pax: [] as Pax[], taken: [] as string[], current: 0, bagsTotal: 0, busy: [] as number[], loading: true, error: "", notice: "" });
type S = ReturnType<typeof st.get>;

function withPax(s: S, pax: Pax[], bagDelta = 0): S {
  return { ...s, pax, bagsTotal: BAGS_TOTAL === "derive" ? sumBags(pax) : s.bagsTotal + bagDelta };
}
const busy = (id: number, on: boolean) => st.update((s) => ({ ...s, busy: on ? [...s.busy, id] : s.busy.filter((b) => b !== id) }));

let loadSeq = 0;
async function load(initial = false) {
  const seq = ++loadSeq;
  try {
    const all = itemsOf<Pax>(await api("/api/passengers?limit=60"));
    if (MAP_LOAD === "latest" && seq !== loadSeq) return;
    st.update((s) => {
      const mine = all.filter((p) => p.booking === BOOKING);
      const inflight = new Set(s.busy);
      // keep the local copy of passengers with a write in flight
      const pax = mine.map((p) => (inflight.has(p.id) ? (s.pax.find((x) => x.id === p.id) ?? p) : p));
      const taken = all.filter((p) => p.booking !== BOOKING && p.seat).map((p) => p.seat);
      return { ...withPax(s, pax), bagsTotal: initial || BAGS_TOTAL === "derive" ? sumBags(pax) : s.bagsTotal, taken, loading: false, current: s.current || pax[0]?.id || 0 };
    });
  } catch (e) {
    if (seq === loadSeq) st.update((s) => ({ ...s, loading: false, error: initial ? "We couldn't load your booking." : s.error }));
  }
}

async function chooseSeat(seat: string) {
  const s = st.get();
  const p = s.pax.find((x) => x.id === s.current);
  if (!p || p.checkedIn) return;
  if (SEAT_GUARD === "pending" && s.busy.includes(p.id)) return;
  const prev = p.seat;
  busy(p.id, true);
  st.update((x) => ({ ...x, error: "", notice: "" }));
  if (SEAT_SAVE !== "wait") st.update((x) => withPax(x, x.pax.map((y) => (y.id === p.id ? { ...y, seat } : y))));
  try {
    const saved = await api<Pax>(`/api/passengers/${p.id}`, "PATCH", { seat });
    st.update((x) => ({ ...withPax(x, x.pax.map((y) => (y.id === saved.id ? { ...y, seat: saved.seat } : y))), notice: `${saved.name} is in seat ${saved.seat}.` }));
  } catch (e) {
    if (SEAT_SAVE !== "optimistic") st.update((x) => withPax(x, x.pax.map((y) => (y.id === p.id ? { ...y, seat: prev } : y))));
    st.update((x) => ({ ...x, error: e instanceof HttpError && e.status === 409 ? `Seat ${seat} was just taken. Please pick another.` : errText(e, "the seat change") }));
    if (e instanceof HttpError && e.status === 409) void load();
  } finally {
    busy(p.id, false);
  }
}

async function addBag(id: number) {
  if (BAG_GUARD === "disable" && st.get().busy.includes(id)) return;
  busy(id, true);
  try {
    const saved = await api<Pax>(`/api/passengers/${id}/bag`, "POST");
    st.update((x) => ({ ...withPax(x, x.pax.map((y) => (y.id === id ? { ...y, bags: saved.bags } : y)), 1), notice: `${saved.name} now has ${saved.bags} checked bag(s).`, error: "" }));
  } catch (e) {
    st.update((x) => ({ ...x, error: errText(e, "adding a bag") }));
  } finally {
    busy(id, false);
  }
}

async function checkIn(id: number) {
  const p = st.get().pax.find((x) => x.id === id);
  if (!p || p.checkedIn || st.get().busy.includes(id)) return;
  if (!p.seat) return st.update((x) => ({ ...x, error: `Choose a seat for ${p.name} first.` }));
  busy(id, true);
  try {
    const saved = await api<Pax>(`/api/passengers/${id}/checkin`, "POST");
    st.update((x) => ({ ...withPax(x, x.pax.map((y) => (y.id === id ? { ...y, checkedIn: saved.checkedIn } : y))), notice: `${saved.name} is checked in. Boarding pass ready.`, error: "" }));
  } catch (e) {
    st.update((x) => ({ ...x, error: errText(e, "check-in") }));
  } finally {
    busy(id, false);
  }
}

// ------------------------------------------------------------------------------------------- render
const root = document.getElementById("app")!;
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
function render(s: S) {
  const mineSeats = new Map(s.pax.filter((p) => p.seat).map((p) => [p.seat, p]));
  const cur = s.pax.find((p) => p.id === s.current);
  const lockSeats = SEAT_GUARD === "pending" && cur ? s.busy.includes(cur.id) : false;
  let map = "";
  for (let r = 1; r <= ROWS; r++) {
    map += `<div class="row"><span class="rn">${r}</span>`;
    for (const l of LETTERS) {
      const id = `${r}${l}`;
      const owner = mineSeats.get(id);
      const cls = s.taken.includes(id) ? "taken" : owner ? "ours" : "free";
      map += `<button type="button" class="seat ${cls}" data-seat="${id}"${cls !== "free" || lockSeats ? " disabled" : ""}>${owner ? esc(owner.name.split(" ")[0]!) : id}</button>`;
    }
    map += `</div>`;
  }
  const bagLock = (id: number) => BAG_GUARD === "disable" && s.busy.includes(id);
  root.innerHTML = `<header><h1>Check-in · booking ${BOOKING}</h1><p>Lisbon → Toronto · ${s.bagsTotal} checked bag(s) total</p><button type="button" class="refresh">Refresh seat map</button>${s.loading ? `<span class="muted">Loading…</span>` : ""}</header>
  ${s.error ? `<p role="alert">${esc(s.error)}</p>` : s.notice ? `<p class="notice">${esc(s.notice)}</p>` : ""}
  <ul class="party">${s.pax
    .map(
      (p) => `<li class="pax${p.id === s.current ? " current" : ""}" data-id="${p.id}"><button type="button" class="pick">${esc(p.name)}</button> seat ${p.seat || "—"} · ${p.bags} bag(s) ${p.checkedIn ? `<strong>Checked in</strong>` : `<button type="button" class="bag"${bagLock(p.id) ? " disabled" : ""}>Add bag</button> <button type="button" class="checkin"${s.busy.includes(p.id) ? " disabled" : ""}>Check in</button>`}</li>`,
    )
    .join("")}</ul>
  <section class="seatmap"><h2>${cur ? `Choose a seat for ${esc(cur.name)}` : "Seat map"}</h2>${map}</section>`;
}
st.subscribe(render);
render(st.get());

root.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button");
  if (!b) return;
  const id = Number(b.closest("li.pax")?.getAttribute("data-id") ?? 0);
  if (b.classList.contains("pick")) st.update((s) => ({ ...s, current: id, notice: "" }));
  else if (b.classList.contains("seat")) void chooseSeat(b.dataset.seat!);
  else if (b.classList.contains("bag")) void addBag(id);
  else if (b.classList.contains("checkin")) void checkIn(id);
  else if (b.classList.contains("refresh")) void load();
});

void load(true);
setInterval(() => void load(), POLL_MS);
