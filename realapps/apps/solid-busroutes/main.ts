// School bus tracker for parents (SolidJS with solid-js/html and a solid-js/store createStore; fetch +
// AbortController + WebSocket). Today's buses stream in live (position, next stop, ETA, status); parents filter by
// route, switch text alerts for their stops on and off (POST / DELETE /alerts, one per parent and stop) and report a
// child absent for today (POST /absences, child and reason required, one per child and day). The store is not
// registered with GenClass (observe-only). Latent bugs by flag: pushes and list answers applied in arrival order
// (live=blind: a list answer read before the latest push puts a bus back where it was), reconnects without a reload
// (reconnect=naive: moves made while offline stay missing), alert and absence buttons live while their request is
// on its way (alertGuard=none / absenceGuard=none: the second request answers 409 or 404 and an error shows although
// the first one worked) and route switches that don't abort the previous request (routeFetch=none: an earlier
// route's buses land under the newly picked route).
import html from "solid-js/html";
import { render } from "solid-js/web";
import { For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, isAbort, liveTopic } from "../_shared/w3-http";

type Bus = { id: number; bus: string; route: string; routeName: string; school: string; driver: string; at: string; next: string; eta: number; status: string; updatedAt?: string };
type Stop = { id: number; name: string; route: string; bus: string; pickup: string };
type Alert = { id: number; stopId: number };

const LIVE = flag("live", "newer-wins");
const RECONNECT = flag("reconnect", "resync");
const ALERT_GUARD = flag("alertGuard", "pending") === "pending";
const ABSENCE_GUARD = flag("absenceGuard", "pending") === "pending";
const ROUTE_ABORT = flag("routeFetch", "abort") === "abort";

const ME = "Jordan Lee";
const KIDS = [
  { name: "Mia", bus: "Bus 12", route: "North Loop" },
  { name: "Leo", bus: "Bus 7", route: "River Road" },
];
const ROUTES: [string, string][] = [["all", "All routes"], ["north", "North Loop"], ["river", "River Road"], ["hill", "Hillcrest"]];
const REASONS: [string, string][] = [["sick", "Sick"], ["appointment", "Appointment"], ["family", "Family trip"], ["other", "Other"]];
const routeName = (r: string) => ROUTES.find(([k]) => k === r)?.[1] ?? r;
const today = () => new Date().toISOString().slice(0, 10);

const [s, set] = createStore({
  buses: [] as Bus[],
  route: "all",
  loading: true,
  live: false,
  stops: [] as Stop[],
  alerts: [] as Alert[],
  busy: [] as number[],
  absent: [] as string[],
  child: "Mia",
  reason: "",
  posting: false,
  error: "",
  notice: "",
});

/** Is `a` at least as recent as `b`? (seed rows carry no updatedAt: oldest) */
const atLeast = (a?: string, b?: string) => String(a ?? "") >= String(b ?? "");

function applyList(fetched: Bus[]) {
  if (LIVE === "blind") return set("buses", reconcile(fetched, { key: "id" }));
  // newer-wins: a push that arrived while this list was on its way is newer than the list's copy
  const have = new Map(s.buses.map((b) => [b.id, b]));
  set("buses", reconcile(fetched.map((b) => { const h = have.get(b.id); return h && !atLeast(b.updatedAt, h.updatedAt) ? { ...h } : b; }), { key: "id" }));
}

let ctl: AbortController | null = null;
let seq = 0;
async function loadBuses(route = s.route) {
  const my = ++seq;
  if (ROUTE_ABORT) ctl?.abort();
  ctl = new AbortController();
  set({ loading: true, error: "" });
  try {
    const body = await api(`/api/buses?limit=20${route !== "all" ? `&route=${route}` : ""}`, "GET", undefined, {}, ROUTE_ABORT ? ctl.signal : undefined);
    if (ROUTE_ABORT && my !== seq) return;
    applyList(itemsOf<Bus>(body));
    set("loading", false);
  } catch (e) {
    if (isAbort(e) || (ROUTE_ABORT && my !== seq)) return;
    set({ loading: false, error: errText(e, "loading today's buses") });
  }
}

function onPush(m: { type: string; id: number; item: Bus | null }) {
  if (m.type === "deleted") return set("buses", (xs) => xs.filter((x) => x.id !== m.id));
  const b = m.item;
  if (!b || (s.route !== "all" && b.route !== s.route)) return;
  const cur = s.buses.find((x) => x.id === b.id);
  if (!cur) return void (m.type === "created" && set("buses", (xs) => [...xs, b]));
  if (LIVE === "newer-wins" && !atLeast(b.updatedAt, cur.updatedAt)) return;
  set("buses", (x) => x.id === b.id, b);
}

async function loadMine(attempt = 0): Promise<void> {
  try {
    const [stops, alerts, absences] = await Promise.all([
      api(`/api/stops?limit=20`),
      api(`/api/alerts?parent=${encodeURIComponent(ME)}&limit=50`),
      api(`/api/absences?parent=${encodeURIComponent(ME)}&date=${today()}&limit=50`),
    ]);
    set({ stops: itemsOf<Stop>(stops), alerts: itemsOf<Alert>(alerts).map((a) => ({ id: a.id, stopId: a.stopId })), absent: itemsOf<{ child: string }>(absences).map((a) => a.child) });
  } catch (e) {
    if (attempt < 3) return void setTimeout(() => void loadMine(attempt + 1), 2000 * (attempt + 1)); // try again shortly
    set("error", errText(e, "loading your stops"));
  }
}

async function toggleAlert(stop: Stop) {
  if (ALERT_GUARD && s.busy.includes(stop.id)) return;
  set({ busy: [...s.busy, stop.id], error: "", notice: "" });
  const have = s.alerts.find((a) => a.stopId === stop.id);
  try {
    if (have) {
      await api(`/api/alerts/${have.id}`, "DELETE");
      set({ alerts: s.alerts.filter((a) => a.stopId !== stop.id), notice: `Alerts are off for ${stop.name}.` });
    } else {
      const a = await api<Alert>("/api/alerts", "POST", { parent: ME, stopId: stop.id, stop: stop.name, key: `${ME}|${stop.id}` });
      set({ alerts: [...s.alerts.filter((x) => x.stopId !== stop.id), { id: a.id, stopId: stop.id }], notice: `You'll get a text when ${stop.bus} is five minutes from ${stop.name}.` });
    }
  } catch (e) {
    set("error", e instanceof HttpError && e.status === 409 ? `An alert for ${stop.name} is already on.` : errText(e, `changing the alert for ${stop.name}`));
  } finally {
    const i = s.busy.indexOf(stop.id);
    if (i >= 0) set("busy", [...s.busy.slice(0, i), ...s.busy.slice(i + 1)]);
  }
}

async function reportAbsent(ev: Event) {
  ev.preventDefault();
  if (ABSENCE_GUARD && s.posting) return;
  const { child, reason } = s;
  set({ posting: true, error: "", notice: "" });
  try {
    await api("/api/absences", "POST", { parent: ME, child, reason, date: today(), key: `${child}|${today()}` });
    set({ absent: s.absent.includes(child) ? s.absent : [...s.absent, child], reason: "", notice: `${child} is marked absent today. The driver will not wait at the stop.` });
  } catch (e) {
    const st = e instanceof HttpError ? e.status : 0;
    set("error", st === 409 ? `${child} is already reported absent today.` : st === 422 ? "Pick a reason first." : errText(e, `reporting ${child} absent`));
  } finally {
    set("posting", false);
  }
}

function changeRoute(route: string) {
  set({ route, notice: "" });
  void loadBuses(route);
}

const busLine = (b: Bus) => (b.status === "arrived" ? `arrived at ${b.school}` : `at ${b.at}, next ${b.next} in ${b.eta} min`);

function App() {
  return html`<main class="busroutes">
    <header>
      <h1>Riverside schools — today's buses</h1>
      <p class="status">${() => `${s.live ? "Live" : "Reconnecting…"} · ${s.buses.length} buses on ${routeName(s.route)}${s.loading ? " · updating…" : ""}`}</p>
    </header>
    <ul class="kids">${KIDS.map((k) => html`<li class="kid">${k.name} rides ${k.bus} (${k.route})${() => (s.absent.includes(k.name) ? " — absent today" : "")}</li>`)}</ul>
    <${Show} when=${() => s.error}><p role="alert">${() => s.error}</p><//>
    <${Show} when=${() => s.notice}><p class="notice">${() => s.notice}</p><//>
    <nav class="filter">
      <label>Route <select name="route" value=${() => s.route} onChange=${(e: Event) => changeRoute((e.currentTarget as HTMLSelectElement).value)}>
        ${ROUTES.map(([k, l]) => html`<option value=${k}>${l}</option>`)}
      </select></label>
      <button class="refresh" type="button" onClick=${() => { void loadBuses(); if (!s.stops.length) void loadMine(); }}>Refresh</button>
    </nav>
    <ul class="buses">
      <${For} each=${() => s.buses}>${(b: Bus) => html`<li class="bus">
        <strong>${b.bus}</strong> · ${b.routeName} · ${b.school} · driver ${b.driver} — ${() => busLine(b)} · <em>${() => b.status}</em>
      </li>`}<//>
    </ul>
    <section class="stops">
      <h2>Stop alerts</h2>
      <ul>
        <${For} each=${() => s.stops}>${(st: Stop) => html`<li class="stop">
          ${st.name} · ${st.bus}, ${routeName(st.route)} · pickup ${st.pickup}
          <button class="alert" type="button" disabled=${() => ALERT_GUARD && s.busy.includes(st.id)} onClick=${() => void toggleAlert(st)}>${() => (s.alerts.some((a) => a.stopId === st.id) ? "Turn off alert" : "Alert me")}</button>
        </li>`}<//>
      </ul>
    </section>
    <form class="absence" onSubmit=${(e: Event) => void reportAbsent(e)}>
      <h2>Report an absence</h2>
      <select name="child" aria-label="Child" value=${() => s.child} onChange=${(e: Event) => set("child", (e.currentTarget as HTMLSelectElement).value)}>
        ${KIDS.map((k) => html`<option value=${k.name}>${k.name}</option>`)}
      </select>
      <select name="reason" aria-label="Reason" value=${() => s.reason} onChange=${(e: Event) => set("reason", (e.currentTarget as HTMLSelectElement).value)}>
        <option value="">Reason…</option>
        ${REASONS.map(([k, l]) => html`<option value=${k}>${l}</option>`)}
      </select>
      <button class="report" type="submit" disabled=${() => ABSENCE_GUARD && s.posting}>${() => (s.posting ? "Sending…" : "Report absent today")}</button>
    </form>
  </main>`;
}

render(() => html`<${App} />`, document.getElementById("app")!);
let everUp = false;
liveTopic("buses", onPush, (up) => {
  set("live", up);
  if (up && everUp && RECONNECT === "resync") void loadBuses(); // catch up on moves made while we were offline
  if (up) everUp = true;
});
void loadBuses();
void loadMine();
