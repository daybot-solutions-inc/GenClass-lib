// Studio time tracker (Hyperapp 2: actions, effects and subscriptions; fetch). Timers tick locally every second, push
// their elapsed time to the server every 5 s and pull the shared timesheet every 8 s (teammates start and stop
// timers too). Hyperapp's state is registered through a dispatch middleware + rt.guard; HTTP results are applied
// through the guarded handle. Latent bugs by flag: start/stop sent as a server-side toggle (toggleMode=toggle: the
// automatic retry after a 5xx that had already committed flips the timer back), Start/Stop not locked while its
// request is pending (toggleGuard=false: a double click starts and stops), pulls that replace local timers (pull=blind:
// a pull from before a click undoes it, and elapsed time jumps back to the server's lagging copy), elapsed time pushed
// as increments re-sent after failures (logMode=increment: a push that committed before its 5xx is counted twice),
// the day total only advanced by ticks (total=tick-only: pulls and new timers leave it wrong).
import { app, h, text } from "hyperapp";
import { flag } from "../_shared/genclass";
import { hyperappGuard } from "../_shared/hyperapp-guard";

type Timer = { id: number; project: string; client: string; running: boolean; seconds: number };
type Sheet = { timers: Timer[]; total: number; project: string; toggling: number[]; adding: boolean; loaded: boolean; error: string };
type Fx = [(d: (a: unknown, p?: unknown) => void, p: any) => void, any];

const TOGGLE_MODE = flag("toggleMode", "set") as "set" | "toggle";
const TOGGLE_GUARD = Boolean(flag("toggleGuard", true));
const PULL = flag("pull", "pending-aware") as "pending-aware" | "blind";
const LOG_MODE = flag("logMode", "absolute") as "absolute" | "increment";
const TOTAL = flag("total", "derive") as "derive" | "tick-only";
const PROJECTS = ["Harbour rebrand", "Tidewater website", "Northlight annual report", "Internal: hiring"];

const sumSeconds = (ts: Timer[]) => ts.reduce((a, t) => a + Number(t.seconds || 0), 0);
const withTimers = (s: Sheet, timers: Timer[]): Sheet => ({ ...s, timers, total: TOTAL === "derive" ? sumSeconds(timers) : s.total });
const clock = (sec: number) => `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;

const init: Sheet = { timers: [], total: 0, project: PROJECTS[0]!, toggling: [], adding: false, loaded: false, error: "" };
const { middleware, store: sheet } = hyperappGuard<Sheet>("timesheet", init);

// ------------------------------------------------------------------------------------------- effects
/** Elapsed seconds the server has acknowledged per timer (what the next push is measured from). */
const synced = new Map<number, number>();
/** Toggle requests in flight per timer (pull merging keeps the local running state while > 0). */
const togglesInflight = new Map<number, number>();
let pullsBlocked = 0;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return (r.status === 204 ? null : await r.json()) as T;
}

const pullFx = (): Fx => [
  () => {
    const blockedAt = pullsBlocked;
    api<{ items: Timer[] }>("/api/timers?limit=50")
      .then((body) =>
        sheet.update((s) => {
          const server = Array.isArray(body.items) ? body.items : [];
          if (!s.loaded) for (const t of server) synced.set(t.id, Number(t.seconds));
          if (PULL === "blind" || !s.loaded) return { ...withTimers(s, server), total: TOTAL === "derive" || !s.loaded ? sumSeconds(server) : s.total, loaded: true };
          if (blockedAt !== pullsBlocked) return s; // a toggle started or finished while this pull was in flight
          const mine = new Map(s.timers.map((t) => [t.id, t]));
          const timers = server.map((t) => {
            const local = mine.get(t.id);
            if (!local) return t;
            // the server's copy of elapsed time lags the local clock by up to one push
            const seconds = Math.max(local.seconds, Number(t.seconds));
            return (togglesInflight.get(t.id) ?? 0) > 0 ? { ...t, running: local.running, seconds } : { ...t, seconds };
          });
          return withTimers(s, timers);
        }),
      )
      .catch(() => sheet.update((s) => (s.loaded ? s : { ...s, error: "The timesheet couldn't be loaded. Retrying…" })));
  },
  null,
];

const pushFx = (timers: Timer[]): Fx => [
  () => {
    for (const t of timers) {
      const base = synced.get(t.id) ?? 0;
      const delta = t.seconds - base;
      if (delta <= 0) continue;
      const req =
        LOG_MODE === "increment"
          ? api<Timer>(`/api/timers/${t.id}/log`, { method: "POST", body: JSON.stringify({ by: delta }) })
          : api<Timer>(`/api/timers/${t.id}`, { method: "PATCH", body: JSON.stringify({ seconds: t.seconds }) });
      req.then(
        () => synced.set(t.id, Math.max(synced.get(t.id) ?? 0, base + delta)),
        () => {}, // unsynced time is sent with the next push
      );
    }
  },
  null,
];

const toggleFx = (t: Timer, running: boolean): Fx => [
  () => {
    pullsBlocked++;
    togglesInflight.set(t.id, (togglesInflight.get(t.id) ?? 0) + 1);
    const send = () =>
      TOGGLE_MODE === "toggle"
        ? api<Timer>(`/api/timers/${t.id}/toggle`, { method: "POST" })
        : api<Timer>(`/api/timers/${t.id}`, { method: "PATCH", body: JSON.stringify({ running, seconds: t.seconds }) });
    const settle = () => {
      pullsBlocked++;
      togglesInflight.set(t.id, Math.max(0, (togglesInflight.get(t.id) ?? 1) - 1));
    };
    send()
      .catch((e: { status?: number }) => (e.status && e.status >= 500 ? send() : Promise.reject(e))) // one automatic retry on a server error
      .then((saved) => {
        settle();
        if (TOGGLE_MODE === "set") synced.set(t.id, Math.max(synced.get(t.id) ?? 0, t.seconds));
        sheet.update((s) => {
          const timers = s.timers.map((x) => (x.id === t.id && (togglesInflight.get(t.id) ?? 0) === 0 ? { ...x, running: Boolean(saved.running) } : x));
          return { ...withTimers(s, timers), toggling: s.toggling.filter((id) => id !== t.id) };
        });
      })
      .catch(() => {
        settle();
        sheet.update((s) => {
          const timers = s.timers.map((x) => (x.id === t.id && x.running === running ? { ...x, running: !running } : x));
          return { ...withTimers(s, timers), toggling: s.toggling.filter((id) => id !== t.id), error: `Couldn't ${running ? "start" : "stop"} “${t.project}”.` };
        });
      });
  },
  null,
];

const addFx = (project: string): Fx => [
  () => {
    api<Timer>("/api/timers", { method: "POST", body: JSON.stringify({ project, client: project.startsWith("Internal") ? "Studio" : "Client", running: false, seconds: 0 }) })
      .then((t) => {
        synced.set(t.id, 0);
        sheet.update((s) => ({ ...withTimers(s, s.timers.some((x) => x.id === t.id) ? s.timers : [...s.timers, t]), adding: false }));
      })
      .catch(() => sheet.update((s) => ({ ...s, adding: false, error: `Couldn't add a timer for “${project}”.` })));
  },
  null,
];

// ------------------------------------------------------------------------------------------- actions
const Tick = (s: Sheet): Sheet => {
  const running = s.timers.filter((t) => t.running).length;
  if (!running) return s;
  return { ...s, timers: s.timers.map((t) => (t.running ? { ...t, seconds: t.seconds + 1 } : t)), total: s.total + running };
};
const Push = (s: Sheet) => [s, pushFx(s.timers)];
const Pull = (s: Sheet) => [s, pullFx()];
const Toggle = (s: Sheet, id: number) => {
  const t = s.timers.find((x) => x.id === id);
  if (!t || (TOGGLE_GUARD && s.toggling.includes(id))) return s;
  const running = !t.running;
  return [{ ...s, error: "", toggling: [...s.toggling, id], timers: s.timers.map((x) => (x.id === id ? { ...x, running } : x)) }, toggleFx(t, running)];
};
const PickProject = (s: Sheet, ev: Event): Sheet => ({ ...s, project: (ev.target as HTMLSelectElement).value });
const Add = (s: Sheet) => (s.adding ? s : [{ ...s, adding: true, error: "" }, addFx(s.project)]);
const Refresh = (s: Sheet) => [{ ...s, error: "" }, pullFx()];

const every = (ms: number, action: unknown) => [
  (dispatch: (a: unknown) => void, p: { ms: number; action: unknown }) => {
    const id = setInterval(() => dispatch(p.action), p.ms);
    return () => clearInterval(id);
  },
  { ms, action },
];

// ---------------------------------------------------------------------------------------------- view
const view = (s: Sheet) =>
  h("main", { class: "timesheet" }, [
    h("header", {}, [h("h1", {}, text("Studio timesheet")), h("p", { class: "total" }, text(`Today ${clock(s.total)} · ${s.timers.filter((t) => t.running).length} running`))]),
    h("div", { class: "add" }, [
      h("label", {}, [text("Project "), h("select", { name: "project", onchange: PickProject }, PROJECTS.map((p) => h("option", { value: p, selected: p === s.project }, text(p))))]),
      h("button", { class: "add-timer", disabled: s.adding, onclick: Add }, text(s.adding ? "Adding…" : "New timer")),
      h("button", { class: "refresh", onclick: Refresh }, text("Refresh")),
    ]),
    s.error ? h("p", { role: "alert" }, text(s.error)) : text(""),
    !s.loaded && !s.error ? h("p", {}, text("Loading timers…")) : text(""),
    h(
      "ul",
      { class: "timers" },
      s.timers.map((t) =>
        h("li", { class: t.running ? "timer running" : "timer", key: t.id }, [
          h("span", { class: "project" }, text(`${t.project} · ${t.client}`)),
          h("span", { class: "elapsed" }, text(` ${clock(t.seconds)} `)),
          h("button", { class: "toggle", disabled: TOGGLE_GUARD && s.toggling.includes(t.id), onclick: [Toggle, t.id] }, text(t.running ? "Stop" : "Start")),
        ]),
      ),
    ),
  ]);

app<Sheet>({
  init: [init, pullFx()],
  view,
  node: document.getElementById("app")!,
  subscriptions: (s: Sheet) => [s.timers.some((t) => t.running) && every(1000, Tick), every(5000, Push), every(8000, Pull)],
  dispatch: middleware,
} as never);
