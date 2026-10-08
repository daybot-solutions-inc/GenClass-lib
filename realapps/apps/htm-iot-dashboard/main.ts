// Smart-building device dashboard (Preact + htm tagged templates, no JSX build step; WebSocket telemetry + REST
// device commands; state in runtime atoms mirrored into Preact signals). Every device write is answered with the
// device (the command acknowledgement) and is also published on the socket. Latent bugs by flag: acknowledgements and
// socket messages applied without comparing versions (ackApply=blind: a late ack rolls back newer telemetry), a
// socket that reconnects without catching up (reconnect=naive: updates missed while it was down never arrive;
// reconnect=none: live updates just stop), power sent as a relative toggle (powerWrite=toggle: a double click or a
// retried request flips it back), one PATCH per setpoint click instead of a debounced one (setpointSend=each),
// reboot without an in-flight guard (rebootGuard=none: a non-idempotent command sent twice) and an online counter
// kept by +1/-1 bookkeeping (onlineCount=incremental).
import { h, render } from "preact";
import htm from "htm";
import { rt, flag } from "../_shared/genclass";
import { atomSignal } from "../_shared/preact-atom";

const html = htm.bind(h);

type Kind = "thermostat" | "light" | "plug" | "lock";
type Device = { id: number; name: string; room: string; kind: Kind; online: boolean; version: number; temp?: number; setpoint?: number; on?: boolean; watts?: number; locked?: boolean; reboots?: number };

const ACK = flag("ackApply", "version") as "version" | "blind";
const RECONNECT = flag("reconnect", "resync") as "resync" | "naive" | "none";
const POWER = flag("powerWrite", "set") as "set" | "toggle";
const SETPOINT = flag("setpointSend", "debounce") as "debounce" | "each";
const REBOOT_GUARD = flag("rebootGuard", "pending") as "pending" | "none";
const ONLINE = flag("onlineCount", "derived") as "derived" | "incremental";

const onlineOf = (items: Device[]) => items.filter((d) => d.online).length;
const devices = rt.atom("devices", { items: [] as Device[], online: 0, loading: true, connected: false, error: "" });
const ui = rt.atom("ui", { room: "all", drafts: {} as Record<string, number>, busy: {} as Record<string, string> });
const devicesSig = atomSignal(devices);
const uiSig = atomSignal(ui);

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}
async function api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new HttpError(r.status);
  return (await r.json()) as T;
}

// ------------------------------------------------------------------------------------------ device state
/** Apply a device as reported by the server (command ack, socket message or resync). */
function applyDevice(next: Device) {
  devices.update((s) => {
    const cur = s.items.find((d) => d.id === next.id);
    if (!cur) return s;
    if (ACK === "version" && Number(next.version) < Number(cur.version)) return s; // older than what we show
    const items = s.items.map((d) => (d.id === next.id ? { ...d, ...next } : d));
    const delta = cur.online === next.online || next.online === undefined ? 0 : next.online ? 1 : -1;
    return { ...s, items, online: ONLINE === "derived" ? onlineOf(items) : s.online + delta };
  });
  const draft = ui.get().drafts[next.id];
  if (draft !== undefined && next.setpoint === draft) ui.update((u) => ({ ...u, drafts: Object.fromEntries(Object.entries(u.drafts).filter(([k]) => Number(k) !== next.id)) }));
}

let seeded = false; // incremental mode: the counter is taken from the first list only
async function loadDevices(resync = false): Promise<boolean> {
  try {
    const list = await api<Device[]>("/api/devices");
    const seed = !seeded;
    seeded = true;
    if (resync && ACK === "version") list.forEach(applyDevice);
    else devices.update((s) => ({ ...s, items: list, loading: false, error: "", online: ONLINE === "derived" || seed ? onlineOf(list) : s.online }));
    return true;
  } catch {
    devices.update((s) => ({ ...s, error: s.items.length ? "Refreshing devices failed." : "Devices could not be loaded. Retrying…" }));
    return false;
  }
}

async function boot() {
  for (let i = 0; i < 5 && !(await loadDevices()); i++) await new Promise((r) => setTimeout(r, 2000));
  devices.update((s) => (s.loading ? { ...s, loading: false } : s));
  connect();
}

// ------------------------------------------------------------------------------------------------ socket
let socket: WebSocket | null = null;
let everOpened = false;
function connect() {
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/devices`);
  socket = ws;
  ws.onopen = () => {
    devices.update((s) => ({ ...s, connected: true }));
    if (everOpened && RECONNECT === "resync") void loadDevices(true);
    everOpened = true;
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as { type: string; item: Device | null; id: number };
    if (msg.type === "updated" && msg.item) applyDevice(msg.item);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    devices.update((s) => ({ ...s, connected: false }));
    if (RECONNECT !== "none") setTimeout(connect, 1500);
  };
}

// ---------------------------------------------------------------------------------------------- commands
const setBusy = (id: number, what: string | null) =>
  ui.update((u) => {
    const busy = { ...u.busy };
    if (what) busy[id] = what;
    else delete busy[id];
    return { ...u, busy };
  });

async function command(id: number, label: string, req: () => Promise<Device>): Promise<boolean> {
  try {
    applyDevice(await req());
    devices.update((s) => (s.error ? { ...s, error: "" } : s));
    return true;
  } catch (e) {
    const name = devices.get().items.find((d) => d.id === id)?.name ?? "device";
    devices.update((s) => ({ ...s, error: e instanceof HttpError && e.status === 404 ? `${name} is no longer registered.` : `${label} failed for ${name}. The device may be offline.` }));
    return false;
  }
}

const spTimers = new Map<number, ReturnType<typeof setTimeout>>();
function nudgeSetpoint(id: number, delta: number) {
  const d = devices.get().items.find((x) => x.id === id);
  if (!d || d.setpoint === undefined) return;
  const base = ui.get().drafts[id] ?? d.setpoint;
  const next = Math.min(30, Math.max(10, Math.round((base + delta) * 2) / 2));
  ui.update((u) => ({ ...u, drafts: { ...u.drafts, [id]: next } }));
  const send = async () => {
    const value = ui.get().drafts[id] ?? next;
    const ok = await command(id, "Changing the setpoint", () => api<Device>(`/api/devices/${id}`, "PATCH", { setpoint: value }));
    if (!ok && ui.get().drafts[id] === value) ui.update((u) => ({ ...u, drafts: Object.fromEntries(Object.entries(u.drafts).filter(([k]) => Number(k) !== id)) }));
  };
  if (SETPOINT === "each") return void send();
  clearTimeout(spTimers.get(id));
  spTimers.set(id, setTimeout(() => (spTimers.delete(id), void send()), 600));
}

function togglePower(d: Device) {
  if (POWER === "toggle") void command(d.id, "Switching", () => api<Device>(`/api/devices/${d.id}/toggle-power`, "POST", {}));
  else void command(d.id, "Switching", () => api<Device>(`/api/devices/${d.id}`, "PATCH", { on: !d.on }));
}

function toggleLock(d: Device) {
  void command(d.id, d.locked ? "Unlocking" : "Locking", () => api<Device>(`/api/devices/${d.id}/${d.locked ? "unlock" : "lock"}`, "POST", {}));
}

async function reboot(d: Device) {
  if (REBOOT_GUARD === "pending" && ui.get().busy[d.id]) return;
  setBusy(d.id, "rebooting");
  await command(d.id, "Reboot", () => api<Device>(`/api/devices/${d.id}/reboot`, "POST", {}));
  setBusy(d.id, null);
}

// ------------------------------------------------------------------------------------------------------ UI
function Card({ d, draft, busy }: { d: Device; draft?: number; busy?: string }) {
  const sp = draft ?? d.setpoint;
  return html`<li class=${`device ${d.kind}${d.online ? "" : " offline"}`} key=${d.id}>
    <h3>${d.name} <small>${d.room}</small></h3>
    <p class="state">${d.online ? "Online" : "Offline"}${d.kind === "thermostat" ? ` · ${d.temp?.toFixed(1)} °C now, set to ${sp?.toFixed(1)} °C${draft !== undefined && draft !== d.setpoint ? " (sending…)" : ""}` : ""}${d.kind === "light" || d.kind === "plug" ? ` · ${d.on ? "On" : "Off"}${d.kind === "plug" ? ` · ${d.watts ?? 0} W` : ""}` : ""}${d.kind === "lock" ? ` · ${d.locked ? "Locked" : "Unlocked"}` : ""}${d.reboots ? ` · rebooted ${d.reboots}×` : ""}</p>
    <div class="controls">
      ${d.kind === "thermostat" && html`<button class="sp-down" onClick=${() => nudgeSetpoint(d.id, -0.5)}>−</button><button class="sp-up" onClick=${() => nudgeSetpoint(d.id, 0.5)}>+</button>`}
      ${(d.kind === "light" || d.kind === "plug") && html`<button class="power" onClick=${() => togglePower(d)}>${d.on ? "Turn off" : "Turn on"}</button>`}
      ${d.kind === "lock" && html`<button class="lock" onClick=${() => toggleLock(d)}>${d.locked ? "Unlock" : "Lock"}</button>`}
      <button class="reboot" disabled=${REBOOT_GUARD === "pending" && busy === "rebooting"} onClick=${() => void reboot(d)}>${busy === "rebooting" ? "Rebooting…" : "Reboot"}</button>
    </div>
  </li>`;
}

function App() {
  const s = devicesSig.value;
  const u = uiSig.value;
  const rooms = [...new Set(s.items.map((d) => d.room))];
  const shown = s.items.filter((d) => u.room === "all" || d.room === u.room);
  return html`<div class="dash">
    <header><h1>Harbor View Offices — Devices</h1><p class="summary">${s.online} of ${s.items.length} online · ${s.connected ? "Live" : "Reconnecting…"}</p></header>
    <div class="toolbar"><label>Room <select name="room" value=${u.room} onChange=${(e: Event) => ui.update((x) => ({ ...x, room: (e.target as HTMLSelectElement).value }))}><option value="all">All rooms</option>${rooms.map((r) => html`<option value=${r}>${r}</option>`)}</select></label> <button class="refresh" onClick=${() => void loadDevices()}>Refresh</button></div>
    ${s.error && html`<p role="alert">${s.error}</p>`}
    ${s.loading ? html`<p>Loading devices…</p>` : html`<ul class="devices">${shown.map((d) => html`<${Card} key=${d.id} d=${d} draft=${u.drafts[d.id]} busy=${u.busy[d.id]} />`)}</ul>`}
  </div>`;
}

render(html`<${App} />`, document.getElementById("app")!);
void boot();
