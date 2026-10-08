// Feature flag admin (React 19 + TanStack Query v5 for the flag lists, useGenClassState for UI state; fetch).
// Lists are queried per environment and refetched every few seconds; toggling a flag or changing its rollout is a
// versioned PATCH whose echo is written into the query cache. Teammates flip prod flags too. Latent bugs by flag:
// optimistic toggles without rollback (toggle=optimistic: a failed toggle stays flipped on screen), toggle buttons
// live while the PATCH is in flight (toggleGuard=none: a double click flips twice), writes without the version
// (versioned=false: a teammate's change is overwritten) and rollout saves that can overlap (rolloutSave=parallel).
import { createRoot } from "react-dom/client";
import { useRef } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useGenClassState } from "@genclass/runtime/react";
import { flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Flag = { id: number; env: string; key: string; name: string; enabled: boolean; rollout: number; version: number };
const TOGGLE = flag("toggle", "wait");
const TOGGLE_GUARD = flag("toggleGuard", "pending") === "pending";
const VERSIONED = Boolean(flag("versioned", true));
const ROLLOUT_SAVE = flag("rolloutSave", "serial");
const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 2000 } } });

function Flags() {
  const [ui, setUi] = useGenClassState("flagsUi", { env: "staging", pending: [] as number[], log: [] as string[], killing: false, error: "", notice: "" });
  const client = useQueryClient();
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const q = useQuery({ queryKey: ["flags", ui.env], queryFn: async () => itemsOf<Flag>(await api(`/api/flags?env=${ui.env}&limit=30`)), refetchInterval: 4000 });
  const key = (env: string) => ["flags", env];
  const putFlag = (f: Flag) => client.setQueryData<Flag[]>(key(f.env), (xs) => xs?.map((x) => (x.id === f.id ? f : x)));
  const pend = (id: number, on: boolean) => setUi((s) => ({ ...s, pending: on ? [...s.pending, id] : s.pending.filter((x) => x !== id) }));

  async function write(f: Flag, patch: Partial<Flag>, what: string) {
    try {
      const saved = await api<Flag>(`/api/flags/${f.id}`, "PATCH", VERSIONED ? { ...patch, version: f.version } : patch);
      putFlag(saved);
      setUi((s) => ({ ...s, log: [`${saved.env}/${saved.key} → ${saved.enabled ? "on" : "off"} ${saved.rollout}%`, ...s.log].slice(0, 6), notice: `${saved.name} (${saved.env}): ${saved.enabled ? "on" : "off"}, ${saved.rollout}% rollout.`, error: "" }));
      return true;
    } catch (e) {
      const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Flag | undefined) : undefined;
      if (cur) putFlag(cur);
      setUi((s) => ({ ...s, error: cur ? `${f.name} was changed by someone else — reloaded it.` : errText(e, what) }));
      return false;
    }
  }

  async function toggle(f: Flag) {
    if (TOGGLE_GUARD && ui.pending.includes(f.id)) return;
    const cached = client.getQueryData<Flag[]>(key(f.env))?.find((x) => x.id === f.id) ?? f;
    pend(f.id, true);
    if (TOGGLE !== "wait") putFlag({ ...cached, enabled: !cached.enabled });
    const ok = await write(cached, { enabled: !cached.enabled }, `switching ${f.name}`);
    if (!ok && TOGGLE === "optimistic-rollback") putFlag(cached);
    pend(f.id, false);
  }

  function rollout(f: Flag, raw: string) {
    const pct = Math.max(0, Math.min(100, Math.round(Number(raw))));
    if (!Number.isFinite(pct)) return;
    const run = () => write(client.getQueryData<Flag[]>(key(f.env))?.find((x) => x.id === f.id) ?? f, { rollout: pct }, `setting the rollout of ${f.name}`);
    if (ROLLOUT_SAVE === "serial") chain.current = chain.current.then(run, run);
    else void run();
  }

  async function killAll() {
    const on = (q.data ?? []).filter((f) => f.enabled);
    if (ui.killing || !on.length) return;
    setUi((s) => ({ ...s, killing: true, error: "", notice: "" }));
    try {
      const r = await api<{ results: { id: number; ok: boolean }[] }>(`/api/flags/bulk`, "POST", { ids: on.map((f) => f.id), op: "patch", patch: { enabled: false } });
      const okIds = new Set(r.results.filter((x) => x.ok).map((x) => Number(x.id)));
      client.setQueryData<Flag[]>(key(ui.env), (xs) => xs?.map((x) => (okIds.has(x.id) ? { ...x, enabled: false } : x)));
      void client.invalidateQueries({ queryKey: key(ui.env) });
      const failed = on.length - okIds.size;
      setUi((s) => ({ ...s, notice: `Switched off ${okIds.size} flag(s) in ${s.env}.`, error: failed ? `${failed} flag(s) could not be switched off.` : "" }));
    } catch (e) {
      setUi((s) => ({ ...s, error: errText(e, "the kill switch") }));
    } finally {
      setUi((s) => ({ ...s, killing: false }));
    }
  }

  return (
    <div className="flags">
      <h1>Feature flags</h1>
      <nav className="envs">{["dev", "staging", "prod"].map((e) => <button key={e} className={ui.env === e ? "current" : ""} onClick={() => setUi((s) => ({ ...s, env: e, notice: "", error: "" }))}>{e}</button>)}</nav>
      {ui.error ? <p role="alert">{ui.error}</p> : ui.notice ? <p className="notice">{ui.notice}</p> : null}
      {q.isPending && <p className="muted">Loading flags…</p>}
      {q.isError && !q.data && <p role="alert">Flags could not be loaded.</p>}
      <table><tbody>
        {(q.data ?? []).map((f) => (
          <tr key={f.id} className={`flag ${f.enabled ? "on" : "off"}`}>
            <td><code>{f.key}</code></td><td>{f.name}</td><td>{f.enabled ? "On" : "Off"}</td>
            <td><button className="toggle" disabled={TOGGLE_GUARD && ui.pending.includes(f.id)} onClick={() => void toggle(f)}>{f.enabled ? "Turn off" : "Turn on"}</button></td>
            <td><form onSubmit={(e) => { e.preventDefault(); rollout(f, (e.currentTarget.elements.namedItem("rollout") as HTMLInputElement).value); }}><input className="rollout" name="rollout" defaultValue={String(f.rollout)}  />%</form></td>
          </tr>
        ))}
      </tbody></table>
      <button className="kill" disabled={ui.killing} onClick={() => void killAll()}>{ui.killing ? "Switching off…" : `Switch off everything in ${ui.env}`}</button>
      <h2>Recent changes</h2>
      <ul className="log">{ui.log.map((l, i) => <li key={i}>{l}</li>)}</ul>
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<QueryClientProvider client={qc}><Flags /></QueryClientProvider>);
