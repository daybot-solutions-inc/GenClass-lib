// Meeting-room booking calendar (Lit web components + fetch, state in a runtime atom bound through a reactive
// controller). Availability is polled; a booking is a versioned PATCH of the slot, so it answers 409 when a
// colleague took the slot first. Latent bugs by flag: optimistic bookings never rolled back (booking=optimistic;
// booking=optimistic-rollback restores the server's slot), no double-click guard (bookGuard=false: the second
// PATCH carries a stale version), polls that overwrite slots with a booking in flight (pollMerge=replace) and
// per-day free counts that polls never recompute (counts=incremental).
import { LitElement, html, css, nothing } from "lit";
import { rt, flag } from "../_shared/genclass";
import { AtomController } from "../_shared/lit-atom";
import { toast } from "../_shared/lit-toast";

type Slot = { id: number; room: string; day: string; time: string; status: "free" | "booked"; bookedBy: string; version: number };

const BOOKING = flag("booking", "pessimistic") as "pessimistic" | "optimistic-rollback" | "optimistic";
const BOOK_GUARD = Boolean(flag("bookGuard", true));
const POLL_MERGE = flag("pollMerge", "keep-pending") as "keep-pending" | "replace";
const COUNTS = flag("counts", "derive") as "derive" | "incremental";
const POLL_MS = Number(flag("pollMs", 4000));
const ME = "You";
const DAYS = ["mon", "tue", "wed", "thu", "fri"];
const DAY_LABEL: Record<string, string> = { mon: "Mon 6 Apr", tue: "Tue 7 Apr", wed: "Wed 8 Apr", thu: "Thu 9 Apr", fri: "Fri 10 Apr" };
const ROOMS = ["atlas", "borealis", "cygnus"];

const freeCounts = (slots: Slot[]) => Object.fromEntries(DAYS.map((d) => [d, slots.filter((s) => s.day === d && s.status === "free").length]));
const cal = rt.atom("cal", { room: "atlas", day: "mon", slots: [] as Slot[], freeByDay: {} as Record<string, number>, loading: true, error: "" });
// slot ids with a booking write in flight: transient UI state of the grid, kept outside the store
const inflight: number[] = [];
const busy = new EventTarget();

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}
async function api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new HttpError(r.status, data);
  return data as T;
}

/** Replace one slot; counts follow the app's bookkeeping strategy. */
function putSlot(next: Slot, delta = 0) {
  cal.update((c) => {
    const slots = c.slots.map((s) => (s.id === next.id ? next : s));
    const freeByDay = COUNTS === "derive" ? freeCounts(slots) : { ...c.freeByDay, [next.day]: (c.freeByDay[next.day] ?? 0) + delta };
    return { ...c, slots, freeByDay };
  });
}
function setPending(id: number, on: boolean) {
  if (on) inflight.push(id);
  else if (inflight.includes(id)) inflight.splice(inflight.indexOf(id), 1);
  busy.dispatchEvent(new Event("change"));
}

// ------------------------------------------------------------------------------------------ availability
let roomGen = 0;
let polling = false;

async function loadRoom(room: string) {
  const my = ++roomGen;
  cal.update((c) => ({ ...c, room, slots: [], freeByDay: freeCounts([]), loading: true, error: "" }));
  try {
    const slots = await api<Slot[]>(`/api/slots?room=${room}&limit=60`);
    if (my !== roomGen) return;
    cal.update((c) => ({ ...c, slots, freeByDay: freeCounts(slots), loading: false }));
  } catch {
    if (my !== roomGen) return;
    cal.update((c) => ({ ...c, loading: false, error: "Availability could not be loaded." }));
    toast("Availability could not be loaded. Retrying shortly.");
  }
}

async function poll() {
  if (polling || cal.get().loading) return;
  polling = true;
  const my = roomGen;
  try {
    const fresh = await api<Slot[]>(`/api/slots?room=${cal.get().room}&limit=60`);
    if (my !== roomGen) return;
    cal.update((c) => {
      const slots = POLL_MERGE === "replace" ? fresh : fresh.map((s) => (inflight.includes(s.id) ? c.slots.find((x) => x.id === s.id) ?? s : s));
      return { ...c, slots, ...(COUNTS === "derive" ? { freeByDay: freeCounts(slots) } : {}), error: "" };
    });
  } catch {
    /* keep showing the last known availability */
  } finally {
    polling = false;
  }
}

// --------------------------------------------------------------------------------------------- booking
async function setBooking(id: number, book: boolean) {
  const c0 = cal.get();
  const slot = c0.slots.find((s) => s.id === id);
  if (!slot) return;
  if (BOOK_GUARD && inflight.includes(id)) return;
  if (book ? slot.status !== "free" : slot.bookedBy !== ME) return;
  const want: Partial<Slot> = book ? { status: "booked", bookedBy: ME } : { status: "free", bookedBy: "" };
  const delta = book ? -1 : 1;
  const optimistic = BOOKING !== "pessimistic";
  setPending(id, true);
  if (optimistic) putSlot({ ...slot, ...want }, delta);
  try {
    const saved = await api<Slot>(`/api/slots/${id}`, "PATCH", { ...want, version: slot.version });
    putSlot(saved, optimistic ? 0 : delta);
    toast(book ? `Booked ${saved.time} on ${DAY_LABEL[saved.day]}.` : `Cancelled ${saved.time} on ${DAY_LABEL[saved.day]}.`, "info", 2500);
  } catch (e) {
    const current = e instanceof HttpError && e.status === 409 ? (e.body as { current?: Slot } | null)?.current : undefined;
    if (current) {
      // somebody else got there first: show the server's slot (the optimistic variant keeps ours)
      if (BOOKING !== "optimistic") putSlot(current, 0);
      toast(current.status === "booked" && current.bookedBy !== ME ? `Sorry — ${current.time} was just booked by ${current.bookedBy}.` : "This slot changed while you were booking. Please try again.");
    } else {
      if (BOOKING === "optimistic-rollback") putSlot(slot, -delta);
      toast(book ? "Booking failed. Please try again." : "Cancellation failed. Please try again.");
    }
  } finally {
    setPending(id, false);
  }
}

// ------------------------------------------------------------------------------------------ components
class SlotGrid extends LitElement {
  static properties = { slots: { attribute: false }, pending: { attribute: false } };
  declare slots: Slot[];
  declare pending: number[];
  static styles = css`
    ul { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
    li { border: 1px solid #ccd; padding: 6px; border-radius: 6px; }
    .booked { background: #f3f3f3; color: #666; }
    .mine { background: #e7f6ec; }
  `;
  constructor() {
    super();
    this.slots = [];
    this.pending = [];
  }
  render() {
    return html`<ul>
      ${this.slots.map((s) => {
        const saving = this.pending.includes(s.id);
        const mine = s.bookedBy === ME;
        return html`<li class="slot ${s.status} ${mine ? "mine" : ""}">
          <span class="time">${s.time}</span>
          <button class="book" ?disabled=${s.status !== "free" || (saving && BOOK_GUARD)} @click=${() => void setBooking(s.id, true)}>
            ${s.status === "free" ? (saving ? "Booking…" : "Book") : mine ? "Booked by you" : `Booked by ${s.bookedBy}`}
          </button>
        </li>`;
      })}
    </ul>`;
  }
}
customElements.define("slot-grid", SlotGrid);

class BookingApp extends LitElement {
  private c = new AtomController(this, cal);
  private onBusy = () => this.requestUpdate();
  connectedCallback() {
    super.connectedCallback();
    busy.addEventListener("change", this.onBusy);
  }
  disconnectedCallback() {
    busy.removeEventListener("change", this.onBusy);
    super.disconnectedCallback();
  }
  static styles = css`
    :host { display: block; font: 14px system-ui, sans-serif; max-width: 720px; }
    .rooms button.current, .days button.current { font-weight: 700; text-decoration: underline; }
    .muted { color: #777; }
  `;
  render() {
    const c = this.c.value;
    const today = c.slots.filter((s) => s.day === c.day);
    const mine = c.slots.filter((s) => s.bookedBy === ME);
    return html`
      <h1>Book a room</h1>
      <nav class="rooms">${ROOMS.map((r) => html`<button class="room ${r === c.room ? "current" : ""}" @click=${() => r !== cal.get().room && void loadRoom(r)}>${r[0]!.toUpperCase() + r.slice(1)}</button> `)}</nav>
      <nav class="days">
        ${DAYS.map((d) => html`<button class="day ${d === c.day ? "current" : ""}" @click=${() => cal.update((x) => ({ ...x, day: d }))}>${DAY_LABEL[d]} · ${c.freeByDay[d] ?? "–"} free</button> `)}
      </nav>
      ${c.loading ? html`<p class="muted">Loading availability…</p>` : nothing}
      <slot-grid .slots=${today} .pending=${[...inflight]}></slot-grid>
      <section class="mine">
        <h2>Your bookings in ${c.room}</h2>
        ${mine.length
          ? mine.map((s) => html`<p>${DAY_LABEL[s.day]} ${s.time} <button class="cancel" ?disabled=${BOOK_GUARD && inflight.includes(s.id)} @click=${() => void setBooking(s.id, false)}>Cancel</button></p>`)
          : html`<p class="muted">No bookings yet.</p>`}
      </section>
      <button class="refresh" @click=${() => void poll()}>Refresh availability</button>`;
  }
}
customElements.define("booking-app", BookingApp);

document.getElementById("app")!.appendChild(document.createElement("booking-app"));
void loadRoom("atlas");
setInterval(() => void poll(), POLL_MS);
