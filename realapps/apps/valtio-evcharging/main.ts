// Delivery depot charging board (Valtio vanilla proxy registered with rt.guard, rendered with lit-html; fetch +
// WebSocket). Charge posts stream their status, power and metered energy live; the dispatcher can show only fast
// chargers (/api/connectors?maxKw__gte=50), start charging a van on a free post (POST /sessions, then a versioned
// PATCH of the post to "charging"; another driver may have plugged in first) and stop it (PATCH the session with the
// metered energy, then free the post). The header shows the energy delivered to the fleet today, derived from the
// sessions. Latent bugs by flag: Start buttons live while a start runs and the van not set aside when Start is tapped
// (startGuard=none: a double tap opens a second session and its PATCH answers 409, so the dispatcher is told the post
// was taken although the van is charging), post states (pushes and answers) applied in arrival order (live=blind: an
// older meter reading overwrites a newer one), stops shown at once and never rolled back
// (stop=optimistic-no-rollback: a failed stop leaves the van "done" while the post keeps charging it), the energy
// total kept as a running sum (energy=incremental: a stopped session's energy is added again on top of the metered
// increments, and readings missed while offline are lost) and reconnects without a reload (reconnect=naive).
import { html, render } from "lit";
import { proxy, snapshot, subscribe } from "valtio/vanilla";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

type Conn = { id: number; name: string; plug: string; maxKw: number; status: "available" | "charging" | "faulted"; van: string; kw: number; kwh: number; version: number };
type Sess = { id: number; connectorId: number; van: string; status: "active" | "stopped" | "cancelled"; kwh: number };
interface Depot {
  fast: boolean;
  connectors: Conn[];
  sessions: Sess[];
  energy: number;
  van: string;
  starting: number[];
  claimed: string[];
  stopping: number[];
  loading: boolean;
  live: boolean;
  error: string;
  notice: string;
}
const START_GUARD = flag("startGuard", "pending") === "pending";
const LIVE = flag("live", "version-check");
const STOP = flag("stop", "pessimistic");
const ENERGY = flag("energy", "derive");
const RECONNECT = flag("reconnect", "resync");
const FLEET = ["Van 08", "Van 12", "Van 17", "Van 23", "Van 31", "Van 36", "Van 39"];
const round1 = (x: number) => Math.round(x * 10) / 10;

const state = proxy<Depot>({ fast: false, connectors: [], sessions: [], energy: 0, van: "Van 08", starting: [], claimed: [], stopping: [], loading: true, live: false, error: "", notice: "" });
const depot = rt.guard<Depot>("depot", {
  get: () => snapshot(state) as Depot,
  set: (v) => void Object.assign(state, structuredClone(v)),
  subscribe: (fn) => subscribe(state, () => fn()),
});
const commit = (fn: (d: Depot) => void) =>
  depot.update((s) => {
    const d = structuredClone(s) as Depot;
    fn(d);
    return d;
  });
const sumEnergy = (ss: Sess[]) => round1(ss.reduce((n, s) => n + Number(s.kwh || 0), 0));
const charging = (d: Depot) => new Set(d.sessions.filter((s) => s.status === "active").map((s) => s.van));
const freeVans = (d: Depot) => FLEET.filter((v) => !charging(d).has(v) && !d.claimed.includes(v));
const activeOn = (d: Depot, connId: number) => d.sessions.find((s) => s.status === "active" && s.connectorId === connId);

/** A metered reading for a post that charges one of our vans moves that session's energy. */
function meter(d: Depot, c: Conn) {
  const s = activeOn(d, c.id);
  if (!s || s.van !== c.van || c.status !== "charging") return;
  const delta = Number(c.kwh) - Number(s.kwh);
  s.kwh = Number(c.kwh);
  if (ENERGY === "derive") d.energy = sumEnergy(d.sessions);
  else d.energy = round1(d.energy + delta);
}
function upsert(d: Depot, c: Conn, force = false) {
  const i = d.connectors.findIndex((x) => x.id === c.id);
  if (i >= 0 && !force && LIVE === "version-check" && Number(c.version) < Number(d.connectors[i]!.version)) return;
  if (i >= 0) d.connectors[i] = c;
  else if (!d.fast || c.maxKw >= 50) d.connectors.push(c);
  meter(d, c);
}

// ------------------------------------------------------------------------------------------- loads
let seq = 0;
let loadedOnce = false;
async function load() {
  const my = ++seq;
  const fast = state.fast;
  commit((d) => void ((d.loading = true), (d.error = "")));
  try {
    const [cb, sb] = await Promise.all([api(`/api/connectors?limit=50${fast ? "&maxKw__gte=50" : ""}`), api(`/api/sessions?limit=100&van__in=${encodeURIComponent(FLEET.join(","))}`)]);
    if (my !== seq) return;
    const first = !loadedOnce;
    loadedOnce = true;
    commit((d) => {
      // version-check: a post that moved on (by push) while the load was out keeps its newer state
      const local = new Map(d.connectors.map((c) => [c.id, c]));
      d.connectors = itemsOf<Conn>(cb).map((c) => {
        const cur = local.get(c.id);
        return LIVE === "version-check" && cur && Number(cur.version) > Number(c.version) ? cur : c;
      });
      d.sessions = itemsOf<Sess>(sb).filter((s) => s.status !== "cancelled");
      for (const c of d.connectors) meter(d, c);
      // incremental: the running total is only seeded once and then follows the meter pushes
      if (ENERGY === "derive" || first) d.energy = sumEnergy(d.sessions);
      if (!freeVans(d).includes(d.van)) d.van = freeVans(d)[0] ?? "";
      d.loading = false;
    });
  } catch (e) {
    if (my !== seq) return;
    commit((d) => void ((d.loading = false), (d.error = errText(e, "loading the chargers") + (loadedOnce ? "" : " Retrying…"))));
    // nothing on screen yet: try again shortly
    if (!loadedOnce) setTimeout(() => my === seq && void load(), 4000);
  }
}

// ------------------------------------------------------------------------------------------- start / stop
/** Versioned PATCH of a post; on a version clash retry once if the post is still in the state we expect. */
async function patchPost(c: Conn, patch: Partial<Conn>, stillOk: (cur: Conn) => boolean): Promise<Conn> {
  try {
    return await api<Conn>(`/api/connectors/${c.id}`, "PATCH", { ...patch, version: c.version });
  } catch (e) {
    const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Conn | undefined) : undefined;
    if (!cur || !stillOk(cur)) throw e;
    return api<Conn>(`/api/connectors/${c.id}`, "PATCH", { ...patch, version: cur.version });
  }
}

async function start(c: Conn) {
  const van = state.van;
  if (!van || (START_GUARD && state.starting.includes(c.id))) return;
  commit((d) => {
    d.starting.push(c.id);
    // pending: the van is spoken for as soon as Start is tapped, the picker moves on to the next free van
    if (START_GUARD) {
      d.claimed.push(van);
      if (d.van === van) d.van = freeVans(d)[0] ?? "";
    }
    d.error = "";
    d.notice = "";
  });
  try {
    const sess = await api<Sess>(`/api/sessions`, "POST", { connectorId: c.id, van, status: "active", kwh: 0 });
    try {
      const saved = await patchPost(c, { status: "charging", van, kw: Math.min(c.maxKw, 45), kwh: 0 }, (cur) => cur.status === "available");
      commit((d) => {
        if (!d.sessions.some((s) => s.id === sess.id)) d.sessions.push(sess);
        upsert(d, saved);
        if (d.van === van) d.van = freeVans(d)[0] ?? "";
        d.notice = `${van} is charging on ${c.name}.`;
      });
    } catch (e) {
      await api(`/api/sessions/${sess.id}`, "PATCH", { status: "cancelled" }).catch(() => undefined);
      const taken = e instanceof HttpError && e.status === 409;
      commit((d) => void (d.error = taken ? `${c.name} was just taken by another van — pick another post.` : errText(e, `starting ${van} on ${c.name}`)));
    }
  } catch (e) {
    commit((d) => void (d.error = errText(e, `starting ${van} on ${c.name}`)));
  } finally {
    commit((d) => {
      d.starting = d.starting.filter((x) => x !== c.id);
      d.claimed = d.claimed.filter((v) => v !== van);
      if (!d.van) d.van = freeVans(d)[0] ?? "";
    });
  }
}

function applyStop(d: Depot, c: Conn, sess: Sess, kwh: number, post?: Conn) {
  const s = d.sessions.find((x) => x.id === sess.id);
  if (s && s.status === "active") {
    s.status = "stopped";
    s.kwh = kwh;
    d.energy = ENERGY === "derive" ? sumEnergy(d.sessions) : round1(d.energy + kwh);
  }
  // a server answer obeys the push ordering; the optimistic picture of a freed post is forced
  if (post) upsert(d, post);
  else upsert(d, { ...c, status: "available", van: "", kw: 0, kwh: 0 }, true);
  d.notice = `${sess.van} stopped on ${c.name} · ${kwh} kWh.`;
}

async function stop(c: Conn) {
  const sess = activeOn(state, c.id);
  if (!sess || state.stopping.includes(c.id)) return;
  const kwh = Number(c.kwh);
  commit((d) => {
    d.stopping.push(c.id);
    d.error = "";
    d.notice = "";
    if (STOP === "optimistic-no-rollback") applyStop(d, c, sess, kwh);
  });
  try {
    await api<Sess>(`/api/sessions/${sess.id}`, "PATCH", { status: "stopped", kwh });
    const post = await patchPost(c, { status: "available", van: "", kw: 0, kwh: 0 }, (cur) => cur.van === sess.van);
    commit((d) => (STOP === "pessimistic" ? applyStop(d, c, sess, kwh, post) : upsert(d, post)));
  } catch (e) {
    commit((d) => void (d.error = errText(e, `stopping ${sess.van} on ${c.name}`)));
  } finally {
    commit((d) => void (d.stopping = d.stopping.filter((x) => x !== c.id)));
  }
}

// ------------------------------------------------------------------------------------------- live
let everUp = false;
liveTopic(
  "connectors",
  (m) => {
    if (m.type === "updated" && m.item) commit((d) => upsert(d, m.item as Conn));
  },
  (up) => {
    commit((d) => void (d.live = up));
    if (up && everUp && RECONNECT === "resync") void load();
    if (up) everUp = true;
  },
);

// ------------------------------------------------------------------------------------------- view
function row(s: Depot, c: Conn) {
  const mine = activeOn(s, c.id);
  const busy = s.starting.includes(c.id) || s.stopping.includes(c.id);
  const what = c.status === "charging" ? `${c.van} · ${c.kw} kW · ${round1(c.kwh)} kWh` : c.status;
  return html`<li class="connector ${c.status}">
    ${c.name} · ${c.plug} ${c.maxKw} kW · ${what}
    ${c.status === "available"
      ? html`<button type="button" class="start" ?disabled=${!s.van || (START_GUARD && busy)}>${s.starting.includes(c.id) ? "Starting…" : `Start ${s.van}`}</button>`
      : mine
        ? html`<button type="button" class="stop" ?disabled=${busy}>${s.stopping.includes(c.id) ? "Stopping…" : "Stop"}</button>`
        : ""}
  </li>`;
}
function view(s: Depot) {
  const vans = freeVans(s);
  return html`<main class="depot">
    <h1>Depot charging · Eastside hub</h1>
    <p class="status">${s.live ? "live" : "reconnecting…"} · fleet energy today ${round1(s.energy).toFixed(1)} kWh · ${s.sessions.filter((x) => x.status === "active").length} vans charging</p>
    <div class="controls">
      <label><input type="checkbox" name="fast" .checked=${s.fast} @change=${(e: Event) => setFast((e.target as HTMLInputElement).checked)}> Fast chargers only</label>
      <label>Van <select name="van" ?disabled=${vans.length === 0} @change=${(e: Event) => void (state.van = (e.target as HTMLSelectElement).value)}>
        ${vans.length ? vans.map((v) => html`<option ?selected=${v === s.van}>${v}</option>`) : html`<option>All vans charging</option>`}</select></label>
    </div>
    ${s.error ? html`<p role="alert">${s.error}</p>` : s.notice ? html`<p class="notice">${s.notice}</p>` : ""}
    ${s.loading ? html`<p class="loading">Loading posts…</p>` : ""}
    <ul class="connectors" @click=${onClick}>${s.connectors.map((c) => row(s, c))}</ul>
    <h2>Today's sessions</h2>
    <ul class="sessions">${s.sessions.map((x) => html`<li class="session">${x.van} · ${s.connectors.find((c) => c.id === x.connectorId)?.name ?? "post"} · ${round1(x.kwh)} kWh · ${x.status === "active" ? "charging" : "done"}</li>`)}</ul>
  </main>`;
}
function onClick(e: Event) {
  const t = e.target as HTMLElement;
  const li = t.closest("li.connector");
  if (!li || !t.matches("button")) return;
  const s = snapshot(state) as Depot;
  const c = s.connectors[Array.from(li.parentElement!.children).indexOf(li)];
  if (!c) return;
  if (t.matches("button.start")) void start(c);
  else if (t.matches("button.stop")) void stop(c);
}
function setFast(fast: boolean) {
  state.fast = fast;
  void load();
}
const root = document.getElementById("app")!;
const paint = () => render(view(snapshot(state) as Depot), root);
subscribe(state, paint);
paint();
void load();
