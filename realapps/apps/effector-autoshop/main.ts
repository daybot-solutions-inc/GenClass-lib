// Service advisor board of a repair shop (effector stores/events/effects with a template-string DOM; fetch). Job cards
// show the car, the concern, a status and the technician (both versioned PATCHes: technicians update their jobs from the
// bay tablets and the second advisor assigns work too). Parts are added to a job in two steps (POST /jobparts, then
// POST /parts/:id/reserve, which takes one from stock); a low-stock panel lists parts under three
// (/api/parts?stock__lt=3) and deliveries restock them. The board refreshes in the background. Stores are registered
// with rt.guard (w4-effector guardStore): async results go through the guarded writes, UI events update the stores
// directly. Latent bugs by flag: technician changes sent without the version (assign=force: the other advisor's
// assignment is overwritten), a part line left on the job when the reservation fails (partSteps=dangling: the card
// lists a part that was never taken from stock), the low-stock panel not refreshed after a reservation
// (lowStock=stale: it still says "2 left" while the picker says 1, and a part that just ran low is missing), board
// loads applied in arrival order (boardSeq=blind: the "Ready" view shows open jobs) and an Add button live while the
// part is being added (partGuard=none: a double click puts the part on the job twice and reserves two).
import { createEffect, createEvent, createStore, sample } from "effector";
import { flag } from "../_shared/genclass";
import { guardStore } from "../_shared/w4-effector";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Status = "waiting" | "in-progress" | "waiting-parts" | "ready";
type Show = "open" | "ready" | "all";
type Job = { id: number; ro: string; vehicle: string; customer: string; concern: string; status: Status; tech: string; version: number };
type Part = { id: number; sku: string; name: string; stock: number };
type Line = { id: number; jobId: number; partId: number; name: string };
type Board = { show: Show; jobs: Job[]; lines: Line[]; counts: Record<string, number>; loading: boolean; pending: number[]; error: string; notice: string };
type Stock = { parts: Part[]; low: Part[]; picked: Record<number, number>; adding: number[] };
const ASSIGN = flag("assign", "if-match");
const PART_STEPS = flag("partSteps", "rollback");
const LOW_STOCK = flag("lowStock", "refetch-after-reserve");
const BOARD_SEQ = flag("boardSeq", "latest");
const PART_GUARD = flag("partGuard", "pending") === "pending";
const STATUSES: Status[] = ["waiting", "in-progress", "waiting-parts", "ready"];
const LABEL: Record<Status, string> = { waiting: "Waiting", "in-progress": "In progress", "waiting-parts": "Waiting on parts", ready: "Ready for pickup" };
const TECHS = ["Marco", "Priya", "Dale", "Keisha"];
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const countOf = (jobs: Job[]) => Object.fromEntries(STATUSES.map((s) => [s, jobs.filter((j) => j.status === s).length]));
const withJobs = (b: Board, jobs: Job[]): Board => ({ ...b, jobs, counts: countOf(jobs) });
const swap = (jobs: Job[], j: Job) => jobs.map((x) => (x.id === j.id ? j : x));

// ------------------------------------------------------------------------------------------ stores
const $board = createStore<Board>({ show: "open", jobs: [], lines: [], counts: countOf([]), loading: true, pending: [], error: "", notice: "" });
const $stock = createStore<Stock>({ parts: [], low: [], picked: {}, adding: [] });
const writeBoard = guardStore("board", $board);
const writeStock = guardStore("stock", $stock);

const showPicked = createEvent<Show>();
const statusEdited = createEvent<{ job: Job; status: Status }>();
const techEdited = createEvent<{ job: Job; tech: string }>();
const partPicked = createEvent<{ jobId: number; partId: number }>();
$board.on(showPicked, (b, show) => ({ ...b, show, loading: true, error: "", notice: "" }));
$board.on(statusEdited, (b, { job, status }) => ({ ...withJobs(b, swap(b.jobs, { ...job, status })), pending: [...b.pending, job.id], error: "", notice: "" }));
$board.on(techEdited, (b, { job, tech }) => ({ ...withJobs(b, swap(b.jobs, { ...job, tech })), pending: [...b.pending, job.id], error: "", notice: "" }));
$stock.on(partPicked, (s, { jobId, partId }) => ({ ...s, picked: { ...s.picked, [jobId]: partId } }));

// ------------------------------------------------------------------------------------------ board
let seq = 0;
const filterOf = (show: Show) => (show === "open" ? "&status__in=waiting,in-progress,waiting-parts" : show === "ready" ? "&status=ready" : "");
const loadBoardFx = createEffect(async ({ show, background }: { show: Show; background: boolean }) => {
  const my = background ? seq : ++seq;
  const [jb, lb] = await Promise.all([api(`/api/jobs?limit=50${filterOf(show)}`), api(`/api/jobparts?limit=100`)]);
  return { my, show, background, jobs: itemsOf<Job>(jb), lines: itemsOf<Line>(lb) };
});
loadBoardFx.doneData.watch(({ my, show, background, jobs, lines }) =>
  writeBoard((b) => {
    if ((background || BOARD_SEQ === "latest") && (my !== seq || b.show !== show)) return b;
    const local = new Map(b.jobs.map((j) => [j.id, j]));
    const adding = $stock.getState().adding;
    const kept = b.lines.filter((l) => adding.includes(l.jobId) && !lines.some((x) => x.id === l.id));
    return { ...withJobs(b, jobs.map((j) => (b.pending.includes(j.id) ? (local.get(j.id) ?? j) : j))), lines: [...lines, ...kept], loading: false };
  }),
);
loadBoardFx.fail.watch(({ params, error }) => !params.background && writeBoard((b) => (b.show !== params.show ? b : { ...b, loading: false, error: errText(error, "loading the board") })));
sample({ clock: showPicked, fn: (show) => ({ show, background: false }), target: loadBoardFx });

// ------------------------------------------------------------------------------------------ status / technician
const patchJob = (job: Job, patch: Partial<Job>, ifMatch: boolean) => api<Job>(`/api/jobs/${job.id}`, "PATCH", ifMatch ? { ...patch, version: job.version } : patch);
const statusFx = createEffect(({ job, status }: { job: Job; status: Status }) => patchJob(job, { status }, true));
const techFx = createEffect(({ job, tech }: { job: Job; tech: string }) => patchJob(job, { tech }, ASSIGN === "if-match"));
sample({ clock: statusEdited, target: statusFx });
sample({ clock: techEdited, target: techFx });
for (const fx of [statusFx, techFx] as const) {
  (fx.done as typeof statusFx.done).watch(({ result }) => writeBoard((b) => ({ ...withJobs(b, swap(b.jobs, result)), notice: `${result.ro}: ${LABEL[result.status]}${result.tech ? ` · ${result.tech}` : ""}.` })));
  (fx.fail as typeof statusFx.fail).watch(({ params, error }) => {
    const cur = error instanceof HttpError && error.status === 409 ? (error.body?.current as Job | undefined) : undefined;
    writeBoard((b) => ({ ...withJobs(b, swap(b.jobs, cur ?? params.job)), error: cur ? `${params.job.ro} was just changed by someone else (${LABEL[cur.status]}${cur.tech ? `, ${cur.tech}` : ""}).` : errText(error, `saving ${params.job.ro}`) }));
  });
  (fx.finally as typeof statusFx.finally).watch(({ params }) => writeBoard((b) => ({ ...b, pending: b.pending.filter((x) => x !== params.job.id) })));
}

// ------------------------------------------------------------------------------------------ parts
let lowSeq = 0;
const lowFx = createEffect(async () => ({ my: ++lowSeq, low: itemsOf<Part>(await api(`/api/parts?stock__lt=3&sort=stock&limit=50`)) }));
lowFx.doneData.watch(({ my, low }) => writeStock((s) => (my !== lowSeq ? s : { ...s, low, parts: s.parts.map((p) => low.find((l) => l.id === p.id) ?? p) })));
const catalogFx = createEffect(async () => {
  const my = ++lowSeq;
  const [pb, lb] = await Promise.all([api(`/api/parts?limit=50`), api(`/api/parts?stock__lt=3&sort=stock&limit=50`)]);
  return { my, parts: itemsOf<Part>(pb), low: itemsOf<Part>(lb) };
});
catalogFx.doneData.watch(({ my, parts, low }) => writeStock((s) => (my !== lowSeq ? s : { ...s, parts, low: low.map((l) => parts.find((p) => p.id === l.id) ?? l) })));

class StepError extends Error {
  constructor(readonly step: "line" | "reserve", readonly cause: unknown) {
    super(step);
  }
}
const addPartFx = createEffect(async ({ job, part }: { job: Job; part: Part }) => {
  let line: Line;
  try {
    line = await api<Line>(`/api/jobparts`, "POST", { jobId: job.id, partId: part.id, name: part.name });
  } catch (e) {
    throw new StepError("line", e);
  }
  writeBoard((b) => ({ ...b, lines: [...b.lines.filter((l) => l.id !== line.id), line] }));
  try {
    return { line, part: await api<Part>(`/api/parts/${part.id}/reserve`, "POST") };
  } catch (e) {
    if (PART_STEPS === "rollback") {
      await api(`/api/jobparts/${line.id}`, "DELETE").catch(() => undefined);
      writeBoard((b) => ({ ...b, lines: b.lines.filter((l) => l.id !== line.id) }));
    }
    throw new StepError("reserve", e);
  }
});
addPartFx.watch(({ job }) => writeStock((s) => ({ ...s, adding: [...s.adding, job.id] })));
addPartFx.done.watch(({ params, result }) => {
  writeStock((s) => {
    const picked = { ...s.picked };
    delete picked[params.job.id];
    return { ...s, picked, parts: s.parts.map((p) => (p.id === result.part.id ? result.part : p)), low: LOW_STOCK === "stale" ? s.low : s.low.map((l) => (l.id === result.part.id ? result.part : l)) };
  });
  writeBoard((b) => ({ ...b, notice: `${result.part.name} reserved for ${params.job.ro} (${result.part.stock} left).` }));
  if (LOW_STOCK === "refetch-after-reserve") void lowFx();
});
addPartFx.fail.watch(({ params, error }) => {
  const e = error instanceof StepError ? error : new StepError("line", error);
  const what = `${params.part.name} for ${params.job.ro}`;
  writeBoard((b) => ({ ...b, error: e.step === "line" ? errText(e.cause, `adding ${what}`) : PART_STEPS === "rollback" ? `${params.part.name} couldn't be reserved — removed from ${params.job.ro}.` : errText(e.cause, `reserving ${what}`) }));
});
addPartFx.finally.watch(({ params }) => writeStock((s) => ({ ...s, adding: s.adding.filter((x) => x !== params.job.id) })));

// ------------------------------------------------------------------------------------------ DOM
const root = document.getElementById("app")!;
root.innerHTML = `<main class="shop"><header><h1>Service board · Bayview Auto</h1><p class="counts"></p>
  <label>Show <select name="show"><option value="open">Open jobs</option><option value="ready">Ready for pickup</option><option value="all">All jobs</option></select></label></header>
  <div class="msg"></div><section class="board"></section>
  <aside class="low"><h2>Low stock</h2><ul></ul></aside></main>`;
const $ = <T extends Element>(s: string) => root.querySelector(s) as T;
function render() {
  const b = $board.getState();
  const s = $stock.getState();
  $("p.counts").textContent = b.loading ? "Loading…" : STATUSES.map((st) => `${b.counts[st] ?? 0} ${LABEL[st].toLowerCase()}`).join(" · ");
  $<HTMLSelectElement>("select[name=show]").value = b.show;
  $("div.msg").innerHTML = b.error ? `<p role="alert">${esc(b.error)}</p>` : b.notice ? `<p class="notice">${esc(b.notice)}</p>` : "";
  $("section.board").innerHTML = b.jobs
    .map((j) => {
      const busy = b.pending.includes(j.id);
      const lines = b.lines.filter((l) => l.jobId === j.id);
      const picked = s.picked[j.id];
      const adding = s.adding.includes(j.id);
      return `<article class="job ${j.status}" data-id="${j.id}"><h3>${esc(j.ro)} · ${esc(j.vehicle)} · ${esc(j.customer)}</h3><p>${esc(j.concern)}</p>
        <select class="status"${busy ? " disabled" : ""}>${STATUSES.map((st) => `<option value="${st}"${st === j.status ? " selected" : ""}>${LABEL[st]}</option>`).join("")}</select>
        <select class="tech"${busy ? " disabled" : ""}><option value="">Unassigned</option>${TECHS.map((t) => `<option${t === j.tech ? " selected" : ""}>${t}</option>`).join("")}</select>
        <p class="parts">${lines.length ? `Parts: ${lines.map((l) => esc(l.name)).join(", ")}` : "No parts yet"}</p>
        <select class="part"${PART_GUARD && adding ? " disabled" : ""}><option value="">Add part…</option>${s.parts.map((p) => `<option value="${p.id}"${p.id === picked ? " selected" : ""}${p.stock <= 0 ? " disabled" : ""}>${esc(p.name)} · ${p.stock} in stock</option>`).join("")}</select>
        <button type="button" class="add-part"${!picked || (PART_GUARD && adding) ? " disabled" : ""}>${adding ? "Adding…" : "Add"}</button></article>`;
    })
    .join("");
  $("aside.low ul").innerHTML = s.low.map((p) => `<li class="low-part">${esc(p.name)} (${esc(p.sku)}) · ${p.stock} left</li>`).join("") || `<li class="ok">Nothing running low.</li>`;
}
$board.watch(render);
$stock.watch(render);

const jobOf = (el: Element) => $board.getState().jobs.find((j) => j.id === Number(el.closest<HTMLElement>("article.job")?.dataset.id));
root.addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.matches("select[name=show]")) return void showPicked(t.value as Show);
  const job = jobOf(t);
  if (!job) return;
  if (t.matches("select.status") && t.value !== job.status) statusEdited({ job, status: t.value as Status });
  else if (t.matches("select.tech") && t.value !== job.tech) techEdited({ job, tech: t.value });
  else if (t.matches("select.part") && t.value) partPicked({ jobId: job.id, partId: Number(t.value) });
});
root.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (!t.matches("button.add-part")) return;
  const job = jobOf(t);
  const s = $stock.getState();
  const part = s.parts.find((p) => p.id === s.picked[job?.id ?? -1]);
  if (!job || !part || (PART_GUARD && s.adding.includes(job.id))) return;
  if (part.stock <= 0) return void writeBoard((b) => ({ ...b, error: `${part.name} is out of stock.` }));
  void addPartFx({ job, part });
});

showPicked("open");
void catalogFx();
setInterval(() => {
  const b = $board.getState();
  if (!b.loading) void loadBoardFx({ show: b.show, background: true });
}, 6000);
setInterval(() => void catalogFx(), 15000);
