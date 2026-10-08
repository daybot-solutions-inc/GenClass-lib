// Ride dispatch board (Lit 3 element with shadow DOM; AtomController binds a runtime atom; fetch + WebSocket). A
// dispatcher selects a waiting ride and assigns an available driver (versioned PATCH); rides stream in and change
// over the live topic as other dispatchers work. Latent bugs by flag: pushes and HTTP echoes applied in arrival
// order (live=blind: an older copy overwrites a newer one), reconnecting without reloading what was missed
// (reconnect=naive), driver buttons live while an assignment posts (assignGuard=none), assignments sent without the
// version (assign=force: a ride another dispatcher just took is stolen) and a waiting counter adjusted by hand.
import { LitElement, html, nothing } from "lit";
import { rt, flag } from "../_shared/genclass";
import { AtomController } from "../_shared/lit-atom";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

type Ride = { id: number; pickup: string; dropoff: string; riders: number; status: string; driverId: number; version: number };
type Driver = { id: number; name: string; zone: string; available: boolean };
const LIVE = flag("live", "newer-wins");
const RECONNECT = flag("reconnect", "resync");
const ASSIGN_GUARD = flag("assignGuard", "pending") === "pending";
const ASSIGN = flag("assign", "if-match");
const WAITING = flag("waitingCount", "derive");

const board = rt.atom("board", { rides: [] as Ride[], drivers: [] as Driver[], waiting: 0, selected: 0, zone: "all", busy: false, live: false, error: "", notice: "" });
type B = ReturnType<typeof board.get>;
const waitingOf = (rs: Ride[]) => rs.filter((r) => r.status === "waiting").length;
const visible = (r: Ride) => r.status === "waiting" || r.status === "assigned";

function upsert(s: B, r: Ride): B {
  const cur = s.rides.find((x) => x.id === r.id);
  if (cur && LIVE === "newer-wins" && Number(r.version) < Number(cur.version)) return s;
  const rides = (cur ? s.rides.map((x) => (x.id === r.id ? r : x)) : [...s.rides, r]).filter(visible);
  let waiting = waitingOf(rides);
  if (WAITING === "incremental") waiting = s.waiting + (r.status === "waiting" && cur?.status !== "waiting" ? 1 : 0) - (cur?.status === "waiting" && r.status !== "waiting" ? 1 : 0);
  return { ...s, rides, waiting };
}

async function loadRides() {
  try {
    const rides = itemsOf<Ride>(await api(`/api/rides?limit=40`)).filter(visible);
    board.update((s) => ({ ...s, rides, waiting: waitingOf(rides) }));
  } catch (e) {
    board.update((s) => ({ ...s, error: errText(e, "loading rides") }));
  }
}
async function loadDrivers() {
  try {
    const drivers = itemsOf<Driver>(await api(`/api/drivers?limit=20`));
    board.update((s) => ({ ...s, drivers }));
  } catch (e) {
    board.update((s) => ({ ...s, error: errText(e, "loading drivers") }));
  }
}

let assigning = false;
async function assign(d: Driver) {
  const s0 = board.get();
  const ride = s0.rides.find((r) => r.id === s0.selected);
  if (!ride || ride.status !== "waiting") return;
  if (ASSIGN_GUARD && assigning) return;
  assigning = true;
  board.update((s) => ({ ...s, busy: true, error: "", notice: "" }));
  try {
    const body: Record<string, unknown> = { status: "assigned", driverId: d.id };
    if (ASSIGN === "if-match") body.version = ride.version;
    const saved = await api<Ride>(`/api/rides/${ride.id}`, "PATCH", body);
    const drv = await api<Driver>(`/api/drivers/${d.id}`, "PATCH", { available: false });
    board.update((s) => ({ ...upsert(s, saved), drivers: s.drivers.map((x) => (x.id === drv.id ? drv : x)), selected: 0, notice: `${d.name} is on the way to ${saved.pickup}.` }));
  } catch (e) {
    if (e instanceof HttpError && e.status === 409 && e.body?.current) board.update((s) => ({ ...upsert(s, e.body.current), selected: 0, error: `Ride #${ride.id} was already taken by another dispatcher.` }));
    else board.update((s) => ({ ...s, error: errText(e, "the assignment") }));
  } finally {
    assigning = false;
    board.update((s) => ({ ...s, busy: false }));
  }
}

async function release(r: Ride) {
  try {
    const saved = await api<Ride>(`/api/rides/${r.id}`, "PATCH", { status: "waiting", driverId: 0, version: r.version });
    const drv = r.driverId ? await api<Driver>(`/api/drivers/${r.driverId}`, "PATCH", { available: true }) : null;
    board.update((s) => ({ ...upsert(s, saved), drivers: drv ? s.drivers.map((x) => (x.id === drv.id ? drv : x)) : s.drivers, notice: `Ride #${r.id} is back in the queue.` }));
  } catch (e) {
    if (e instanceof HttpError && e.status === 409 && e.body?.current) board.update((s) => ({ ...upsert(s, e.body.current), error: `Ride #${r.id} changed meanwhile.` }));
    else board.update((s) => ({ ...s, error: errText(e, "releasing the ride") }));
  }
}

class DispatchBoard extends LitElement {
  private b = new AtomController(this, board);
  render() {
    const s = this.b.value;
    const drivers = s.drivers.filter((d) => d.available && (s.zone === "all" || d.zone === s.zone));
    const name = (id: number) => s.drivers.find((d) => d.id === id)?.name ?? `driver ${id}`;
    return html`<h1>Dispatch</h1>
      <p class="status">${s.waiting} waiting · ${s.live ? "live" : "reconnecting…"}</p>
      ${s.error ? html`<p role="alert">${s.error}</p>` : s.notice ? html`<p class="notice">${s.notice}</p>` : nothing}
      <ul class="rides">${s.rides.map(
        (r) => html`<li class="ride ${r.status} ${r.id === s.selected ? "selected" : ""}">#${r.id} ${r.pickup} → ${r.dropoff} (${r.riders})
          ${r.status === "waiting" ? html`<button class="select" @click=${() => board.update((x) => ({ ...x, selected: r.id, notice: "" }))}>Select</button>` : html`<span>${name(r.driverId)}</span> <button class="release" @click=${() => void release(r)}>Release</button>`}</li>`,
      )}</ul>
      <label>Zone <select name="zone" @change=${(e: Event) => board.update((x) => ({ ...x, zone: (e.target as HTMLSelectElement).value }))}>${["all", "north", "south", "central"].map((z) => html`<option value=${z} ?selected=${z === s.zone}>${z}</option>`)}</select></label>
      <ul class="drivers">${drivers.map((d) => html`<li class="driver">${d.name} (${d.zone}) <button class="assign" ?disabled=${!s.selected || (ASSIGN_GUARD && s.busy)} @click=${() => void assign(d)}>Assign</button></li>`)}</ul>`;
  }
}
customElements.define("dispatch-board", DispatchBoard);
document.getElementById("app")!.appendChild(document.createElement("dispatch-board"));

let everUp = false;
liveTopic(
  "rides",
  (m) => {
    if (m.type === "deleted") board.update((s) => { const rides = s.rides.filter((r) => r.id !== m.id); return { ...s, rides, waiting: WAITING === "derive" ? waitingOf(rides) : s.waiting }; });
    else if (m.item) board.update((s) => upsert(s, m.item as Ride));
  },
  (up) => {
    board.update((s) => ({ ...s, live: up }));
    if (up && everUp && RECONNECT === "resync") void loadRides();
    if (up) everUp = true;
  },
);
void loadRides();
void loadDrivers();
setInterval(() => void loadDrivers(), 4000);
setInterval(() => board.get().rides.length === 0 && void loadRides(), 3000);
