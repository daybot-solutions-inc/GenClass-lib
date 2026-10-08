// Cold-chain monitor (RxJS 7 webSocket subject + vanilla DOM; state in a runtime atom). Freezer, chiller and reefer
// truck sensors push readings over a WebSocket; the stream reconnects with exponential backoff and readings are
// batched before they touch the table. Operators can acknowledge alarms, nudge setpoints and pause the live feed.
// Latent bugs by flag: reconnect without a resync (reconnect=resubscribe: readings sent while the socket was down
// are never seen; reconnect=none: no retry at all), smoothing that drops readings (smoothing=throttle: per-sensor
// leading-edge throttle loses the newest reading; smoothing=sample: one reading per second across all sensors),
// snapshots that replace newer streamed readings (merge=replace), an alarm badge only recomputed on snapshots
// (alarmCount=on-snapshot), one PATCH per setpoint click with every echo applied (setpointSend=each: an older echo
// rolls the setpoint back).
import { EMPTY, Subscription, of, timer, type Observable } from "rxjs";
import { bufferTime, catchError, filter, groupBy, map, mergeMap, retry, sampleTime, throttleTime } from "rxjs/operators";
import { webSocket } from "rxjs/webSocket";
import { fromFetch } from "rxjs/fetch";
import { rt, flag } from "../_shared/genclass";

type Sensor = { id: number; name: string; zone: string; temp: number; setpoint: number; acked: boolean; updatedAt?: string };
type Row = Sensor & { history: number[] };
type Msg = { type: string; id?: number; item?: Sensor | null };

const RECONNECT = flag("reconnect", "resync") as "resync" | "resubscribe" | "none";
const SMOOTHING = flag("smoothing", "buffer") as "buffer" | "throttle" | "sample";
const MERGE = flag("merge", "newest") as "newest" | "replace";
const ALARMS = flag("alarmCount", "derive") as "derive" | "on-snapshot";
const SETPOINT_SEND = flag("setpointSend", "debounce") as "debounce" | "each";
const TOL = 2;
const HISTORY = 6;

const mon = rt.atom("monitor", { sensors: [] as Row[], alarmCount: 0, connected: false, live: true, zone: "all", loading: false, error: "" });
const isAlarm = (s: Sensor) => Number(s.temp) > Number(s.setpoint) + TOL && !s.acked;
const countAlarms = (rows: Row[]) => rows.filter(isAlarm).length;
const alarmsAfter = (prev: number, rows: Row[], snapshot: boolean) => (ALARMS === "derive" || snapshot ? countAlarms(rows) : prev);
const t1 = (n: unknown) => Math.round(Number(n) * 10) / 10;
const withHistory = (h: number[], t: number) => (h.length && h[h.length - 1] === t ? h : [...h, t].slice(-HISTORY));
const deg = (n: number) => `${Number(n) > 0 ? "+" : Number(n) < 0 ? "−" : ""}${Math.abs(Number(n)).toFixed(1)}°`;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Sensors with a setpoint edit not yet confirmed by the server (local value wins). */
const pendingSetpoint = new Map<number, number>();

// ------------------------------------------------------------------------------------------- snapshot
function mergeRow(local: Row | undefined, s: Sensor): Row {
  if (!local) return { ...s, temp: t1(s.temp), history: [t1(s.temp)] };
  if (MERGE === "newest" && local.updatedAt && s.updatedAt && local.updatedAt > s.updatedAt) return local; // the stream is ahead of this snapshot
  const setpoint = MERGE === "newest" && pendingSetpoint.has(s.id) ? local.setpoint : Number(s.setpoint);
  return { ...local, ...s, temp: t1(s.temp), setpoint, history: withHistory(local.history, t1(s.temp)) };
}

let snapSub: Subscription | null = null;
function loadSnapshot() {
  snapSub?.unsubscribe();
  mon.update((m) => ({ ...m, loading: true }));
  snapSub = fromFetch("/api/sensors?limit=50", { selector: (r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))) })
    .pipe(catchError(() => of(null)))
    .subscribe((body: { items?: Sensor[] } | null) => {
      if (!body || !Array.isArray(body.items)) return void mon.update((m) => ({ ...m, loading: false, error: "Sensor list unavailable; showing the last known readings." }));
      const items = body.items;
      mon.update((m) => {
        const byId = new Map(m.sensors.map((r) => [r.id, r]));
        const sensors = items.map((s) => mergeRow(byId.get(s.id), s));
        return { ...m, sensors, alarmCount: alarmsAfter(m.alarmCount, sensors, true), loading: false, error: "" };
      });
    });
}

// ------------------------------------------------------------------------------------------- live feed
function applyReadings(batch: Sensor[]) {
  mon.update((m) => {
    let sensors = m.sensors;
    for (const s of batch) {
      sensors = sensors.map((r) => {
        if (r.id !== s.id) return r;
        if (MERGE === "newest" && r.updatedAt && s.updatedAt && r.updatedAt > s.updatedAt) return r;
        const setpoint = pendingSetpoint.has(r.id) ? r.setpoint : Number(s.setpoint);
        return { ...r, temp: t1(s.temp), acked: Boolean(s.acked), setpoint, updatedAt: s.updatedAt, history: withHistory(r.history, t1(s.temp)) };
      });
    }
    return { ...m, sensors, alarmCount: alarmsAfter(m.alarmCount, sensors, false) };
  });
}

let opened = 0;
const socket$ = webSocket<Msg>({
  url: `${location.origin.replace(/^http/, "ws")}/ws/sensors`,
  openObserver: {
    next: () => {
      opened++;
      mon.update((m) => ({ ...m, connected: true, error: "" }));
      if (opened > 1 && RECONNECT === "resync") loadSnapshot(); // catch up on what the socket missed
    },
  },
  closeObserver: { next: () => mon.update((m) => ({ ...m, connected: false })) },
});

function readings$(): Observable<Sensor[]> {
  const raw$ = socket$.pipe(
    RECONNECT === "none" ? (x: Observable<Msg>) => x : retry({ delay: (_e, n) => timer(Math.min(8000, 500 * 2 ** (n - 1))), resetOnSuccess: true }),
    filter((m) => m.type === "updated" && !!m.item),
    map((m) => m.item as Sensor),
  );
  if (SMOOTHING === "throttle") return raw$.pipe(groupBy((s) => s.id), mergeMap((g$) => g$.pipe(throttleTime(2000))), map((s) => [s]));
  if (SMOOTHING === "sample") return raw$.pipe(sampleTime(1000), map((s) => [s]));
  return raw$.pipe(bufferTime(1000), filter((b) => b.length > 0));
}

let feed: Subscription | null = null;
function startFeed() {
  feed = readings$()
    .pipe(catchError(() => (mon.update((m) => ({ ...m, connected: false, error: "Live feed lost. Press Refresh for the latest readings." })), EMPTY)))
    .subscribe(applyReadings);
}

function toggleLive() {
  if (feed) {
    feed.unsubscribe();
    feed = null;
    mon.update((m) => ({ ...m, live: false, connected: false }));
  } else {
    mon.update((m) => ({ ...m, live: true }));
    startFeed();
  }
}

// ---------------------------------------------------------------------------------------------- writes
async function acknowledge(id: number) {
  const before = mon.get().sensors.find((r) => r.id === id);
  if (!before || before.acked) return;
  mon.update((m) => {
    const sensors = m.sensors.map((r) => (r.id === id ? { ...r, acked: true } : r));
    return { ...m, sensors, alarmCount: alarmsAfter(m.alarmCount, sensors, false), error: "" };
  });
  try {
    const r = await fetch(`/api/sensors/${id}/ack`, { method: "POST" });
    if (!r.ok) throw new Error(String(r.status));
  } catch {
    mon.update((m) => {
      const sensors = m.sensors.map((x) => (x.id === id ? { ...x, acked: false } : x));
      return { ...m, sensors, alarmCount: alarmsAfter(m.alarmCount, sensors, false), error: `Couldn't acknowledge ${before.name}. The alarm is still active.` };
    });
  }
}

let spSeq = 0;
const spTimers = new Map<number, ReturnType<typeof setTimeout>>();
function nudgeSetpoint(id: number, d: number) {
  let next = 0;
  mon.update((m) => ({ ...m, error: "", sensors: m.sensors.map((r) => (r.id === id ? { ...r, setpoint: (next = Math.round((r.setpoint + d) * 2) / 2) } : r)) }));
  if (SETPOINT_SEND === "each") return void sendSetpoint(id, next, ++spSeq);
  pendingSetpoint.set(id, next);
  clearTimeout(spTimers.get(id));
  spTimers.set(id, setTimeout(() => (spTimers.delete(id), void sendSetpoint(id, pendingSetpoint.get(id)!, ++spSeq)), 600));
}

async function sendSetpoint(id: number, setpoint: number, seq: number) {
  try {
    const r = await fetch(`/api/sensors/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ setpoint }) });
    if (!r.ok) throw new Error(String(r.status));
    const saved = (await r.json()) as Sensor;
    if (SETPOINT_SEND === "debounce") {
      if (spTimers.has(id) || pendingSetpoint.get(id) !== setpoint) return; // a newer edit is on its way
      pendingSetpoint.delete(id);
    }
    mon.update((m) => {
      const sensors = m.sensors.map((x) => (x.id === id ? { ...x, setpoint: Number(saved.setpoint), updatedAt: saved.updatedAt } : x));
      return { ...m, sensors, alarmCount: alarmsAfter(m.alarmCount, sensors, false) };
    });
  } catch {
    if (SETPOINT_SEND === "debounce" && pendingSetpoint.get(id) === setpoint && !spTimers.has(id)) pendingSetpoint.delete(id);
    mon.update((m) => ({ ...m, error: `Setpoint change #${seq} wasn't saved. Check the unit's panel.` }));
  }
}

// ------------------------------------------------------------------------------------------------- DOM
const root = document.getElementById("app")!;
root.innerHTML = `<main class="monitor">
  <header><h1>Cold-chain monitor</h1><p class="feed-state"></p></header>
  <div class="toolbar">
    <label>Zone <select name="zone" aria-label="Zone"><option value="all">All zones</option><option>Dock</option><option>Kitchen</option><option>Retail</option><option>Fleet</option></select></label>
    <button class="live"></button> <button class="refresh">Refresh</button>
  </div>
  <div class="msg"></div>
  <table><thead><tr><th>Unit</th><th>Zone</th><th>Now</th><th>Setpoint</th><th>Last readings</th><th></th></tr></thead><tbody></tbody></table>
</main>`;
const tbody = root.querySelector("tbody")!;
const stateEl = root.querySelector(".feed-state")!;
const msgEl = root.querySelector(".msg")!;
const liveBtn = root.querySelector("button.live") as HTMLButtonElement;
const zoneSel = root.querySelector("select[name=zone]") as HTMLSelectElement;

function render() {
  const m = mon.get();
  stateEl.textContent = `${m.alarmCount} active ${m.alarmCount === 1 ? "alarm" : "alarms"} · ${!m.live ? "feed paused" : m.connected ? "live" : "reconnecting…"}${m.loading ? " · syncing" : ""}`;
  liveBtn.textContent = m.live ? "Pause feed" : "Resume feed";
  liveBtn.classList.toggle("paused", !m.live);
  msgEl.innerHTML = m.error ? `<p role="alert">${esc(m.error)}</p>` : "";
  const rows = m.zone === "all" ? m.sensors : m.sensors.filter((r) => r.zone === m.zone);
  tbody.innerHTML = rows
    .map((r) => {
      const trend = r.history.length > 1 ? (r.history[r.history.length - 1]! > r.history[0]! ? "rising" : r.history[r.history.length - 1]! < r.history[0]! ? "falling" : "steady") : "";
      const alarm = isAlarm(r);
      return `<tr class="sensor${alarm ? " alarm" : ""}" data-id="${r.id}"><td>${esc(r.name)}</td><td>${esc(r.zone)}</td><td>${deg(r.temp)}${alarm ? " ALARM" : r.acked && r.temp > r.setpoint + TOL ? " (acknowledged)" : ""}</td><td><button class="sp-down" aria-label="Lower setpoint">−</button> ${deg(r.setpoint)} <button class="sp-up" aria-label="Raise setpoint">+</button></td><td>${r.history.map(deg).join(" ")} ${trend}</td><td>${alarm ? `<button class="ack">Acknowledge</button>` : ""}</td></tr>`;
    })
    .join("");
}
mon.subscribe(render);

tbody.addEventListener("click", (e) => {
  const btn = (e.target as Element).closest("button");
  const id = Number(btn?.closest("tr")?.getAttribute("data-id"));
  if (!btn || !id) return;
  if (btn.classList.contains("ack")) void acknowledge(id);
  else if (btn.classList.contains("sp-up")) nudgeSetpoint(id, 0.5);
  else if (btn.classList.contains("sp-down")) nudgeSetpoint(id, -0.5);
});
liveBtn.addEventListener("click", toggleLive);
root.querySelector("button.refresh")!.addEventListener("click", loadSnapshot);
zoneSel.addEventListener("change", () => mon.update((m) => ({ ...m, zone: zoneSel.value })));

render();
loadSnapshot();
startFeed();
