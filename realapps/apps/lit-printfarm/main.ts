// 3D print farm console (Lit 3 web components with shadow DOM; state in a runtime atom bound through AtomController;
// fetch + WebSocket; errors go to a light-DOM toast region). Printers stream status and progress over the live topic
// as prints advance and other operators start jobs. Sending a job to an idle printer claims it (versioned PATCH
// status=busy, so two operators cannot take the same printer) and then files the job (POST /jobs; required fields;
// the printer is given back when filing fails). The job queue pages by cursor ("Older jobs") under a status filter;
// a printing job can be cancelled (versioned PATCH status=cancelled, then POST /printers/:id/free) and a failed one
// reprinted (POST /jobs/:id/reprint: relative, counts attempts). Latent bugs by flag: printer pushes and HTTP echoes
// applied in arrival order (live=blind: an older copy overwrites a newer one), Send/Reprint buttons live while their
// request is in flight (submitGuard=none: the second claim answers 409, a second reprint counts twice), cancels sent
// without the version (cancel=force: a job that just finished is marked cancelled and its printer — maybe printing
// someone else's job by now — is freed), a filter change that keeps the old cursor and applies pages in arrival
// order (queueCursor=keep: the new filter shows an empty or partial page, or rows from the previous filter) and
// reconnects without a reload (reconnect=naive).
import { LitElement, html, css, nothing } from "lit";
import { rt, flag } from "../_shared/genclass";
import { AtomController } from "../_shared/lit-atom";
import { toast } from "../_shared/lit-toast";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

type Printer = { id: number; name: string; model: string; status: "idle" | "busy" | "error"; progress: number; file: string; note?: string; version: number };
type Job = { id: number; file: string; material: string; printerId: number; printer: string; for: string; status: string; attempts: number; version: number; createdAt?: string };

const LIVE = flag("live", "version-check");
const SUBMIT_GUARD = flag("submitGuard", "pending") === "pending";
const CANCEL = flag("cancel", "if-match");
const QUEUE_CURSOR = flag("queueCursor", "reset-on-filter");
const RECONNECT = flag("reconnect", "resync");
const FILES = ["bracket-v3.stl", "gear-housing.stl", "phone-stand.stl", "drone-arm.stl"];
const MATERIALS = ["PLA", "PETG", "ABS"];
const FILTERS: [string, string][] = [["all", "All"], ["printing", "Printing"], ["failed", "Failed"], ["done", "Done"]];
const PAGE = 6;

const idleOf = (ps: Printer[]) => ps.filter((p) => p.status === "idle").length;
const farm = rt.atom("farm", {
  printers: [] as Printer[],
  idle: 0,
  jobs: [] as Job[],
  filter: "all",
  cursor: "",
  more: false,
  loadingJobs: true,
  file: FILES[0]!,
  material: MATERIALS[0]!,
  sending: [] as number[],
  working: [] as number[],
  live: false,
  error: "",
  notice: "",
});
type F = ReturnType<typeof farm.get>;

function putPrinter(s: F, p: Printer): F {
  const cur = s.printers.find((x) => x.id === p.id);
  if (cur && LIVE === "version-check" && Number(p.version) < Number(cur.version)) return s;
  const printers = cur ? s.printers.map((x) => (x.id === p.id ? p : x)) : [...s.printers, p];
  return { ...s, printers, idle: idleOf(printers) };
}
const applyPrinter = (p: Printer) => farm.update((s) => putPrinter(s, p));
/** a job changed by us: replaced in place, or dropped when it no longer matches the filter */
const putJob = (j: Job) => farm.update((s) => ({ ...s, jobs: s.filter === "all" || j.status === s.filter ? s.jobs.map((x) => (x.id === j.id ? j : x)) : s.jobs.filter((x) => x.id !== j.id) }));
const fail = (msg: string) => {
  farm.update((s) => ({ ...s, error: msg, notice: "" }));
  toast(msg);
};

async function loadPrinters() {
  try {
    const printers = itemsOf<Printer>(await api(`/api/printers?limit=20`));
    farm.update((s) => ({ ...s, printers, idle: idleOf(printers) }));
  } catch (e) {
    fail(errText(e, "loading printers"));
    setTimeout(() => void loadPrinters(), 3000);
  }
}

let jobSeq = 0;
async function loadJobs(append: boolean) {
  const my = ++jobSeq;
  const s0 = farm.get();
  farm.update((s) => ({ ...s, loadingJobs: true }));
  try {
    const q = s0.filter === "all" ? "" : `&status=${s0.filter}`;
    const body = await api<{ items: Job[]; nextCursor: string | null }>(`/api/jobs?sort=-createdAt&limit=${PAGE}${q}&cursor=${append ? s0.cursor : QUEUE_CURSOR === "keep" ? s0.cursor : ""}`);
    if (QUEUE_CURSOR === "reset-on-filter" && my !== jobSeq) return;
    const page = itemsOf<Job>(body);
    farm.update((s) => ({ ...s, jobs: [...s.jobs, ...page.filter((j) => !s.jobs.some((x) => x.id === j.id))], cursor: body?.nextCursor ?? s.cursor, more: !!body?.nextCursor, loadingJobs: false }));
  } catch (e) {
    if (QUEUE_CURSOR === "reset-on-filter" && my !== jobSeq) return;
    farm.update((s) => ({ ...s, loadingJobs: false }));
    fail(errText(e, "loading the job queue"));
  }
}
function setFilter(filter: string) {
  if (filter === farm.get().filter) return;
  farm.update((s) => ({ ...s, filter, jobs: [], more: false, ...(QUEUE_CURSOR === "reset-on-filter" ? { cursor: "" } : {}) }));
  void loadJobs(false);
}

async function send(p: Printer) {
  const s0 = farm.get();
  if (SUBMIT_GUARD && s0.sending.includes(p.id)) return;
  const file = s0.file;
  const material = s0.material;
  farm.update((s) => ({ ...s, sending: [...s.sending, p.id], error: "", notice: "" }));
  try {
    const claimed = await api<Printer>(`/api/printers/${p.id}`, "PATCH", { status: "busy", progress: 0, file, version: p.version });
    applyPrinter(claimed);
    let job: Job;
    try {
      job = await api<Job>(`/api/jobs`, "POST", { file, material, printerId: p.id, printer: p.name, for: "You", status: "printing", attempts: 1 });
    } catch (e) {
      const back = await api<Printer>(`/api/printers/${p.id}`, "PATCH", { status: "idle", progress: 0, file: "", version: claimed.version }).catch(() => null);
      if (back) applyPrinter(back);
      throw e;
    }
    farm.update((s) => ({ ...s, jobs: s.filter === "all" || s.filter === "printing" ? [job, ...s.jobs] : s.jobs, notice: `${file} is printing on ${p.name}.` }));
  } catch (e) {
    const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Printer | undefined) : undefined;
    if (cur) applyPrinter(cur);
    fail(cur ? `${p.name} was just taken by another operator.` : errText(e, `sending the job to ${p.name}`));
  } finally {
    farm.update((s) => ({ ...s, sending: s.sending.filter((x) => x !== p.id) }));
  }
}

async function jobAction(j: Job, what: "cancel" | "reprint") {
  if (SUBMIT_GUARD && farm.get().working.includes(j.id)) return;
  farm.update((s) => ({ ...s, working: [...s.working, j.id], error: "", notice: "" }));
  try {
    if (what === "cancel") {
      const saved = await api<Job>(`/api/jobs/${j.id}`, "PATCH", CANCEL === "if-match" ? { status: "cancelled", version: j.version } : { status: "cancelled" });
      putJob(saved);
      applyPrinter(await api<Printer>(`/api/printers/${j.printerId}/free`, "POST"));
      farm.update((s) => ({ ...s, notice: `Cancelled ${j.file} on ${j.printer}.` }));
    } else {
      putJob(await api<Job>(`/api/jobs/${j.id}/reprint`, "POST"));
      farm.update((s) => ({ ...s, notice: `${j.file} is queued again.` }));
    }
  } catch (e) {
    const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Job | undefined) : undefined;
    if (cur) putJob(cur);
    fail(cur ? `${j.file} is already ${cur.status}.` : errText(e, what === "cancel" ? `cancelling ${j.file}` : `reprinting ${j.file}`));
  } finally {
    farm.update((s) => ({ ...s, working: s.working.filter((x) => x !== j.id) }));
  }
}

// ------------------------------------------------------------------------------------------ components
class JobQueue extends LitElement {
  private f = new AtomController(this, farm);
  static styles = css`
    nav button.current { font-weight: 700; }
    li.job { margin: 4px 0; }
  `;
  render() {
    const s = this.f.value;
    return html`<h2>Job queue</h2>
      <nav class="filters">${FILTERS.map(([v, label]) => html`<button type="button" class=${s.filter === v ? "current" : ""} @click=${() => setFilter(v)}>${label}</button> `)}</nav>
      ${s.loadingJobs && !s.jobs.length ? html`<p class="muted">Loading jobs…</p>` : nothing}
      ${!s.loadingJobs && !s.jobs.length ? html`<p class="muted">No jobs here.</p>` : nothing}
      <ul class="jobs">${s.jobs.map(
        (j) => html`<li class="job ${j.status}">${j.file} · ${j.material} · ${j.printer} · for ${j.for} · ${j.status}${j.attempts > 1 ? ` ×${j.attempts}` : ""}
          ${j.status === "printing" ? html`<button type="button" class="cancel" ?disabled=${SUBMIT_GUARD && s.working.includes(j.id)} @click=${() => void jobAction(j, "cancel")}>Cancel</button>` : nothing}
          ${j.status === "failed" ? html`<button type="button" class="reprint" ?disabled=${SUBMIT_GUARD && s.working.includes(j.id)} @click=${() => void jobAction(j, "reprint")}>Reprint</button>` : nothing}</li>`,
      )}</ul>
      ${s.more ? html`<button type="button" class="older" ?disabled=${s.loadingJobs} @click=${() => void loadJobs(true)}>${s.loadingJobs ? "Loading…" : "Older jobs"}</button>` : nothing}`;
  }
}
customElements.define("job-queue", JobQueue);

class PrintFarm extends LitElement {
  private f = new AtomController(this, farm);
  static styles = css`
    :host { display: block; font: 14px system-ui, sans-serif; max-width: 760px; }
    li.printer.error { color: #a33; }
  `;
  render() {
    const s = this.f.value;
    return html`<h1>Print farm</h1>
      <p class="status">${s.idle} of ${s.printers.length} printers idle · ${s.live ? "live" : "reconnecting…"}</p>
      ${s.notice ? html`<p class="notice">${s.notice}</p>` : nothing}
      <form class="new-job" @submit=${(e: Event) => e.preventDefault()}>
        <label>File <select name="file" @change=${(e: Event) => farm.update((x) => ({ ...x, file: (e.target as HTMLSelectElement).value }))}>${FILES.map((f) => html`<option ?selected=${f === s.file}>${f}</option>`)}</select></label>
        <label>Material <select name="material" @change=${(e: Event) => farm.update((x) => ({ ...x, material: (e.target as HTMLSelectElement).value }))}>${MATERIALS.map((m) => html`<option ?selected=${m === s.material}>${m}</option>`)}</select></label>
      </form>
      <ul class="printers">${s.printers.map(
        (p) => html`<li class="printer ${p.status}">${p.name} · ${p.model} · ${p.status === "busy" ? html`printing ${p.file || "a job"} · ${Math.min(100, p.progress)}%` : p.status === "error" ? `error: ${p.note ?? "needs attention"}` : "idle"}
          ${p.status === "idle" ? html`<button type="button" class="send" ?disabled=${SUBMIT_GUARD && s.sending.includes(p.id)} @click=${() => void send(p)}>${s.sending.includes(p.id) ? "Sending…" : "Send job"}</button>` : nothing}</li>`,
      )}</ul>
      <job-queue></job-queue>`;
  }
}
customElements.define("print-farm", PrintFarm);

document.getElementById("app")!.appendChild(document.createElement("print-farm"));
let everUp = false;
liveTopic(
  "printers",
  (m) => {
    if (m.item && (m.type === "updated" || m.type === "created")) applyPrinter(m.item as Printer);
  },
  (up) => {
    farm.update((s) => ({ ...s, live: up }));
    if (up && everUp && RECONNECT === "resync") void loadPrinters();
    if (up) everUp = true;
  },
);
void loadPrinters();
void loadJobs(false);
