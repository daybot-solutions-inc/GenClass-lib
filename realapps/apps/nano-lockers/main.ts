// Courier handheld at a parcel-locker bank (nanostores map/computed with a hand-written DOM layer; fetch + WebSocket;
// the stores are not registered with GenClass: observe-only). The courier filters the doors by size, picks the next
// parcel from the van, reserves a free door for it (POST /reservations, one per door+parcel, then POST
// /compartments/:id/occupy), opens the door (POST .../open, a relative counter) and can release a door again (the parcel
// goes back to the van). Other couriers and recipients use the bank at the same time; door states stream in live.
// Latent bugs by flag: Reserve buttons live while the two-step reservation runs (reserveGuard=none: a double tap
// posts the reservation twice and the second answers 409 over a successful drop), pushes applied in arrival order
// (live=blind: an older "free" overwrites "occupied"), reconnects without a reload (reconnect=naive: doors that
// changed while offline keep their old state), a reservation left behind when occupying the door fails
// (steps=dangling: the handheld shows the parcel in a door the server still has free) and size tabs applied in
// arrival order (sizeSeq=blind: the Small tab lists the large doors).
import { computed, map } from "nanostores";
import { flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

type Size = "S" | "M" | "L";
type Door = { id: number; name: string; size: Size; status: "free" | "occupied" | "out-of-service"; by: string; opens: number; updatedAt?: string };
type Parcel = { code: string; to: string; size: Size };
type Held = { resId: number; parcel: string };
const RESERVE_GUARD = flag("reserveGuard", "pending") === "pending";
const LIVE = flag("live", "newer-wins");
const RECONNECT = flag("reconnect", "resync");
const STEPS = flag("steps", "rollback");
const SIZE_SEQ = flag("sizeSeq", "latest");
const SIZE_NAME: Record<Size, string> = { S: "small", M: "medium", L: "large" };
const VAN: Parcel[] = [
  { code: "PX-4460", to: "Haddad", size: "L" }, { code: "PX-4471", to: "Okafor", size: "S" }, { code: "PX-4475", to: "Lindqvist", size: "M" },
  { code: "PX-4479", to: "Moreau", size: "S" }, { code: "PX-4482", to: "Tanaka", size: "M" }, { code: "PX-4486", to: "Santos", size: "L" },
  { code: "PX-4490", to: "Novak", size: "S" }, { code: "PX-4493", to: "Ferreira", size: "M" }, { code: "PX-4497", to: "Achebe", size: "S" },
];

const $bank = map({ size: "all" as Size | "all", doors: [] as Door[], loading: true, held: {} as Record<number, Held>, placed: ["PX-4460"] as string[], parcel: "PX-4471", busy: [] as number[], live: false, error: "", notice: "" });
type Bank = ReturnType<typeof $bank.get>;
const $van = computed($bank, (b) => VAN.filter((p) => !b.placed.includes(p.code)));
const set = (patch: Partial<Bank>) => $bank.set({ ...$bank.get(), ...patch });
const parcelOf = (code: string) => VAN.find((p) => p.code === code);
const nextParcel = (placed: string[], cur: string) => (placed.includes(cur) ? (VAN.find((p) => !placed.includes(p.code))?.code ?? "") : cur);
const busyOff = (id: number) => set({ busy: $bank.get().busy.filter((x) => x !== id) });
const withDoor = (d: Door) => set({ doors: $bank.get().doors.map((x) => (x.id === d.id ? d : x)) });

// ------------------------------------------------------------------------------------------- loads
let seq = 0;
async function loadDoors(size = $bank.get().size) {
  const my = ++seq;
  set({ size, loading: true, error: "" });
  try {
    const body = await api(`/api/compartments?limit=50${size === "all" ? "" : `&size=${size}`}`);
    if (SIZE_SEQ === "latest" && my !== seq) return;
    set({ doors: itemsOf<Door>(body), loading: false });
  } catch (e) {
    if (my === seq) set({ loading: false, error: errText(e, "loading the locker bank") });
  }
}
async function loadHeld() {
  try {
    const rs = itemsOf<{ id: number; compartmentId: number; parcel: string }>(await api(`/api/reservations?courier=me&limit=50`));
    const held: Record<number, Held> = Object.fromEntries(rs.map((r) => [r.compartmentId, { resId: r.id, parcel: r.parcel }]));
    const placed = rs.map((r) => r.parcel);
    set({ held, placed, parcel: nextParcel(placed, $bank.get().parcel) });
  } catch {
    /* keep what we have; the next resync tries again */
  }
}

// ------------------------------------------------------------------------------------------- actions
async function reserve(door: Door) {
  const b = $bank.get();
  const code = b.parcel;
  if (!code || (RESERVE_GUARD && b.busy.includes(door.id))) return;
  set({ busy: [...b.busy, door.id], error: "", notice: "" });
  let resId = 0;
  try {
    const res = await api<{ id: number }>(`/api/reservations`, "POST", { key: `${door.id}|${code}`, compartmentId: door.id, parcel: code, courier: "me" });
    resId = res.id;
    const s = $bank.get();
    const placed = s.placed.includes(code) ? s.placed : [...s.placed, code];
    set({ held: { ...s.held, [door.id]: { resId, parcel: code } }, placed, parcel: nextParcel(placed, s.parcel) });
    const occ = await api<Door>(`/api/compartments/${door.id}/occupy`, "POST");
    withDoor(occ);
    set({ notice: `Door ${door.name}: put ${code} for ${parcelOf(code)?.to} inside and close it.` });
  } catch (e) {
    if (!resId) {
      set({ error: e instanceof HttpError && e.status === 409 ? `${code} is already reserved in door ${door.name}.` : errText(e, `reserving door ${door.name}`) });
    } else if (STEPS === "rollback") {
      await api(`/api/reservations/${resId}`, "DELETE").catch(() => undefined);
      const s = $bank.get();
      const held = { ...s.held };
      delete held[door.id];
      set({ held, placed: s.placed.filter((p) => p !== code), error: `Door ${door.name} could not be locked for ${code} — the reservation was cancelled.` });
    } else set({ error: errText(e, `occupying door ${door.name}`) });
  } finally {
    busyOff(door.id);
  }
}

async function openDoor(door: Door) {
  const b = $bank.get();
  if (b.busy.includes(door.id)) return;
  set({ busy: [...b.busy, door.id], error: "", notice: "" });
  try {
    const d = await api<Door>(`/api/compartments/${door.id}/open`, "POST");
    withDoor(d);
    set({ notice: `Door ${d.name} is open.` });
  } catch (e) {
    set({ error: errText(e, `opening door ${door.name}`) });
  } finally {
    busyOff(door.id);
  }
}

async function release(door: Door) {
  const b = $bank.get();
  const h = b.held[door.id];
  if (!h || b.busy.includes(door.id)) return;
  set({ busy: [...b.busy, door.id], error: "", notice: "" });
  try {
    const d = await api<Door>(`/api/compartments/${door.id}/release`, "POST");
    withDoor(d);
    await api(`/api/reservations/${h.resId}`, "DELETE").catch((e) => {
      if (!(e instanceof HttpError && e.status === 404)) throw e;
    });
    const s = $bank.get();
    const held = { ...s.held };
    delete held[door.id];
    const placed = s.placed.filter((p) => p !== h.parcel);
    set({ held, placed, parcel: s.parcel || h.parcel, notice: `${h.parcel} is back in the van.` });
  } catch (e) {
    set({ error: errText(e, `releasing door ${door.name}`) });
  } finally {
    busyOff(door.id);
  }
}

// ------------------------------------------------------------------------------------------- live
let everUp = false;
liveTopic(
  "compartments",
  (m) => {
    if (m.type !== "updated" || !m.item) return;
    const d = m.item as Door;
    const cur = $bank.get().doors.find((x) => x.id === d.id);
    if (!cur) return;
    if (LIVE === "newer-wins" && cur.updatedAt && (!d.updatedAt || d.updatedAt < cur.updatedAt)) return;
    withDoor(d);
  },
  (up) => {
    set({ live: up });
    if (up && everUp && RECONNECT === "resync") {
      void loadDoors();
      void loadHeld();
    }
    if (up) everUp = true;
  },
);

// ------------------------------------------------------------------------------------------- DOM
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const root = document.getElementById("app")!;
root.innerHTML = `<main class="lockers"><h1>Locker bank KS-14 · 210 King St W</h1><p class="conn"></p>
  <nav class="sizes"><button type="button" data-size="S">Small</button> <button type="button" data-size="M">Medium</button> <button type="button" data-size="L">Large</button> <button type="button" data-size="all">All</button></nav>
  <label>Next parcel <select name="parcel"></select></label> <span class="van"></span>
  <div class="msg"></div><ul class="doors"></ul></main>`;
const $ = <T extends Element>(s: string) => root.querySelector(s) as T;
function render(b: Bank) {
  const van = $van.get();
  $("p.conn").textContent = `${b.live ? "live" : "reconnecting…"} · ${Object.keys(b.held).length} of your parcels in the bank`;
  for (const btn of root.querySelectorAll<HTMLButtonElement>("nav.sizes button")) btn.classList.toggle("on", btn.dataset.size === b.size);
  const sel = $<HTMLSelectElement>("select[name=parcel]");
  sel.innerHTML = van.map((p) => `<option value="${p.code}"${p.code === b.parcel ? " selected" : ""}>${p.code} → ${esc(p.to)} (${SIZE_NAME[p.size]})</option>`).join("") || `<option value="">Van is empty</option>`;
  sel.disabled = van.length === 0;
  $("span.van").textContent = `${van.length} left in the van`;
  $("div.msg").innerHTML = (b.error ? `<p role="alert">${esc(b.error)}</p>` : b.notice ? `<p class="notice">${esc(b.notice)}</p>` : "") + (b.loading ? `<p class="loading">Loading doors…</p>` : "");
  $("ul.doors").innerHTML = b.doors
    .map((d) => {
      const h = b.held[d.id];
      const busy = b.busy.includes(d.id);
      const what = h ? ` · ${h.parcel} for ${esc(parcelOf(h.parcel)?.to ?? "")} · opened ${d.opens}×` : "";
      const buttons = h
        ? `<button type="button" class="open"${busy ? " disabled" : ""}>Open door</button> <button type="button" class="release"${busy ? " disabled" : ""}>Release</button>`
        : d.status === "free"
          ? `<button type="button" class="reserve"${(RESERVE_GUARD && busy) || !b.parcel ? " disabled" : ""}>${busy ? "Reserving…" : "Reserve"}</button>`
          : "";
      return `<li class="compartment ${d.status}${h ? " mine" : ""}" data-id="${d.id}">Door ${esc(d.name)} · ${SIZE_NAME[d.size]} · ${d.status.replace(/-/g, " ")}${what} ${buttons}</li>`;
    })
    .join("");
}
$bank.subscribe(render);

root.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const size = t.closest<HTMLElement>("nav.sizes button")?.dataset.size;
  if (size) return void loadDoors(size as Size | "all");
  const door = $bank.get().doors.find((d) => d.id === Number(t.closest<HTMLElement>("li.compartment")?.dataset.id));
  if (!door || !t.matches("button")) return;
  if (t.matches("button.reserve")) void reserve(door);
  else if (t.matches("button.open")) void openDoor(door);
  else if (t.matches("button.release")) void release(door);
});
root.addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.matches("select[name=parcel]")) set({ parcel: t.value });
});
void loadDoors("all");
void loadHeld();
