// CI pipeline dashboard (React 19 + useGenClassState + fetch). The list polls; a pipeline can be re-run (relative,
// non-idempotent POST) or cancelled (versioned PATCH), and opening one loads its jobs. Latent bugs by flag:
// setInterval polling that piles up slow requests (pollMode=interval), job lists applied whatever pipeline is open
// now (detailSeq=blind), re-run buttons that stay clickable while posting (rerunGuard=none) and cancels sent
// without the version (cancel=force: a pipeline that finished meanwhile is overwritten as cancelled).
import { createRoot } from "react-dom/client";
import { useEffect, useRef } from "react";
import { useGenClassState } from "@genclass/runtime/react";
import { flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Pipeline = { id: number; branch: string; commit: string; title: string; status: string; runs: number; duration: number; version: number };
type Job = { id: number; pipelineId: number; name: string; status: string };
const POLL_MODE = flag("pollMode", "chain");
const DETAIL_SEQ = flag("detailSeq", "latest");
const RERUN_GUARD = flag("rerunGuard", "disable");
const CANCEL = flag("cancel", "if-match");
const POLL_MS = Number(flag("pollMs", 3000));
const failingOf = (ps: Pipeline[]) => ps.filter((p) => p.status === "failed").length;

function App() {
  const [ci, setCi] = useGenClassState("ci", { branch: "all", items: [] as Pipeline[], failing: 0, busy: [] as number[], loading: true, error: "", notice: "" });
  const [detail, setDetail] = useGenClassState("detail", { id: 0, jobs: [] as Job[], loading: false, error: "" });
  const branchRef = useRef("all");
  const openRef = useRef(0);
  const busyRef = useRef(new Set<number>());

  async function poll(branch = branchRef.current) {
    try {
      const q = branch === "all" ? "" : `&branch=${encodeURIComponent(branch)}`;
      const items = itemsOf<Pipeline>(await api(`/api/pipelines?sort=-id&limit=30${q}`));
      if (branch !== branchRef.current) return;
      setCi((s) => {
        const mine = new Map(s.items.map((p) => [p.id, p]));
        const merged = items.map((p) => (busyRef.current.has(p.id) ? (mine.get(p.id) ?? p) : p));
        return { ...s, items: merged, failing: failingOf(merged), loading: false };
      });
    } catch (e) {
      if (branch === branchRef.current) setCi((s) => ({ ...s, loading: false, error: s.items.length ? s.error : errText(e, "loading pipelines") }));
    }
  }

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    if (POLL_MODE === "interval") {
      void poll();
      const iv = setInterval(() => void poll(), POLL_MS);
      return () => clearInterval(iv);
    }
    const loop = async () => {
      await poll();
      if (!stop) timer = setTimeout(loop, POLL_MS);
    };
    void loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);

  function changeBranch(b: string) {
    branchRef.current = b;
    setCi((s) => ({ ...s, branch: b, loading: true, error: "" }));
    void poll(b);
  }

  async function open(id: number) {
    openRef.current = id;
    setDetail({ id, jobs: [], loading: true, error: "" });
    try {
      const jobs = itemsOf<Job>(await api(`/api/jobs?pipelineId=${id}&limit=20`));
      if (DETAIL_SEQ === "latest" && openRef.current !== id) return;
      setDetail((d) => ({ ...d, jobs, loading: false }));
    } catch (e) {
      if (openRef.current === id) setDetail((d) => ({ ...d, loading: false, error: errText(e, "loading jobs") }));
    }
  }

  const mark = (id: number, on: boolean) => {
    if (on) busyRef.current.add(id);
    else busyRef.current.delete(id);
    setCi((s) => ({ ...s, busy: [...busyRef.current] }));
  };
  const replace = (p: Pipeline) => setCi((s) => {
    const items = s.items.map((x) => (x.id === p.id ? p : x));
    return { ...s, items, failing: failingOf(items) };
  });

  async function rerun(p: Pipeline) {
    if (RERUN_GUARD === "disable" && busyRef.current.has(p.id)) return;
    mark(p.id, true);
    try {
      const saved = await api<Pipeline>(`/api/pipelines/${p.id}/rerun`, "POST");
      const queued = await api<Pipeline>(`/api/pipelines/${p.id}`, "PATCH", { status: "queued", version: saved.version });
      replace(queued);
      setCi((s) => ({ ...s, notice: `Re-run #${queued.runs} of ${queued.title} queued.`, error: "" }));
    } catch (e) {
      setCi((s) => ({ ...s, error: errText(e, "the re-run") }));
    } finally {
      mark(p.id, false);
    }
  }

  async function cancel(p: Pipeline) {
    if (busyRef.current.has(p.id)) return;
    mark(p.id, true);
    try {
      const saved = await api<Pipeline>(`/api/pipelines/${p.id}`, "PATCH", CANCEL === "if-match" ? { status: "canceled", version: p.version } : { status: "canceled" });
      replace(saved);
      setCi((s) => ({ ...s, notice: `${saved.title} cancelled.`, error: "" }));
    } catch (e) {
      if (e instanceof HttpError && e.status === 409 && e.body?.current) {
        replace(e.body.current);
        setCi((s) => ({ ...s, error: `${p.title} already ${e.body.current.status}; nothing to cancel.` }));
      } else setCi((s) => ({ ...s, error: errText(e, "the cancel") }));
    } finally {
      mark(p.id, false);
    }
  }

  return (
    <div className="ci">
      <header>
        <h1>Pipelines</h1>
        <label>
          Branch{" "}
          <select name="branch" value={ci.branch} onChange={(e) => changeBranch(e.target.value)}>
            {["all", "main", "release/2.4", "feat/search", "fix/login"].map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <span className="failing">{ci.failing} failing</span> {ci.loading && <span className="muted">Loading…</span>}
      </header>
      {ci.error ? <p role="alert">{ci.error}</p> : ci.notice ? <p className="notice">{ci.notice}</p> : null}
      <table>
        <tbody>
          {ci.items.map((p) => {
            const busy = ci.busy.includes(p.id);
            return (
              <tr key={p.id} className={`pipeline ${p.status}`}>
                <td>#{p.id}</td><td>{p.branch}</td><td>{p.title}</td><td className="status">{p.status}</td><td>run {p.runs}</td>
                <td>
                  <button className="open" onClick={() => void open(p.id)}>Jobs</button>{" "}
                  {(p.status === "failed" || p.status === "passed" || p.status === "canceled") && <button className="rerun" disabled={RERUN_GUARD === "disable" && busy} onClick={() => void rerun(p)}>Re-run</button>}
                  {(p.status === "running" || p.status === "queued") && <button className="cancel" disabled={busy} onClick={() => void cancel(p)}>Cancel</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {detail.id !== 0 && (
        <aside className="jobs">
          <h2>Pipeline #{detail.id}</h2> <button className="close" onClick={() => { openRef.current = 0; setDetail({ id: 0, jobs: [], loading: false, error: "" }); }}>Close</button>
          {detail.loading && <p className="muted">Loading jobs…</p>}
          {detail.error && <p role="alert">{detail.error}</p>}
          <ol>{detail.jobs.map((j) => <li key={j.id} className={`job ${j.status}`}>{j.name}: {j.status}</li>)}</ol>
        </aside>
      )}
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
