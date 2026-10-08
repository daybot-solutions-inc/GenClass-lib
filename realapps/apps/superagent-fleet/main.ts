// Delivery-fleet dispatch board (plain TypeScript DOM code + superagent over XMLHttpRequest; observe-only: the
// rendered board is the state). Driver assignments are versioned PATCHes (If-Match); other dispatchers edit the same
// vehicles and the board polls. Latent bugs by flag: a 409 answered by sending the change again without a version
// (conflict=overwrite: the other dispatcher's assignment is silently replaced) or by keeping the optimistic value
// (conflict=ignore), poll results that overwrite rows with in-flight or newer local edits (pollMerge=overwrite: the
// assignment flickers back, or a poll issued before the save lands after it), superagent's .retry() on every request
// (retry=2: a committed note or assignment retried after a 5xx — duplicate notes, self-inflicted 409s) and
// assignment selects that stay editable while saving (assignGuard=none).
import request from "superagent";
import { flag } from "../_shared/genclass";

type Vehicle = { id: number; code: string; model: string; depot: string; status: "idle" | "en-route" | "maintenance"; driverId: string | null; version: number };
type Driver = { id: string; name: string; shift: string };
type Note = { id: number; vehicleId: number; text: string; author: string };

const CONFLICT = flag("conflict", "refetch") as "refetch" | "overwrite" | "ignore";
const POLL_MERGE = flag("pollMerge", "skip-pending") as "skip-pending" | "overwrite";
const RETRY = Number(flag("retry", 0));
const ASSIGN_GUARD = flag("assignGuard", "pending") as "pending" | "none";
const POLL_MS = Number(flag("pollMs", 5000));

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const call = <T extends request.SuperAgentRequest>(r: T) => r.set("Accept", "application/json").timeout({ response: 6000, deadline: 12000 }).retry(RETRY);

let board: Vehicle[] = [];
let drivers: Driver[] = [];
const pending = new Set<number>();
const touchedAt = new Map<number, number>(); // when a row last changed locally
let tick = 0;

const root = document.getElementById("app")!;
root.innerHTML = `
  <header><h1>Metro Courier — Dispatch board</h1><p class="sub">Day shift · <span class="counts"></span></p></header>
  <div class="flash"></div>
  <div class="toolbar"><label>Depot <select name="depot"><option value="all">All depots</option><option value="North">North</option><option value="South">South</option></select></label> <button type="button" class="refresh">Refresh</button></div>
  <table class="board"><thead><tr><th>Vehicle</th><th>Status</th><th>Driver</th><th></th></tr></thead><tbody><tr><td colspan="4">Loading fleet…</td></tr></tbody></table>
  <section class="notes"><h2>Vehicle notes</h2>
    <form class="note-form"><select name="noteVehicle"></select> <textarea name="note" rows="2" placeholder="Add a note for the next driver"></textarea> <button type="submit" class="add-note">Add note</button></form>
    <ul class="note-list"></ul></section>`;
const $ = <T extends Element = HTMLElement>(s: string) => root.querySelector(s) as T;

function flash(msg: string, kind: "error" | "ok" = "error") {
  $(".flash").innerHTML = kind === "error" ? `<p role="alert">${esc(msg)}</p>` : `<p class="ok">${esc(msg)}</p>`;
}

const driverName = (id: string | null) => (id ? drivers.find((d) => d.id === id)?.name ?? id : "Unassigned");

function render() {
  const depot = $<HTMLSelectElement>("select[name=depot]").value;
  const rows = board.filter((v) => depot === "all" || v.depot === depot);
  $("table.board tbody").innerHTML = rows
    .map((v) => {
      const busy = pending.has(v.id);
      const opts = [`<option value="">Unassigned</option>`, ...drivers.map((d) => {
        const other = board.find((x) => x.driverId === d.id && x.id !== v.id);
        return `<option value="${d.id}"${d.id === v.driverId ? " selected" : ""}>${esc(d.name)}${other ? ` (on ${other.code})` : ""}</option>`;
      })].join("");
      return `<tr class="vehicle status-${v.status}" data-id="${v.id}"><td><strong>${esc(v.code)}</strong> ${esc(v.model)} · ${esc(v.depot)}</td><td>${esc(v.status)}${busy ? " · saving…" : ""}</td>
        <td><select class="driver" aria-label="Driver for ${esc(v.code)}"${busy && ASSIGN_GUARD === "pending" ? " disabled" : ""}>${opts}</select></td>
        <td><button type="button" class="unassign"${!v.driverId ? " disabled" : ""}>Unassign</button> <button type="button" class="dispatch"${v.status === "maintenance" || !v.driverId ? " disabled" : ""}>${v.status === "en-route" ? "Recall" : "Dispatch"}</button></td></tr>`;
    })
    .join("") || `<tr><td colspan="4">No vehicles in this depot.</td></tr>`;
  const out = board.filter((v) => v.status === "en-route").length;
  $(".counts").textContent = `${out} on the road · ${board.filter((v) => v.driverId).length} of ${board.length} vehicles staffed`;
}

function upsert(v: Vehicle) {
  board = board.map((x) => (x.id === v.id ? v : x));
  touchedAt.set(v.id, ++tick);
}

// ---------------------------------------------------------------------------------------------- writes
async function patchVehicle(id: number, body: Partial<Vehicle>, label: string) {
  const v = board.find((x) => x.id === id);
  if (!v) return;
  if (ASSIGN_GUARD === "pending" && pending.has(id)) return;
  const before = { ...v };
  pending.add(id);
  upsert({ ...v, ...body });
  render();
  const send = (withVersion: boolean) => {
    const r = call(request.patch(`/api/vehicles/${id}`));
    return (withVersion ? r.set("If-Match", String(before.version)) : r).send(body);
  };
  try {
    const res = await send(true);
    upsert(res.body as Vehicle);
    flash(`${v.code}: ${label}.`, "ok");
  } catch (err) {
    const status = (err as { status?: number }).status ?? 0;
    if (status === 409) {
      if (CONFLICT === "overwrite") {
        try {
          upsert((await send(false)).body as Vehicle);
          flash(`${v.code}: ${label}.`, "ok");
        } catch {
          upsert(before);
          flash(`${v.code}: the change could not be saved.`);
        }
      } else if (CONFLICT === "refetch") {
        const cur = ((err as { response?: { body?: { current?: Vehicle } } }).response?.body?.current) ?? (await call(request.get(`/api/vehicles/${id}`)).then((r) => r.body as Vehicle).catch(() => before));
        upsert(cur);
        flash(`${v.code} was changed by another dispatcher (now ${driverName(cur.driverId)}, ${cur.status}). Review it and try again.`);
      } else {
        flash(`${v.code}: someone else changed this vehicle.`);
      }
    } else {
      upsert(before);
      flash(status ? `${v.code}: the change was rejected (${status}).` : `${v.code}: the dispatch service is unreachable.`);
    }
  } finally {
    pending.delete(id);
    render();
  }
}

async function dispatchToggle(id: number) {
  const v = board.find((x) => x.id === id);
  if (!v || (ASSIGN_GUARD === "pending" && pending.has(id))) return;
  pending.add(id);
  render();
  try {
    const res = await call(request.post(`/api/vehicles/${id}/${v.status === "en-route" ? "recall" : "dispatch"}`)).send({});
    upsert(res.body as Vehicle);
  } catch {
    flash(`${v.code} could not be ${v.status === "en-route" ? "recalled" : "dispatched"}.`);
  } finally {
    pending.delete(id);
    render();
  }
}

// ------------------------------------------------------------------------------------------------ poll
let pollSeq = 0;
let appliedPoll = 0;
async function poll() {
  const issuedAt = tick;
  const mine = ++pollSeq;
  try {
    const res = await call(request.get("/api/vehicles").query({ limit: 50 }));
    // an older poll that answers late must not replace a newer board
    if (POLL_MERGE === "skip-pending" && mine < appliedPoll) return;
    appliedPoll = mine;
    const fresh = res.body as Vehicle[];
    board = fresh.map((s) => {
      const local = board.find((x) => x.id === s.id);
      if (POLL_MERGE === "skip-pending" && local && (pending.has(s.id) || (touchedAt.get(s.id) ?? 0) > issuedAt)) return local;
      return s;
    });
    render();
  } catch {
    /* the next tick will try again */
  }
}

// ----------------------------------------------------------------------------------------------- notes
let notesReq = 0;
async function loadNotes() {
  const vid = Number($<HTMLSelectElement>("select[name=noteVehicle]").value);
  const mine = ++notesReq;
  try {
    const res = await call(request.get("/api/notes").query({ vehicleId: vid, sort: "-createdAt", limit: 5 }));
    if (mine !== notesReq) return;
    const notes = res.body as Note[];
    $(".note-list").innerHTML = notes.map((n) => `<li>${esc(n.text)} <small>— ${esc(n.author)}</small></li>`).join("") || `<li class="muted">No notes for this vehicle.</li>`;
  } catch {
    if (mine === notesReq) $(".note-list").innerHTML = `<li role="alert">Notes could not be loaded.</li>`;
  }
}

$(".note-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ta = $<HTMLTextAreaElement>("textarea[name=note]");
  const text = ta.value.trim();
  if (!text) return;
  const btn = $<HTMLButtonElement>("button.add-note");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await call(request.post("/api/notes")).send({ vehicleId: Number($<HTMLSelectElement>("select[name=noteVehicle]").value), text, author: "dispatch" });
    ta.value = "";
    void loadNotes();
  } catch {
    flash("The note was not saved.");
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------------------------- events
$("table.board").addEventListener("change", (e) => {
  const sel = e.target as HTMLSelectElement;
  if (!sel.classList.contains("driver")) return;
  const id = Number(sel.closest<HTMLElement>("tr")!.dataset.id);
  const driverId = sel.value || null;
  void patchVehicle(id, { driverId }, driverId ? `assigned to ${driverName(driverId)}` : "driver removed");
});
$("table.board").addEventListener("click", (e) => {
  const btn = (e.target as Element).closest("button");
  const id = Number(btn?.closest<HTMLElement>("tr")?.dataset.id);
  if (!btn || !id) return;
  if (btn.classList.contains("unassign")) void patchVehicle(id, { driverId: null }, "driver removed");
  else if (btn.classList.contains("dispatch")) void dispatchToggle(id);
});
$("select[name=depot]").addEventListener("change", render);
$("select[name=noteVehicle]").addEventListener("change", () => void loadNotes());
$(".refresh").addEventListener("click", () => void poll());

async function boot() {
  try {
    const [vs, ds] = await Promise.all([call(request.get("/api/vehicles").query({ limit: 50 })), call(request.get("/api/drivers"))]);
    board = vs.body as Vehicle[];
    drivers = ds.body as Driver[];
    $("select[name=noteVehicle]").innerHTML = board.map((v) => `<option value="${v.id}">${esc(v.code)}</option>`).join("");
    render();
    void loadNotes();
  } catch {
    flash("The fleet could not be loaded. Retrying…");
    setTimeout(() => void boot(), 3000);
    return;
  }
  setInterval(() => void poll(), POLL_MS);
}
void boot();
