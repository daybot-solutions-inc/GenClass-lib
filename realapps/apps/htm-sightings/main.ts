// Citizen-science wildlife sightings log (Preact + htm tagged templates and preact/hooks, a small useAtom hook over
// runtime atoms; fetch + WebSocket). The newest sightings load six at a time ("Older sightings" pages by cursor), a
// group filter narrows them (`group__in=` for grouped taxa), new sightings stream in live, volunteers confirm each
// other's sightings (POST /confirmations, one per person, then POST /sightings/:id/confirm: relative) and report their
// own (shown at once with a client id, then POST /sightings). Latent bugs by flag: older pages fetched by offset while
// new sightings keep arriving at the top (older=offset: a sighting shows twice), the live echo of your own report not
// reconciled with the POST answer (report=append: it shows twice), confirm buttons live while posting
// (confirmGuard=none: the second confirmation answers 409), an individuals tally kept by hand (tally=incremental) and
// reconnects without a reload (reconnect=naive: sightings reported while offline never show).
import { h, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import type { Atom } from "@genclass/runtime";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

const html = htm.bind(h);
type Sighting = { id: number | string; clientId?: string; species: string; group: string; count: number; place: string; observer: string; confirmations: number; createdAt?: string; pending?: boolean };
const OLDER = flag("older", "cursor");
const REPORT = flag("report", "reconcile");
const CONFIRM_GUARD = flag("confirmGuard", "pending") === "pending";
const TALLY = flag("tally", "derive");
const RECONNECT = flag("reconnect", "resync");
const PER = 6;
const GROUPS: Record<string, string[]> = { all: [], birds: ["songbird", "raptor", "waterbird"], mammals: ["mammal"], amphibians: ["amphibian", "reptile"] };
const SPECIES: [string, string][] = [["Great blue heron", "waterbird"], ["Red-tailed hawk", "raptor"], ["Northern cardinal", "songbird"], ["Red fox", "mammal"], ["American beaver", "mammal"], ["Spring peeper", "amphibian"], ["Painted turtle", "reptile"]];

const log = rt.atom("sightings", { group: "all", rows: [] as Sighting[], cursor: null as string | null, loading: true, loadingMore: false, tally: 0, confirmed: [] as (number | string)[], pending: [] as (number | string)[], live: false, error: "", notice: "" });
const report = rt.atom("report", { species: SPECIES[0]![0], count: "1", place: "Mill Pond", posting: false });
type L = ReturnType<typeof log.get>;
const sum = (rs: Sighting[]) => rs.reduce((a, r) => a + Number(r.count), 0);
const inGroup = (g: string, s: Sighting) => g === "all" || GROUPS[g]!.includes(s.group);
const withRows = (l: L, rows: Sighting[], delta: number): L => ({ ...l, rows, tally: TALLY === "derive" ? sum(rows) : l.tally + delta });
/** A sighting from the server (POST answer or push) merged in: by id, or by client id for our own report. */
function upsert(l: L, s: Sighting, top: boolean): L {
  const i = l.rows.findIndex((x) => x.id === s.id || (REPORT === "reconcile" && s.clientId && x.clientId === s.clientId));
  if (i < 0) return inGroup(l.group, s) ? withRows(l, top ? [s, ...l.rows] : [...l.rows, s], Number(s.count)) : l;
  const rows = l.rows.slice();
  const delta = Number(s.count) - Number(rows[i]!.count);
  rows[i] = s;
  return withRows(l, rows, delta);
}
const qs = (group: string, extra: string) => `/api/sightings?sort=-createdAt&limit=${PER}${GROUPS[group]!.length ? `&group__in=${GROUPS[group]!.join(",")}` : ""}${extra}`;

let seq = 0;
async function loadFirst() {
  const my = ++seq;
  const group = log.get().group;
  log.update((l) => ({ ...l, loading: true, error: "" }));
  try {
    const body = await api<{ items: Sighting[]; nextCursor?: string | null }>(qs(group, "&cursor="));
    if (my !== seq) return;
    const rows = itemsOf<Sighting>(body);
    log.update((l) => ({ ...l, rows: [...l.rows.filter((r) => r.pending), ...rows], cursor: body.nextCursor ?? null, tally: sum([...l.rows.filter((r) => r.pending), ...rows]), loading: false }));
  } catch (e) {
    if (my === seq) log.update((l) => ({ ...l, loading: false, error: errText(e, "loading sightings") }));
  }
}
async function loadOlder() {
  const l0 = log.get();
  if (l0.loading || l0.loadingMore || !l0.cursor) return;
  const my = seq;
  log.update((l) => ({ ...l, loadingMore: true, error: "" }));
  try {
    const shown = l0.rows.filter((r) => !r.pending).length;
    const body = await api<{ items: Sighting[]; nextCursor?: string | null; total?: number }>(qs(l0.group, OLDER === "cursor" ? `&cursor=${encodeURIComponent(l0.cursor)}` : `&offset=${shown}`));
    if (my !== seq) return void log.update((l) => ({ ...l, loadingMore: false }));
    const items = itemsOf<Sighting>(body);
    log.update((l) => {
      const fresh = OLDER === "cursor" ? items.filter((s) => !l.rows.some((r) => r.id === s.id)) : items;
      const next = OLDER === "cursor" ? (body.nextCursor ?? null) : shown + items.length < Number(body.total ?? 0) ? String(items[items.length - 1]?.id ?? "") : null;
      return { ...withRows(l, [...l.rows, ...fresh], sum(fresh)), cursor: next, loadingMore: false };
    });
  } catch (e) {
    log.update((l) => ({ ...l, loadingMore: false, error: errText(e, "loading older sightings") }));
  }
}

async function confirm(s: Sighting) {
  const l0 = log.get();
  if (typeof s.id !== "number" || s.observer === "you" || l0.confirmed.includes(s.id)) return;
  if (CONFIRM_GUARD && l0.pending.includes(s.id)) return;
  log.update((l) => ({ ...l, pending: [...l.pending, s.id], error: "", notice: "" }));
  try {
    await api(`/api/confirmations`, "POST", { sightingId: s.id, user: "you", key: `you|${s.id}` });
    const saved = await api<Sighting>(`/api/sightings/${s.id}/confirm`, "POST");
    log.update((l) => ({ ...upsert(l, saved, false), confirmed: [...l.confirmed, s.id], notice: `You confirmed the ${saved.species} at ${saved.place}.` }));
  } catch (e) {
    log.update((l) => ({ ...l, error: e instanceof HttpError && e.status === 409 ? `You already confirmed the ${s.species} at ${s.place}.` : errText(e, "confirming the sighting") }));
  } finally {
    log.update((l) => ({ ...l, pending: l.pending.filter((x) => x !== s.id) }));
  }
}

let cid = 0;
async function submit(ev: Event) {
  ev.preventDefault();
  const r = report.get();
  const count = Math.max(1, Number(r.count) || 1);
  if (r.posting) return;
  const group = SPECIES.find(([n]) => n === r.species)![1];
  const clientId = `c${++cid}`;
  const temp: Sighting = { id: clientId, clientId, species: r.species, group, count, place: r.place, observer: "you", confirmations: 0, pending: true };
  report.update((x) => ({ ...x, posting: true }));
  log.update((l) => ({ ...upsert(l, temp, true), error: "", notice: "" }));
  try {
    const saved = await api<Sighting>(`/api/sightings`, "POST", { species: r.species, group, count, place: r.place, observer: "you", confirmations: 0, clientId });
    log.update((l) => {
      const swapped = REPORT === "reconcile" ? upsert(l, saved, true) : { ...l, rows: l.rows.map((x) => (x.id === clientId ? saved : x)) };
      return { ...swapped, notice: `Thanks! Your ${saved.species} sighting is logged.` };
    });
  } catch (e) {
    log.update((l) => ({ ...withRows(l, l.rows.filter((x) => x.id !== clientId), -count), error: errText(e, "reporting your sighting") }));
  } finally {
    report.update((x) => ({ ...x, posting: false }));
  }
}

function useAtom<T>(a: Atom<T>): T {
  const [v, set] = useState(() => a.get());
  useEffect(() => {
    set(() => a.get());
    return a.subscribe((x) => set(() => x));
  }, [a]);
  return v;
}

function App() {
  const l = useAtom(log);
  const r = useAtom(report);
  const setR = (patch: Partial<typeof r>) => report.update((x) => ({ ...x, ...patch }));
  return html`<main class="sightings">
    <h1>Riverside wildlife log</h1>
    <p class="status">${l.loading ? "Loading…" : `${l.rows.length} sightings · ${l.tally} individuals`} · ${l.live ? "live" : "reconnecting…"}</p>
    <label>Group <select name="group" value=${l.group} onChange=${(e: Event) => { log.update((x) => ({ ...x, group: (e.target as HTMLSelectElement).value, notice: "" })); void loadFirst(); }}>
      ${Object.keys(GROUPS).map((g) => html`<option value=${g}>${g[0]!.toUpperCase() + g.slice(1)}</option>`)}</select></label>
    <form class="report" onSubmit=${(e: Event) => void submit(e)}>
      <select name="species" value=${r.species} onChange=${(e: Event) => setR({ species: (e.target as HTMLSelectElement).value })}>${SPECIES.map(([n]) => html`<option value=${n}>${n}</option>`)}</select>
      <input name="count" inputmode="numeric" value=${r.count} onInput=${(e: Event) => setR({ count: (e.target as HTMLInputElement).value })} />
      <select name="place" value=${r.place} onChange=${(e: Event) => setR({ place: (e.target as HTMLSelectElement).value })}>${["Mill Pond", "Cedar Marsh", "North Meadow", "Quarry Trail"].map((p) => html`<option value=${p}>${p}</option>`)}</select>
      <button type="submit" disabled=${r.posting}>${r.posting ? "Reporting…" : "Report sighting"}</button>
    </form>
    ${l.error ? html`<p role="alert">${l.error}</p>` : l.notice ? html`<p class="notice">${l.notice}</p>` : null}
    <ul class="log">${l.rows.map((s) => html`<li class="sighting" key=${s.id}>
      <strong>${s.species}</strong> × ${s.count} at ${s.place} — by ${s.observer}${s.pending ? " (sending…)" : ""} · ${s.confirmations} confirmations
      ${s.observer !== "you" && typeof s.id === "number" ? html`<button type="button" class="confirm" disabled=${l.confirmed.includes(s.id) || (CONFIRM_GUARD && l.pending.includes(s.id))} onClick=${() => void confirm(s)}>${l.confirmed.includes(s.id) ? "Confirmed" : "Confirm"}</button>` : null}
    </li>`)}</ul>
    <button type="button" class="older" disabled=${l.loading || l.loadingMore || !l.cursor} onClick=${() => void loadOlder()}>${l.loadingMore ? "Loading…" : "Older sightings"}</button>
  </main>`;
}

render(html`<${App} />`, document.getElementById("app")!);
let everUp = false;
liveTopic(
  "sightings",
  (m) => {
    if (m.type === "created" && m.item) log.update((l) => upsert(l, m.item as Sighting, true));
    else if (m.type === "updated" && m.item) log.update((l) => (l.rows.some((x) => x.id === m.item.id) ? upsert(l, m.item as Sighting, false) : l));
  },
  (up) => {
    log.update((l) => ({ ...l, live: up }));
    if (up && everUp && RECONNECT === "resync") void loadFirst();
    if (up) everUp = true;
  },
);
void loadFirst();
void api(`/api/confirmations?user=you&limit=50`).then((b) => log.update((l) => ({ ...l, confirmed: itemsOf<{ sightingId: number }>(b).map((c) => c.sightingId) })), () => undefined);
