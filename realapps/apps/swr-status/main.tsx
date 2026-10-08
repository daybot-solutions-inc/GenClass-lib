// Service status dashboard (React 19 + SWR polling; selection, acknowledgements and in-flight actions kept in a
// runtime atom, SWR's own cache is not wrapped). Incidents can be acknowledged (POST .../ack) and escalated (POST
// .../escalate, relative). Latent bugs and tunings by flag: aggressive polling (refreshInterval), retry storms
// (errorRetryCount), duplicate fetches (dedupingInterval=0), double acks/escalations (actionGuard=none), optimistic
// SWR updates with or without rollback (ackUpdate).
import { createRoot } from "react-dom/client";
import useSWR, { SWRConfig, useSWRConfig } from "swr";
import { useAtom } from "@genclass/runtime/react";
import { rt, flag } from "../_shared/genclass";

type Service = { id: number; name: string; region: string; status: "operational" | "degraded" | "down"; latencyMs: number; uptime: number };
type Incident = { id: number; serviceId: number; title: string; severity: number; status: "open" | "acknowledged"; level: number };
const REFRESH = Number(flag("refreshInterval", 5000));
const RETRIES = Number(flag("errorRetryCount", 3));
const DEDUPE = Number(flag("dedupingInterval", 2000));
const GUARD = flag("actionGuard", "disable") as "disable" | "none";
const ACK_UPDATE = flag("ackUpdate", "revalidate") as "revalidate" | "optimistic" | "optimistic-no-rollback";

const ui = rt.atom("ui", { selected: 0, statusFilter: "all", acked: [] as number[], busy: [] as number[], lastAction: "", error: "" });

async function fetcher<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return (await r.json()) as T;
}

async function post(url: string): Promise<Incident> {
  const r = await fetch(url, { method: "POST", headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as Incident;
}

const busy = (id: number) => ui.get().busy.includes(id);
const setBusy = (id: number, on: boolean) => ui.update((u) => ({ ...u, busy: on ? [...u.busy, id] : u.busy.filter((x) => x !== id) }));

function useIncidentActions(serviceId: number) {
  const { mutate } = useSWRConfig();
  const key = `/api/incidents?serviceId=${serviceId}`;
  const refreshOpen = () => void mutate("/api/incidents?status=open");

  const ack = async (inc: Incident) => {
    if (GUARD === "disable" && (busy(inc.id) || inc.status === "acknowledged")) return;
    setBusy(inc.id, true);
    ui.update((u) => ({ ...u, error: "" }));
    try {
      if (ACK_UPDATE === "revalidate") {
        await post(`/api/incidents/${inc.id}/ack`);
        await mutate(key);
      } else {
        await mutate(
          key,
          async (cur?: { items: Incident[] }) => {
            const saved = await post(`/api/incidents/${inc.id}/ack`);
            return cur ? { ...cur, items: cur.items.map((x) => (x.id === saved.id ? saved : x)) } : cur;
          },
          {
            optimisticData: (cur?: { items: Incident[] }) => (cur ? { ...cur, items: cur.items.map((x) => (x.id === inc.id ? { ...x, status: "acknowledged" as const } : x)) } : { items: [] }),
            rollbackOnError: ACK_UPDATE === "optimistic",
            revalidate: false,
          },
        );
      }
      ui.update((u) => ({ ...u, acked: u.acked.includes(inc.id) ? u.acked : [...u.acked, inc.id], lastAction: `Acknowledged “${inc.title}”` }));
      refreshOpen();
    } catch {
      ui.update((u) => ({ ...u, error: `Could not acknowledge “${inc.title}”` }));
    } finally {
      setBusy(inc.id, false);
    }
  };

  const escalate = async (inc: Incident) => {
    if (GUARD === "disable" && busy(inc.id)) return;
    setBusy(inc.id, true);
    try {
      const saved = await post(`/api/incidents/${inc.id}/escalate`);
      await mutate(key, (cur?: { items: Incident[] }) => (cur ? { ...cur, items: cur.items.map((x) => (x.id === saved.id ? saved : x)) } : cur), { revalidate: false });
      ui.update((u) => ({ ...u, lastAction: `Escalated “${inc.title}” to L${saved.level}`, error: "" }));
    } catch {
      ui.update((u) => ({ ...u, error: `Could not escalate “${inc.title}”` }));
    } finally {
      setBusy(inc.id, false);
    }
  };
  return { ack, escalate };
}

function Detail({ id }: { id: number }) {
  const [u, setU] = useAtom(ui);
  const svc = useSWR<Service>(`/api/services/${id}`);
  const inc = useSWR<{ items: Incident[] }>(`/api/incidents?serviceId=${id}`);
  const { ack, escalate } = useIncidentActions(id);
  return (
    <aside className="detail">
      {svc.data ? (
        <h2>
          {svc.data.name} · {svc.data.status} · {svc.data.latencyMs} ms · {svc.data.uptime.toFixed(2)}%
        </h2>
      ) : (
        <p>Loading service…</p>
      )}
      {(svc.error || inc.error) && <p role="alert">Could not load details</p>}
      <ul>
        {(inc.data?.items ?? []).map((x) => (
          <li key={x.id} className={`incident sev${x.severity}`}>
            <span className="title">{x.title}</span> · {x.status} · L{x.level}
            {u.acked.includes(x.id) && <span className="mine"> (you)</span>}
            <button className="ack" disabled={GUARD === "disable" && (u.busy.includes(x.id) || x.status === "acknowledged")} onClick={() => void ack(x)}>
              Acknowledge
            </button>
            <button className="escalate" disabled={GUARD === "disable" && u.busy.includes(x.id)} onClick={() => void escalate(x)}>
              Escalate
            </button>
          </li>
        ))}
      </ul>
      {inc.data && !inc.data.items.length && <p className="quiet">No incidents.</p>}
      <button className="close-detail" onClick={() => setU((p) => ({ ...p, selected: 0 }))}>
        Close
      </button>
    </aside>
  );
}

function Dashboard() {
  const [u, setU] = useAtom(ui);
  const { mutate } = useSWRConfig();
  const key = u.statusFilter === "all" ? "/api/services" : `/api/services?status=${u.statusFilter}`;
  const { data, error, isValidating } = useSWR<Service[]>(key);
  const open = useSWR<{ items: Incident[]; total: number }>("/api/incidents?status=open");
  const down = (data ?? []).filter((s) => s.status === "down").length;
  const degraded = (data ?? []).filter((s) => s.status === "degraded").length;
  return (
    <main className="status">
      <header>
        <h1>Status</h1>
        <p className="summary">
          {down ? `${down} down` : "No outages"} · {degraded} degraded · {open.data?.total ?? "–"} open incidents
        </p>
        <select name="status" value={u.statusFilter} onChange={(e) => setU((p) => ({ ...p, statusFilter: e.target.value }))}>
          {["all", "operational", "degraded", "down"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className="refresh-now" onClick={() => void mutate(key)}>
          {isValidating ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      {error && <p role="alert">Status feed unavailable ({String((error as Error).message)})</p>}
      {u.error && <p role="alert">{u.error}</p>}
      {u.lastAction && <p className="last">{u.lastAction}</p>}
      <table>
        <tbody>
          {(data ?? []).map((s) => (
            <tr key={s.id} className={`service ${s.status}`}>
              <td>{s.name}</td>
              <td>{s.region}</td>
              <td>{s.status}</td>
              <td>{s.latencyMs} ms</td>
              <td>
                <button className="inspect" onClick={() => setU((p) => ({ ...p, selected: s.id }))}>
                  Details
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {u.selected > 0 && <Detail id={u.selected} />}
    </main>
  );
}

createRoot(document.getElementById("app")!).render(
  <SWRConfig value={{ fetcher, refreshInterval: REFRESH, errorRetryCount: RETRIES, dedupingInterval: DEDUPE }}>
    <Dashboard />
  </SWRConfig>,
);
