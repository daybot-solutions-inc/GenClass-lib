// Building climate dashboard (React 19 + effector + effector-react useUnit, fetch, WebSocket). Thermostat state is
// polled and pushed live; the selected device's recent readings are loaded on selection and on every poll. Server
// results reach the stores through GenClass-guarded write events (rt.guard over the effector stores); UI events
// (selection, optimistic setpoint nudges) update the stores directly with .on(). Setpoint commands are POSTed to
// the device. Latent bugs by flag: history loads not cancelled and applied whatever device is selected now
// (race=none), relative +0.5/-0.5 commands that a lost response or a double click applies twice
// (command=relative), poll results and live echoes of an older command overwriting a newer local setpoint
// (echo=apply), overlapping polls whose late answer overwrites a newer one (overlap=none).
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { attach, combine, createEffect, createEvent, createStore, sample, type Effect, type StoreWritable } from "effector";
import { useUnit } from "effector-react";
import { rt, flag } from "../_shared/genclass";

type Device = { id: number; name: string; room: string; kind: string; setpoint: number; temp: number; on: boolean; online: boolean };
type Reading = { id: number; deviceId: number; temp: number; humidity: number; createdAt: string };
interface Panel {
  selected: number;
  pending: Record<number, number>;
  loadingHistory: boolean;
  connected: boolean;
  error: string;
}
type Cmd = { id: number; kind: "up" | "down" | "power"; setpoint: number; on: boolean };

const RACE = flag("race", "abort") as "abort" | "none";
const COMMAND = flag("command", "absolute") as "absolute" | "relative";
const ECHO = flag("echo", "pending-aware") as "pending-aware" | "apply";
const OVERLAP = flag("overlap", "skip") as "skip" | "none";
const POLL_MS = Number(flag("pollMs", 4000));

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

// ------------------------------------------------------------------------------------- stores + GenClass
/** Register an effector store with GenClass; returns an event that applies an updater through the guard. */
function guarded<T>(name: string, $s: StoreWritable<T>) {
  const replaced = createEvent<T>();
  $s.on(replaced, (_, v) => v);
  const g = rt.guard<T>(name, { get: () => $s.getState(), set: (v) => replaced(v), subscribe: (fn) => $s.updates.watch(() => fn()) });
  const write = createEvent<(prev: T) => T>();
  write.watch((fn) => g.update(fn));
  return write;
}

const $devices = createStore<Device[]>([]);
const $history = createStore<Reading[]>([]);
const $panel = createStore<Panel>({ selected: 0, pending: {}, loadingHistory: false, connected: false, error: "" });
const writeDevices = guarded("devices", $devices);
const writeHistory = guarded("history", $history);
const writePanel = guarded("panel", $panel);
const $online = combine($devices, (ds) => ds.filter((d) => d.online).length);

// UI events (direct store updates)
const deviceSelected = createEvent<number>();
const nudged = createEvent<{ id: number; delta: number }>();
const powerToggled = createEvent<number>();
const pollTick = createEvent();
$panel.on(deviceSelected, (p, id) => ({ ...p, selected: id, loadingHistory: true }));
$history.reset(deviceSelected);
$devices.on(nudged, (ds, { id, delta }) => ds.map((d) => (d.id === id ? { ...d, setpoint: Math.round((d.setpoint + delta) * 10) / 10 } : d)));
$devices.on(powerToggled, (ds, id) => ds.map((d) => (d.id === id ? { ...d, on: !d.on } : d)));
$panel.on([nudged, powerToggled], (p, x) => {
  const id = typeof x === "number" ? x : x.id;
  return { ...p, pending: { ...p.pending, [id]: (p.pending[id] ?? 0) + 1 }, error: "" };
});

/** Commands in flight per device (bookkeeping outside the stores). */
const inflight = new Map<number, number>();
/** Server copies of devices, keeping local setpoints of devices with commands in flight (pending-aware). */
function mergeDevices(local: Device[], incoming: Device[]): Device[] {
  return incoming.map((d) => {
    const mine = local.find((x) => x.id === d.id);
    return ECHO === "pending-aware" && mine && (inflight.get(d.id) ?? 0) > 0 ? { ...d, setpoint: mine.setpoint, on: mine.on } : d;
  });
}

// ------------------------------------------------------------------------------------------- effects
const fetchDevicesFx = createEffect(() => http<Device[]>("/api/devices"));
const historyOf = (id: number, signal?: AbortSignal) => http<{ items: Reading[] }>(`/api/readings?deviceId=${id}&sort=-createdAt&limit=8`, { signal }).then((r) => r.items);
const $historyCtl = createStore<AbortController | null>(null);
const controllerSet = createEvent<AbortController>();
$historyCtl.on(controllerSet, (_, c) => c);
const plainHistoryFx = createEffect((id: number) => historyOf(id));
// race=abort: the previous load is aborted when a new one starts
const abortableHistoryFx = attach({
  source: $historyCtl,
  effect: async (prev: AbortController | null, id: number) => {
    prev?.abort();
    const ctl = new AbortController();
    controllerSet(ctl);
    return historyOf(id, ctl.signal);
  },
});
const loadHistoryFx: Effect<number, Reading[]> = RACE === "abort" ? abortableHistoryFx : plainHistoryFx;

const sendCommandFx = createEffect(async (c: Cmd) => {
  inflight.set(c.id, (inflight.get(c.id) ?? 0) + 1);
  try {
    if (COMMAND === "relative") return await http<Device>(`/api/devices/${c.id}/${c.kind}`, { method: "POST" });
    return await http<Device>(`/api/devices/${c.id}`, { method: "PATCH", body: JSON.stringify(c.kind === "power" ? { on: c.on } : { setpoint: c.setpoint }) });
  } finally {
    inflight.set(c.id, (inflight.get(c.id) ?? 1) - 1);
  }
});

sample({ clock: pollTick, source: fetchDevicesFx.pending, filter: (busy) => OVERLAP === "none" || !busy, target: fetchDevicesFx });
sample({ clock: [deviceSelected, pollTick], source: $panel, filter: (p) => p.selected > 0, fn: (p) => p.selected, target: loadHistoryFx });
sample({ clock: fetchDevicesFx.doneData, fn: (list) => (local: Device[]) => mergeDevices(local, list), target: writeDevices });
sample({
  clock: loadHistoryFx.done,
  source: $panel,
  filter: (panel, { params }) => RACE !== "abort" || params === panel.selected,
  fn: (_, { result }) => () => result,
  target: writeHistory,
});
sample({ clock: loadHistoryFx.done, fn: () => (p: Panel) => ({ ...p, loadingHistory: false }), target: writePanel });
sample({
  clock: loadHistoryFx.fail,
  filter: ({ error }) => (error as Error).name !== "AbortError",
  fn: () => (p: Panel) => ({ ...p, loadingHistory: false, error: "Readings are unavailable" }),
  target: writePanel,
});
sample({ clock: fetchDevicesFx.fail, fn: () => (p: Panel) => ({ ...p, error: "Lost contact with the building gateway" }), target: writePanel });
sample({ clock: fetchDevicesFx.done, fn: () => (p: Panel) => (p.error.startsWith("Lost contact") ? { ...p, error: "" } : p), target: writePanel });

// commands: the UI event carries the target values computed from the optimistic store
sample({ clock: nudged, source: $devices, fn: (ds, { id, delta }) => ({ id, kind: delta > 0 ? "up" : "down", setpoint: ds.find((d) => d.id === id)!.setpoint, on: true }) as Cmd, target: sendCommandFx });
sample({ clock: powerToggled, source: $devices, fn: (ds, id) => ({ id, kind: "power", setpoint: 0, on: ds.find((d) => d.id === id)!.on }) as Cmd, target: sendCommandFx });
sample({
  clock: sendCommandFx.finally,
  fn: ({ params }) => (p: Panel) => {
    const n = (p.pending[params.id] ?? 1) - 1;
    const pending = { ...p.pending };
    if (n > 0) pending[params.id] = n;
    else delete pending[params.id];
    return { ...p, pending };
  },
  target: writePanel,
});
sample({
  clock: sendCommandFx.done,
  // a newer command for the same device is still in flight: its answer will be newer than this one
  fn: ({ result }) => (ds: Device[]) => (ECHO === "pending-aware" && (inflight.get(result.id) ?? 0) > 0 ? ds : ds.map((d) => (d.id === result.id ? result : d))),
  target: writeDevices,
});
sample({
  clock: sendCommandFx.fail,
  fn: ({ params }) => (ds: Device[]) =>
    ds.map((d) => (d.id !== params.id ? d : params.kind === "power" ? { ...d, on: !params.on } : { ...d, setpoint: Math.round((d.setpoint + (params.kind === "up" ? -0.5 : 0.5)) * 10) / 10 })),
  target: writeDevices,
});
sample({ clock: sendCommandFx.fail, fn: ({ params }) => (p: Panel) => ({ ...p, error: `Command to device ${params.id} failed` }), target: writePanel });

// live pushes
function connect() {
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/devices`);
  ws.onopen = () => writePanel((p) => ({ ...p, connected: true }));
  ws.onmessage = (e) => {
    const ev = JSON.parse(String(e.data)) as { type: string; item?: Device };
    if (ev.type !== "updated" || !ev.item) return;
    const item = ev.item;
    writeDevices((ds) => mergeDevices(ds, ds.map((d) => (d.id === item.id ? item : d))));
  };
  ws.onclose = () => {
    writePanel((p) => ({ ...p, connected: false }));
    setTimeout(connect, 2000);
  };
}

// --------------------------------------------------------------------------------------------------- UI
function Dashboard() {
  const [devices, history, panel, online] = useUnit([$devices, $history, $panel, $online]);
  const [select, nudge, power, tick] = useUnit([deviceSelected, nudged, powerToggled, pollTick]);
  useEffect(() => {
    tick();
    const h = setInterval(() => tick(), POLL_MS);
    connect();
    return () => clearInterval(h);
  }, [tick]);
  const sel = devices.find((d) => d.id === panel.selected);
  return (
    <main className="climate">
      <h1>Building B · Climate</h1>
      <p className="status">
        {online}/{devices.length} online · {panel.connected ? "live" : "offline"}{" "}
        <button className="refresh" onClick={() => tick()}>
          Refresh
        </button>
      </p>
      {panel.error && <p role="alert">{panel.error}</p>}
      <ul className="devices">
        {devices.map((d) => (
          <li key={d.id} className={d.online ? "device" : "device offline"}>
            {d.name} · {d.room} · {d.temp}°C → set {d.setpoint}°C · {d.on ? "heating on" : "off"} {panel.pending[d.id] ? <em>sending…</em> : null}{" "}
            <button className="down" disabled={!d.online} onClick={() => nudge({ id: d.id, delta: -0.5 })}>
              −
            </button>
            <button className="up" disabled={!d.online} onClick={() => nudge({ id: d.id, delta: 0.5 })}>
              +
            </button>
            <button className="power" disabled={!d.online} onClick={() => power(d.id)}>
              Power
            </button>
            <button className="details" onClick={() => select(d.id)}>
              Details
            </button>
          </li>
        ))}
      </ul>
      {sel && (
        <section className="history">
          <h2>{sel.name} · recent readings</h2>
          {panel.loadingHistory && !history.length && <p>Loading readings…</p>}
          <ul>
            {history.map((r) => (
              <li key={r.id}>
                {r.temp}°C · {r.humidity}% humidity
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<Dashboard />);
