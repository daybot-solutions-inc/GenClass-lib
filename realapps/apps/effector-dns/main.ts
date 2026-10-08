// DNS zone editor (effector stores/events/effects with a hand-written DOM layer; fetch). Pick a zone, change a
// record's TTL (optimistic, versioned PATCH: another admin edits the same zone), tick records and delete them in bulk
// (POST /records/bulk, per-item results), or add a record (one per type/name/value: a duplicate answers 409). The zone
// refreshes in the background. Stores are registered with rt.guard (w4-effector guardStore): async results go through
// the guarded writes, UI events update the stores directly. Latent bugs by flag: TTL changes sent without the version
// (ttlSave=force: another admin's change is overwritten), zone loads applied in arrival order (zoneSeq=blind: the
// table shows acme.dev under acme.io), an Add button live while posting (addGuard=none), bulk results ignored
// (bulk=assume-all: records the server kept vanish from the table) and a selection kept across zone switches
// (selection=keep: "Delete selected" removes records you can no longer see).
import { createEffect, createEvent, createStore, sample } from "effector";
import { flag } from "../_shared/genclass";
import { guardStore } from "../_shared/w4-effector";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Rec = { id: number; zone: string; type: string; name: string; value: string; ttl: number; fqdn: string; version: number };
type Zone = { zone: string; records: Rec[]; selected: number[]; loading: boolean; pending: number[]; busy: boolean; error: string; notice: string };
type Form = { type: string; name: string; value: string; adding: boolean };
const TTL_SAVE = flag("ttlSave", "if-match");
const ZONE_SEQ = flag("zoneSeq", "latest");
const ADD_GUARD = flag("addGuard", "pending") === "pending";
const BULK = flag("bulk", "per-item");
const SELECTION = flag("selection", "prune");
const ORDER = ["A", "CNAME", "MX", "TXT"];
const sortRecs = (rs: Rec[]) => [...rs].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || a.name.localeCompare(b.name) || a.id - b.id);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ------------------------------------------------------------------------------------------ stores
const $zone = createStore<Zone>({ zone: "acme.io", records: [], selected: [], loading: true, pending: [], busy: false, error: "", notice: "" });
const $form = createStore<Form>({ type: "A", name: "", value: "", adding: false });
const writeZone = guardStore("zone", $zone);
const writeForm = guardStore("form", $form);

const zonePicked = createEvent<string>();
const picked = createEvent<number>();
const ttlEdited = createEvent<{ id: number; ttl: number; prev: number }>();
const formEdited = createEvent<Partial<Form>>();
$zone.on(zonePicked, (z, zone) => ({ ...z, zone, loading: true, selected: SELECTION === "prune" ? [] : z.selected, error: "", notice: "" }));
$zone.on(picked, (z, id) => ({ ...z, selected: z.selected.includes(id) ? z.selected.filter((x) => x !== id) : [...z.selected, id] }));
$zone.on(ttlEdited, (z, { id, ttl }) => ({ ...z, records: z.records.map((r) => (r.id === id ? { ...r, ttl } : r)), pending: [...z.pending, id], error: "", notice: "" }));
$form.on(formEdited, (f, p) => ({ ...f, ...p }));

// ------------------------------------------------------------------------------------------ effects
let seq = 0;
const loadFx = createEffect(async ({ zone, background }: { zone: string; background: boolean }) => {
  const my = background ? seq : ++seq;
  return { my, zone, background, recs: itemsOf<Rec>(await api(`/api/records?zone=${encodeURIComponent(zone)}&limit=50`)) };
});
loadFx.doneData.watch(({ my, zone, background, recs }) =>
  writeZone((z) => {
    if ((background || ZONE_SEQ === "latest") && (my !== seq || z.zone !== zone)) return z;
    const local = new Map(z.records.map((r) => [r.id, r]));
    const records = sortRecs(recs.map((r) => (z.pending.includes(r.id) ? (local.get(r.id) ?? r) : r)));
    const selected = SELECTION === "prune" ? z.selected.filter((id) => records.some((r) => r.id === id)) : z.selected;
    return { ...z, records, selected, loading: false };
  }),
);
loadFx.fail.watch(({ params, error }) => !params.background && writeZone((z) => (z.zone !== params.zone ? z : { ...z, loading: false, error: errText(error, `loading ${params.zone}`) })));
sample({ clock: zonePicked, fn: (zone) => ({ zone, background: false }), target: loadFx });

const ttlFx = createEffect(async ({ rec, ttl }: { rec: Rec; ttl: number; prev: number }) => api<Rec>(`/api/records/${rec.id}`, "PATCH", TTL_SAVE === "if-match" ? { ttl, version: rec.version } : { ttl }));
sample({ clock: ttlEdited, source: $zone, fn: (z, e) => ({ rec: z.records.find((r) => r.id === e.id)!, ttl: e.ttl, prev: e.prev }), target: ttlFx });
ttlFx.done.watch(({ result }) => writeZone((z) => ({ ...z, records: z.records.map((r) => (r.id === result.id ? result : r)), notice: `${result.type} ${result.name} now has TTL ${result.ttl}s.` })));
ttlFx.fail.watch(({ params, error }) => {
  const cur = error instanceof HttpError && error.status === 409 ? (error.body?.current as Rec | undefined) : undefined;
  writeZone((z) => ({ ...z, records: z.records.map((r) => (r.id === params.rec.id ? (cur ?? { ...r, ttl: params.prev }) : r)), error: cur ? `${cur.type} ${cur.name} was changed by another admin (TTL ${cur.ttl}s).` : errText(error, `saving the TTL of ${params.rec.name}`) }));
});
ttlFx.finally.watch(({ params }) => writeZone((z) => ({ ...z, pending: z.pending.filter((x) => x !== params.rec.id) })));

const deleteFx = createEffect(async (ids: number[]) => (await api<{ results: { id: number; ok: boolean }[] }>(`/api/records/bulk`, "POST", { ids, op: "delete" })).results ?? []);
deleteFx.watch(() => writeZone((z) => ({ ...z, busy: true, error: "", notice: "" })));
deleteFx.done.watch(({ params, result }) => {
  const gone = new Set(BULK === "per-item" ? result.filter((r) => r.ok).map((r) => Number(r.id)) : params);
  const failed = params.length - result.filter((r) => r.ok).length;
  writeZone((z) => ({ ...z, records: z.records.filter((r) => !gone.has(r.id)), selected: z.selected.filter((id) => !gone.has(id)), notice: `Deleted ${gone.size} record(s).`, error: BULK === "per-item" && failed ? `${failed} record(s) could not be deleted.` : "" }));
});
deleteFx.failData.watch((e) => writeZone((z) => ({ ...z, error: errText(e, "deleting records") })));
deleteFx.finally.watch(() => writeZone((z) => ({ ...z, busy: false })));

const addFx = createEffect(async ({ zone, f }: { zone: string; f: Form }) =>
  api<Rec>(`/api/records`, "POST", { zone, type: f.type, name: f.name.trim(), value: f.value.trim(), ttl: 300, fqdn: `${zone}|${f.type}|${f.name.trim()}|${f.value.trim()}` }),
);
addFx.watch(() => writeForm((f) => ({ ...f, adding: true })));
addFx.done.watch(({ params, result }) => {
  writeZone((z) => (z.zone !== params.zone || z.records.some((r) => r.id === result.id) ? z : { ...z, records: sortRecs([...z.records, result]), notice: `Added ${result.type} ${result.name}.`, error: "" }));
  writeForm((f) => ({ ...f, name: "", value: "" }));
  (document.querySelector("form.add input[name=name]") as HTMLInputElement).value = "";
  (document.querySelector("form.add input[name=value]") as HTMLInputElement).value = "";
});
addFx.fail.watch(({ params, error }) => writeZone((z) => ({ ...z, error: error instanceof HttpError && error.status === 409 ? `${params.f.type} ${params.f.name} → ${params.f.value} already exists.` : errText(error, "adding the record") })));
addFx.finally.watch(() => writeForm((f) => ({ ...f, adding: false })));

// ------------------------------------------------------------------------------------------ DOM
const root = document.getElementById("app")!;
root.innerHTML = `<main class="dns"><h1>DNS</h1>
  <label>Zone <select name="zone"><option>acme.io</option><option>acme.dev</option><option>shop.acme.io</option></select></label> <span class="summary"></span>
  <div class="msg"></div>
  <table><thead><tr><th></th><th>Type</th><th>Name</th><th>Value</th><th>TTL</th></tr></thead><tbody></tbody></table>
  <button type="button" class="delete-selected">Delete selected</button>
  <form class="add"><select name="type"><option>A</option><option>CNAME</option><option>TXT</option></select>
    <input name="name" placeholder="name"> <input name="value" placeholder="value"> <button type="submit">Add record</button></form></main>`;
const q = <T extends Element>(s: string) => root.querySelector(s) as T;

function renderZone(z: Zone) {
  q("span.summary").textContent = z.loading ? "Loading…" : `${z.records.length} records · ${z.selected.length} selected`;
  q("div.msg").innerHTML = z.error ? `<p role="alert">${esc(z.error)}</p>` : z.notice ? `<p class="notice">${esc(z.notice)}</p>` : "";
  q("tbody").innerHTML = z.records
    .map((r) => `<tr class="record" data-id="${r.id}"><td><input type="checkbox" class="pick"${z.selected.includes(r.id) ? " checked" : ""}></td><td>${r.type}</td><td>${esc(r.name)}</td><td>${esc(r.value)}</td>
      <td><select class="ttl"${z.pending.includes(r.id) ? " disabled" : ""}>${[60, 300, 600, 1800, 3600, 86400].map((t) => `<option value="${t}"${t === r.ttl ? " selected" : ""}>${t}</option>`).join("")}${[60, 300, 600, 1800, 3600, 86400].includes(r.ttl) ? "" : `<option selected>${r.ttl}</option>`}</select></td></tr>`)
    .join("");
  q<HTMLButtonElement>("button.delete-selected").disabled = z.busy || z.selected.length === 0;
}
$zone.watch(renderZone);
$form.watch((f) => {
  const b = q<HTMLButtonElement>("form.add button");
  b.disabled = ADD_GUARD && f.adding;
  b.textContent = f.adding ? "Adding…" : "Add record";
});

root.addEventListener("change", (e) => {
  const t = e.target as HTMLElement;
  if (t.matches("select[name=zone]")) zonePicked((t as HTMLSelectElement).value);
  else if (t.matches("select.ttl")) {
    const id = Number(t.closest("tr")!.dataset.id);
    const rec = $zone.getState().records.find((r) => r.id === id);
    if (rec) ttlEdited({ id, ttl: Number((t as HTMLSelectElement).value), prev: rec.ttl });
  }
  else if (t.matches("input.pick")) picked(Number(t.closest("tr")!.dataset.id));
  else if (t.matches("form.add select[name=type]")) formEdited({ type: (t as HTMLSelectElement).value });
});
root.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.matches("form.add input")) formEdited({ [t.name]: t.value } as Partial<Form>);
});
root.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).matches("button.delete-selected")) {
    const z = $zone.getState();
    if (z.selected.length && !z.busy) void deleteFx(z.selected);
  }
});
q("form.add").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = $form.getState();
  if (!f.name.trim() || !f.value.trim() || (ADD_GUARD && f.adding)) return;
  void addFx({ zone: $zone.getState().zone, f });
});

zonePicked("acme.io");
setInterval(() => {
  const z = $zone.getState();
  if (!z.loading) void loadFx({ zone: z.zone, background: true });
}, 5000);
