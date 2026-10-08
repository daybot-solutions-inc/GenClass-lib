// Vet clinic front desk (Valtio vanilla proxy registered with rt.guard, rendered with lit-html; fetch + WebSocket).
// Walk-ins are checked in (shown at once, then POST /patients with a client id), the nurse re-triages waiting pets
// (versioned PATCH of the priority), and the desk calls the next pet into a free room (versioned PATCH: the second
// desk calls patients into its exam rooms too). Vets mark visits done and the kiosk adds check-ins, all live.
// Latent bugs by flag: calls sent without the version (callNext=force: a pet the other desk just called is moved
// again), the optimistic check-in not reconciled with its live echo (checkin=append: the pet shows twice), pushes
// applied in arrival order (live=blind), a waiting order computed once per load instead of on every change
// (order=stale: "next" is no longer the most urgent pet) and a waiting counter kept by hand (waitingCount=incremental).
import { html, render } from "lit";
import { proxy, snapshot, subscribe } from "valtio/vanilla";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

type Patient = { id: number | string; clientId?: string; pet: string; species: string; owner: string; reason: string; priority: string; status: string; room: string; arrived: string; version: number; pending?: boolean };
interface Desk {
  patients: Patient[];
  queue: (number | string)[];
  waitingCount: number;
  pending: (number | string)[];
  calling: string[];
  draft: { pet: string; owner: string; species: string };
  checkingIn: boolean;
  live: boolean;
  error: string;
  notice: string;
}
const CALL_NEXT = flag("callNext", "if-match");
const CHECKIN = flag("checkin", "reconcile");
const LIVE = flag("live", "version-check");
const ORDER = flag("order", "recompute");
const WAITING = flag("waitingCount", "derive");
const ROOMS = ["Room 1", "Room 2", "Room 3"];
const RANK: Record<string, number> = { emergency: 0, urgent: 1, routine: 2 };

const state = proxy<Desk>({ patients: [], queue: [], waitingCount: 0, pending: [], calling: [], draft: { pet: "", owner: "", species: "dog" }, checkingIn: false, live: false, error: "", notice: "" });
const desk = rt.guard<Desk>("desk", {
  get: () => snapshot(state) as Desk,
  set: (v) => void Object.assign(state, structuredClone(v)),
  subscribe: (fn) => subscribe(state, () => fn()),
});
const commit = (fn: (d: Desk) => void) =>
  desk.update((s) => {
    const d = structuredClone(s) as Desk;
    fn(d);
    return d;
  });
const waitingOf = (ps: Patient[]) => ps.filter((p) => p.status === "waiting");
const ordered = (ps: Patient[]) => waitingOf(ps).sort((a, b) => RANK[a.priority]! - RANK[b.priority]! || a.arrived.localeCompare(b.arrived) || String(a.id).localeCompare(String(b.id))).map((p) => p.id);
function settle(d: Desk, before: Patient | undefined, after: Patient | undefined, _created: boolean) {
  // stale: the order computed at load only gets new arrivals appended at the end
  if (ORDER === "recompute") d.queue = ordered(d.patients);
  else if (after && after.status === "waiting" && !d.queue.includes(after.id)) d.queue.push(after.id);
  if (WAITING === "derive") d.waitingCount = waitingOf(d.patients).length;
  else d.waitingCount += (after?.status === "waiting" ? 1 : 0) - (before?.status === "waiting" ? 1 : 0);
}
function upsert(d: Desk, p: Patient, reorder = false) {
  const i = d.patients.findIndex((x) => x.id === p.id || (CHECKIN === "reconcile" && p.clientId && x.clientId === p.clientId));
  const cur = i >= 0 ? d.patients[i] : undefined;
  if (cur && !cur.pending && LIVE === "version-check" && Number(p.version) < Number(cur.version)) return;
  if (i >= 0) d.patients[i] = p;
  else d.patients.push(p);
  settle(d, cur, p, reorder);
}

async function load() {
  try {
    const ps = itemsOf<Patient>(await api(`/api/patients?limit=50`)).filter((p) => p.status !== "done");
    commit((d) => {
      d.patients = [...ps, ...d.patients.filter((x) => x.pending)];
      d.queue = ordered(d.patients);
      d.waitingCount = waitingOf(d.patients).length;
    });
  } catch (e) {
    commit((d) => void (d.error = errText(e, "loading the waiting room")));
  }
}

let cid = 0;
async function checkIn(e: Event) {
  e.preventDefault();
  const { pet, owner, species } = state.draft;
  if (!pet.trim() || !owner.trim() || state.checkingIn) return;
  const clientId = `w${++cid}`;
  const temp: Patient = { id: clientId, clientId, pet: pet.trim(), species, owner: owner.trim(), reason: "walk-in", priority: "routine", status: "waiting", room: "", arrived: "09:30", version: 0, pending: true };
  commit((d) => {
    upsert(d, temp, true);
    d.draft = { pet: "", owner: "", species: "dog" };
    d.checkingIn = true;
    d.error = "";
    d.notice = "";
  });
  try {
    const { id: _tmp, pending: _p, ...body } = temp;
    const saved = await api<Patient>(`/api/patients`, "POST", body);
    commit((d) => {
      if (CHECKIN === "reconcile") upsert(d, saved, true);
      else {
        const i = d.patients.findIndex((x) => x.id === clientId);
        if (i >= 0) d.patients[i] = saved;
        d.queue = d.queue.map((id) => (id === clientId ? saved.id : id));
      }
      d.notice = `${saved.pet} is checked in.`;
    });
  } catch (err) {
    commit((d) => {
      const gone = d.patients.find((x) => x.id === clientId);
      d.patients = d.patients.filter((x) => x.id !== clientId);
      settle(d, gone, undefined, true);
      d.error = errText(err, `checking in ${temp.pet}`);
    });
  } finally {
    commit((d) => void (d.checkingIn = false));
  }
}

async function triage(p: Patient, priority: string) {
  if (typeof p.id !== "number" || state.pending.includes(p.id)) return;
  commit((d) => {
    d.pending.push(p.id);
    const x = d.patients.find((y) => y.id === p.id);
    if (x) x.priority = priority;
    settle(d, x, x, false);
  });
  try {
    const saved = await api<Patient>(`/api/patients/${p.id}`, "PATCH", { priority, version: p.version });
    commit((d) => upsert(d, saved));
  } catch (err) {
    const cur = err instanceof HttpError && err.status === 409 ? (err.body?.current as Patient | undefined) : undefined;
    commit((d) => {
      upsert(d, cur ?? p);
      d.error = cur ? `${p.pet} was updated on another screen.` : errText(err, `re-triaging ${p.pet}`);
    });
  } finally {
    commit((d) => void (d.pending = d.pending.filter((x) => x !== p.id)));
  }
}

async function call(room: string) {
  if (state.calling.includes(room)) return;
  const s = desk.get();
  const nextId = s.queue.find((id) => typeof id === "number" && !s.pending.includes(id) && s.patients.some((p) => p.id === id && p.status === "waiting"));
  const p = s.patients.find((x) => x.id === nextId);
  if (!p) return void commit((d) => void (d.notice = "Nobody is waiting."));
  commit((d) => {
    d.calling.push(room);
    d.pending.push(p.id);
    d.error = "";
    d.notice = "";
  });
  try {
    const saved = await api<Patient>(`/api/patients/${p.id}`, "PATCH", CALL_NEXT === "if-match" ? { status: "in-room", room, version: p.version } : { status: "in-room", room });
    commit((d) => {
      upsert(d, saved);
      d.notice = `${saved.pet} (${saved.owner}) to ${room}, please.`;
    });
  } catch (err) {
    const cur = err instanceof HttpError && err.status === 409 ? (err.body?.current as Patient | undefined) : undefined;
    commit((d) => {
      if (cur) upsert(d, cur);
      d.error = cur ? `${p.pet} was just called by the other desk — call again for the next pet.` : errText(err, `calling ${p.pet}`);
    });
  } finally {
    commit((d) => {
      d.calling = d.calling.filter((r) => r !== room);
      d.pending = d.pending.filter((x) => x !== p.id);
    });
  }
}

const occupied = (s: Desk, room: string) => s.patients.some((p) => p.status === "in-room" && p.room === room);
const field = (k: "pet" | "owner" | "species") => (e: Event) => void (state.draft[k] = (e.target as HTMLInputElement).value);
function view(s: Desk) {
  const byId = new Map(s.patients.map((p) => [p.id, p]));
  const queue = s.queue.map((id) => byId.get(id)).filter((p): p is Patient => !!p && p.status === "waiting");
  return html`<main class="desk">
    <h1>Front desk · Riverside Vets</h1>
    <p class="status">${s.waitingCount} waiting · ${s.live ? "live" : "reconnecting…"}</p>
    <nav class="rooms">${ROOMS.map((r) => html`<button type="button" ?disabled=${occupied(s, r) || s.calling.includes(r)} @click=${() => void call(r)}>${occupied(s, r) ? `${r} busy` : `Call next to ${r}`}</button>`)}</nav>
    ${s.error ? html`<p role="alert">${s.error}</p>` : s.notice ? html`<p class="notice">${s.notice}</p>` : ""}
    <ol class="queue">${queue.map(
      (p) => html`<li class="patient ${p.priority}">${p.pet} (${p.species}) · ${p.owner} · ${p.reason} · since ${p.arrived}${p.pending ? " · checking in…" : ""}
        <select class="priority" ?disabled=${typeof p.id !== "number" || s.pending.includes(p.id)} @change=${(e: Event) => void triage(p, (e.target as HTMLSelectElement).value)}>
          ${["routine", "urgent", "emergency"].map((x) => html`<option value=${x} ?selected=${x === p.priority}>${x}</option>`)}</select></li>`,
    )}</ol>
    <h2>In rooms</h2>
    <ul class="rooms-list">${s.patients.filter((p) => p.status === "in-room").map((p) => html`<li class="in-room">${p.room}: ${p.pet} (${p.owner})</li>`)}</ul>
    <form class="checkin" @submit=${(e: Event) => void checkIn(e)}>
      <input name="pet" placeholder="Pet's name" .value=${s.draft.pet} @input=${field("pet")}>
      <input name="owner" placeholder="Owner's surname" .value=${s.draft.owner} @input=${field("owner")}>
      <select name="species" @change=${field("species")}>${["dog", "cat", "rabbit", "bird"].map((x) => html`<option ?selected=${x === s.draft.species}>${x}</option>`)}</select>
      <button type="submit" ?disabled=${s.checkingIn}>${s.checkingIn ? "Checking in…" : "Check in walk-in"}</button>
    </form>
  </main>`;
}
const root = document.getElementById("app")!;
const paint = () => render(view(snapshot(state) as Desk), root);
subscribe(state, paint);
paint();

let everUp = false;
liveTopic(
  "patients",
  (m) => {
    if (m.type === "deleted") commit((d) => void (d.patients = d.patients.filter((p) => p.id !== m.id)));
    else if (m.item) commit((d) => upsert(d, m.item as Patient, m.type === "created"));
  },
  (up) => {
    commit((d) => void (d.live = up));
    if (up && everUp) void load();
    if (up) everUp = true;
  },
);
void load();
