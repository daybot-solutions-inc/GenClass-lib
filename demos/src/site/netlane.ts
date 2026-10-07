// A live waterfall of the requests the mock server sees for this page (last 10 s). Read from the server log via
// the control channel, so it shows what really reached the server, including requests the app has given up on.
import type { LogEntry } from "../shared/protocol.ts";
import { epochNow, type ServerLink } from "../shared/server.ts";
import { h } from "./dom.ts";

const WINDOW_MS = 10000;
const ROWS = 8;
const ROW_H = 12;

export function mountNetLane(link: ServerLink): HTMLElement {
  const track = h("div", { class: "netlane-track", "aria-hidden": "true" });
  const count = h("span", { class: "num" }, "");
  const el = h(
    "div",
    { class: "netlane" },
    h(
      "div",
      { class: "netlane-head", html: "" },
      h("b", null, "Server log"),
      count,
      h("div", {
        class: "legend",
        html: `<span><i style="background:color-mix(in srgb,var(--accent) 55%,transparent)"></i>ok</span><span><i style="background:var(--bad)"></i>5xx / network</span><span><i style="background:var(--warn)"></i>lost after commit</span>`,
      }),
    ),
    track,
  );

  const entries = new Map<number, LogEntry>();
  let since = 0;
  let total = 0;
  const bars = new Map<number, HTMLElement>();
  const rowOf = new Map<number, number>();

  const poll = async () => {
    try {
      const r = await link.log(since);
      for (const e of r.log) {
        if (!entries.has(e.id)) total++;
        entries.set(e.id, e);
      }
      // Keep pending entries re-polled: ask from the oldest pending id.
      let oldestPending = Infinity;
      let maxId = since;
      for (const e of entries.values()) {
        maxId = Math.max(maxId, e.id);
        if (e.outcome === "pending") oldestPending = Math.min(oldestPending, e.id);
      }
      since = Number.isFinite(oldestPending) ? oldestPending - 1 : maxId;
    } catch {
      /* the page may be navigating */
    }
  };

  /** Short label: "GET /search?q=san", "PUT /notes/n1". */
  const labelOf = (e: LogEntry) => `${e.method} ${e.path}${e.query}`.slice(0, 34);
  const LABEL_PX_PER_CH = 6.1;
  const labelled = new Map<number, boolean>();

  const render = () => {
    const now = epochNow();
    const left = now - WINDOW_MS;
    const width = track.clientWidth || 800;
    const msPerPx = WINDOW_MS / width;
    // Each row is busy until this time (ms) including the room its last label needs.
    const busyUntil: number[] = new Array(ROWS).fill(-Infinity);
    for (const [id, row] of rowOf) {
      const e = entries.get(id);
      if (!e) continue;
      const end = e.tEnd ?? now;
      const room = labelled.get(id) ? (labelOf(e).length * LABEL_PX_PER_CH + 14) * msPerPx : 0;
      busyUntil[row] = Math.max(busyUntil[row], end + room);
    }
    const sorted = [...entries.values()].sort((a, b) => a.t0 - b.t0);
    // A busy lane (polling dashboards) reads better as bars only; hover a bar for its request.
    const crowded = sorted.filter((e) => (e.tEnd ?? now) >= left).length > 22;
    for (const e of sorted) {
      const end = e.tEnd ?? now;
      if (end < left - 1000) {
        entries.delete(e.id);
        bars.get(e.id)?.remove();
        bars.delete(e.id);
        rowOf.delete(e.id);
        labelled.delete(e.id);
        continue;
      }
      let row = rowOf.get(e.id);
      if (row === undefined) {
        const labelRoom = (labelOf(e).length * LABEL_PX_PER_CH + 14) * msPerPx;
        row = busyUntil.findIndex((t) => t < e.t0 - 30 * msPerPx);
        let withLabel = row >= 0 && !crowded;
        if (row < 0) {
          // No free row: put the bar on the row that frees up first, without a label.
          row = busyUntil.indexOf(Math.min(...busyUntil));
          withLabel = false;
        }
        rowOf.set(e.id, row);
        labelled.set(e.id, withLabel);
        busyUntil[row] = Math.max(busyUntil[row], end + (withLabel ? labelRoom : 4 * msPerPx));
      }
      let bar = bars.get(e.id);
      if (!bar) {
        bar = h("div", { class: "netlane-bar" }, labelled.get(e.id) ? h("span", { class: "lbl" }, labelOf(e)) : null);
        bars.set(e.id, bar);
        track.appendChild(bar);
      }
      const x = ((e.t0 - left) / WINDOW_MS) * 100;
      const w = Math.max(0.4, ((end - e.t0) / WINDOW_MS) * 100);
      bar.style.left = `${x}%`;
      bar.style.width = `${w}%`;
      bar.style.top = `${5 + row * ROW_H}px`;
      bar.className = `netlane-bar ${e.outcome}${e.spike ? " spike" : ""}`;
      bar.title = `${e.method} ${e.path}${e.query} → ${e.status ?? e.outcome} in ${Math.round(end - e.t0)} ms${e.effect ? ` (${e.effect})` : ""}${e.aborted ? " · aborted by the page" : ""}`;
    }
    count.textContent = `${total} requests`;
  };

  let pollTimer = 0;
  let last = 0;
  const loop = (t: number) => {
    if (t - last > 70) {
      last = t;
      render();
    }
    requestAnimationFrame(loop);
  };
  const startPolling = () => {
    void poll();
    pollTimer = window.setInterval(poll, 300);
  };
  startPolling();
  requestAnimationFrame(loop);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearInterval(pollTimer);
    else startPolling();
  });
  return el;
}
