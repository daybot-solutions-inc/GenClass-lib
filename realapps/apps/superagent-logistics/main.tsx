// Outbound shipment tracking (React 19 + superagent over XMLHttpRequest; state in a reducer backed by a GenClass
// atom, see _shared/react-genclass-reducer). The shipment list is polled every 10 s; the tracked shipment's latest
// scan events are polled every few seconds and merged into its status timeline. Operators relabel several
// shipments at once (bulk PATCH with per-item results) and report issues (a new exception event). Latent bugs by
// flag: timeline merged by appending the events newer than the newest one seen when the poll started
// (merge=append: overlapping polls or a manual refresh append the same scans twice, a late poll reorders them),
// bulk relabel applied to every selected shipment up front and never reconciled with the per-item results
// (bulk=assume-all), a Report button that stays enabled while the report is being sent (reportGuard=none).
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef } from "react";
import request from "superagent";
import { useGenClassReducer } from "../_shared/react-genclass-reducer";
import { flag } from "../_shared/genclass";

type Status = "label_created" | "in_transit" | "out_for_delivery" | "delivered" | "exception";
type Shipment = { id: number; tracking: string; carrier: string; service: string; destination: string; status: Status };
type Ev = { id: number; shipmentId: number; status: Status; location: string; createdAt: string };
type Result = { id: number; ok: boolean; status: number };
type Patch = { carrier: string; service: string };
interface Track {
  shipments: Shipment[];
  counts: Record<string, number>;
  filter: string;
  selectedId: number;
  timeline: Ev[];
  lastSeen: string;
  picked: number[];
  relabelTo: string;
  relabeling: boolean;
  reporting: boolean;
  loading: boolean;
  notice: string;
  error: string;
}
type Act =
  | { type: "shipments/loaded"; items: Shipment[] }
  | { type: "failed"; error: string }
  | { type: "track"; id: number }
  | { type: "timeline/merged"; shipmentId: number; items: Ev[]; since: string }
  | { type: "pick"; id: number }
  | { type: "relabelTo"; value: string }
  | { type: "filter"; value: string }
  | { type: "relabel/start"; ids: number[]; patch: Patch }
  | { type: "relabel/done"; ids: number[]; results: Result[]; patch: Patch }
  | { type: "relabel/failed"; ids: number[] }
  | { type: "report/start" }
  | { type: "report/done"; ev: Ev }
  | { type: "report/failed" };

const MERGE = flag("merge", "by-id") as "by-id" | "append";
const BULK = flag("bulk", "apply-results") as "apply-results" | "assume-all";
const REPORT_GUARD = flag("reportGuard", "disable") as "disable" | "none";
const POLL_MS = Number(flag("pollMs", 3000));
const STATUSES: Status[] = ["label_created", "in_transit", "out_for_delivery", "delivered", "exception"];
const LABEL: Record<Status, string> = { label_created: "label", in_transit: "in transit", out_for_delivery: "out for delivery", delivered: "delivered", exception: "exception" };

const tally = (xs: Shipment[]) => Object.fromEntries(STATUSES.map((st) => [st, xs.filter((x) => x.status === st).length]));
const byNewest = (a: Ev, b: Ev) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
const patchIds = (xs: Shipment[], ids: number[], p: Patch) => xs.map((x) => (ids.includes(x.id) ? { ...x, ...p } : x));

function reducer(s: Track, a: Act): Track {
  switch (a.type) {
    case "shipments/loaded":
      return { ...s, shipments: a.items, counts: tally(a.items), error: s.error.startsWith("Shipments") ? "" : s.error };
    case "failed":
      return { ...s, error: a.error, loading: false };
    case "track":
      return a.id === s.selectedId ? s : { ...s, selectedId: a.id, timeline: [], lastSeen: "", loading: true };
    case "timeline/merged": {
      if (a.shipmentId !== s.selectedId) return { ...s, loading: false };
      let timeline: Ev[];
      if (MERGE === "by-id") {
        const byId = new Map(s.timeline.map((e) => [e.id, e]));
        for (const e of a.items) byId.set(e.id, e);
        timeline = [...byId.values()].sort(byNewest);
      } else timeline = [...a.items.filter((e) => e.createdAt > a.since), ...s.timeline];
      return { ...s, timeline, lastSeen: timeline[0]?.createdAt ?? s.lastSeen, loading: false };
    }
    case "pick":
      return { ...s, picked: s.picked.includes(a.id) ? s.picked.filter((x) => x !== a.id) : [...s.picked, a.id] };
    case "relabelTo":
      return { ...s, relabelTo: a.value };
    case "filter":
      return { ...s, filter: a.value };
    case "relabel/start":
      if (BULK === "assume-all") return { ...s, relabeling: true, shipments: patchIds(s.shipments, a.ids, a.patch), picked: [], notice: "", error: "" };
      return { ...s, relabeling: true, notice: "", error: "" };
    case "relabel/done": {
      if (BULK === "assume-all") return { ...s, relabeling: false, notice: `Relabelled ${a.ids.length} shipments` };
      const ok = a.results.filter((r) => r.ok).map((r) => r.id);
      const failed = a.results.filter((r) => !r.ok).map((r) => r.id);
      return { ...s, relabeling: false, shipments: patchIds(s.shipments, ok, a.patch), picked: failed, notice: `Relabelled ${ok.length} shipments`, error: failed.length ? `${failed.length} could not be relabelled, they are still selected` : "" };
    }
    case "relabel/failed":
      return { ...s, relabeling: false, error: "Relabel failed" };
    case "report/start":
      return { ...s, reporting: true };
    case "report/done": {
      const shipments = s.shipments.map((x) => (x.id === a.ev.shipmentId ? { ...x, status: "exception" as Status } : x));
      const timeline = a.ev.shipmentId === s.selectedId && !s.timeline.some((e) => e.id === a.ev.id) ? [a.ev, ...s.timeline].sort(byNewest) : s.timeline;
      return { ...s, reporting: false, shipments, counts: tally(shipments), timeline, lastSeen: MERGE === "append" ? s.lastSeen : timeline[0]?.createdAt ?? s.lastSeen };
    }
    case "report/failed":
      return { ...s, reporting: false, error: "The issue could not be reported" };
  }
}

const init: Track = { shipments: [], counts: tally([]), filter: "all", selectedId: 0, timeline: [], lastSeen: "", picked: [], relabelTo: "UPS Ground", relabeling: false, reporting: false, loading: false, notice: "", error: "" };

function App() {
  const [s, dispatch] = useGenClassReducer("track", reducer, init);
  const state = useRef(s);
  state.current = s;

  const loadShipments = useCallback(async () => {
    try {
      const r = await request.get("/api/shipments").query({ limit: 50 }).timeout({ response: 5000, deadline: 9000 }).retry(1);
      dispatch({ type: "shipments/loaded", items: (r.body as { results: Shipment[] }).results });
    } catch {
      dispatch({ type: "failed", error: "Shipments could not be refreshed" });
    }
  }, [dispatch]);

  const pollTimeline = useCallback(async () => {
    const id = state.current.selectedId;
    if (!id) return;
    const since = state.current.lastSeen;
    try {
      const r = await request.get("/api/events").query({ shipmentId: id, sort: "-createdAt", limit: 5 }).timeout({ response: 5000 });
      dispatch({ type: "timeline/merged", shipmentId: id, items: (r.body as { results: Ev[] }).results, since });
    } catch {
      dispatch({ type: "failed", error: "Tracking updates are delayed" });
    }
  }, [dispatch]);

  useEffect(() => {
    void loadShipments();
    const h = setInterval(() => void loadShipments(), 10000);
    return () => clearInterval(h);
  }, [loadShipments]);
  useEffect(() => {
    if (!s.selectedId) return;
    void pollTimeline();
    const h = setInterval(() => void pollTimeline(), POLL_MS);
    return () => clearInterval(h);
  }, [s.selectedId, pollTimeline]);

  const relabel = async () => {
    const ids = s.picked;
    if (!ids.length || s.relabeling) return;
    const [carrier, service] = s.relabelTo.split(" ") as [string, string];
    const patch = { carrier, service };
    dispatch({ type: "relabel/start", ids, patch });
    try {
      const r = await request.post("/api/shipments/bulk").send({ ids, op: "patch", patch }).timeout({ response: 8000 });
      dispatch({ type: "relabel/done", ids, results: (r.body as { results: Result[] }).results, patch });
    } catch {
      dispatch({ type: "relabel/failed", ids });
    }
  };

  const report = async () => {
    const id = s.selectedId;
    if (!id || (REPORT_GUARD === "disable" && s.reporting)) return;
    dispatch({ type: "report/start" });
    try {
      const ev = (await request.post("/api/events").send({ shipmentId: id, status: "exception", location: "Reported by operations" }).timeout({ response: 6000 })).body as Ev;
      await request.patch(`/api/shipments/${id}`).send({ status: "exception" }).timeout({ response: 6000 });
      dispatch({ type: "report/done", ev });
    } catch {
      dispatch({ type: "report/failed" });
    }
  };

  const tracked = s.shipments.find((x) => x.id === s.selectedId);
  const shown = s.shipments.filter((x) => s.filter === "all" || x.status === s.filter);
  return (
    <main className="logistics">
      <h1>Outbound shipments</h1>
      <p className="counts">{STATUSES.map((st) => `${s.counts[st] ?? 0} ${LABEL[st]}`).join(" · ")}</p>
      {s.error && <p role="alert">{s.error}</p>}
      {s.notice && <p className="notice">{s.notice}</p>}
      <div className="bulk">
        <select name="relabel" value={s.relabelTo} onChange={(e) => dispatch({ type: "relabelTo", value: e.target.value })}>
          {["UPS Ground", "DHL Express", "FedEx Home"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <button className="relabel" disabled={!s.picked.length || s.relabeling} onClick={() => void relabel()}>
          {s.relabeling ? "Relabelling…" : `Relabel ${s.picked.length} selected`}
        </button>
        <select name="status" value={s.filter} onChange={(e) => dispatch({ type: "filter", value: e.target.value })}>
          {["all", ...STATUSES].map((v) => (
            <option key={v} value={v}>
              {v === "all" ? "all statuses" : LABEL[v as Status]}
            </option>
          ))}
        </select>
      </div>
      <table>
        <tbody>
          {shown.map((x) => (
            <tr key={x.id} className="shipment">
              <td>
                <input type="checkbox" className="pick" checked={s.picked.includes(x.id)} onChange={() => dispatch({ type: "pick", id: x.id })} />
              </td>
              <td>{x.tracking}</td>
              <td>
                {x.carrier} {x.service}
              </td>
              <td>{x.destination}</td>
              <td>{LABEL[x.status]}</td>
              <td>
                <button className="track" onClick={() => dispatch({ type: "track", id: x.id })}>
                  Track
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tracked && (
        <section className="timeline">
          <h2>
            {tracked.tracking} · {tracked.carrier} {tracked.service} to {tracked.destination}{" "}
            <button className="refresh" onClick={() => void pollTimeline()}>
              Refresh
            </button>
          </h2>
          <button className="report" disabled={REPORT_GUARD === "disable" && s.reporting} onClick={() => void report()}>
            {s.reporting ? "Reporting…" : "Report issue"}
          </button>
          {s.loading && <p>Loading scans…</p>}
          <ul>
            {s.timeline.map((e, i) => (
              <li key={`${e.id}:${i}`} className="event">
                {e.createdAt.slice(5, 16).replace("T", " ")} · {e.location} · {LABEL[e.status] ?? e.status}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
