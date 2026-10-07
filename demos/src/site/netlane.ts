// A live waterfall of the requests the mock server sees for this page (last 10 s). Read from the server log via
// the control channel, so it shows what really reached the server, including requests the app has given up on.
import type { LogEntry } from "../shared/protocol.ts";
import { epochNow, type ServerLink } from "../shared/server.ts";
import { h } from "./dom.ts";

const WINDOW_MS = 10000;
const ROWS = 7;
const ROW_H = 12.5;

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

  const render = () => {
    const now = epochNow();
    const left = now - WINDOW_MS;
    const busyUntil: number[] = new Array(ROWS).fill(-Infinity);
    const sorted = [...entries.values()].sort((a, b) => a.t0 - b.t0);
    for (const e of sorted) {
      const end = e.tEnd ?? now;
      if (end < left - 1000) {
        entries.delete(e.id);
        bars.get(e.id)?.remove();
        bars.delete(e.id);
        rowOf.delete(e.id);
        continue;
      }
      let row = rowOf.get(e.id);
      if (row === undefined) {
        row = busyUntil.findIndex((t) => t < e.t0 - 40);
        if (row < 0) row = ROWS - 1;
        rowOf.set(e.id, row);
      }
      busyUntil[row] = Math.max(busyUntil[row], end + 600);
      let bar = bars.get(e.id);
      if (!bar) {
        bar = h("div", { class: "netlane-bar" }, h("span", { class: "lbl" }, `${e.method} ${e.path}${e.query}`.slice(0, 42)));
        bars.set(e.id, bar);
        track.appendChild(bar);
      }
      const x = ((e.t0 - left) / WINDOW_MS) * 100;
      const w = Math.max(0.4, ((end - e.t0) / WINDOW_MS) * 100);
      bar.style.left = `${x}%`;
      bar.style.width = `${w}%`;
      bar.style.top = `${4 + row * ROW_H}px`;
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
