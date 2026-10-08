// Shared quarterly budget sheet (plain TypeScript DOM code + fetch, state in one runtime atom). A small grid with
// formulas; every committed cell is autosaved on its own (PATCH /cells/:id) and the sheet syncs other people's edits
// by polling. Latent bugs by flag: every commit fires its own save so two saves of the same cell overlap
// (saveMode=fire), save echoes applied even when a newer edit of that cell exists (echo=apply: the server's echo of an
// older value overwrites the newer one, and the newer save can lose at the server too), a recompute after an edit that
// only updates the cells that reference the edited cell directly (recompute=direct-only: totals of totals go stale),
// and a sync that overwrites cells with unsaved or in-flight local edits (pollMerge=overwrite).
import { rt, flag } from "../_shared/genclass";
import { COLS, IDS, ROWS, computeAll, evaluate, literal, refsIn, type Val } from "./formula";

type Cell = { raw: string; v: Val };
type Sheet = { cells: Record<string, Cell>; sel: string; draft: string; pending: number; error: string };

const SAVE_MODE = flag("saveMode", "serial") as "serial" | "fire";
const ECHO = flag("echo", "if-latest") as "if-latest" | "apply";
const RECOMPUTE = flag("recompute", "full") as "full" | "direct-only";
const POLL_MERGE = flag("pollMerge", "skip-pending") as "skip-pending" | "overwrite";
const POLL_MS = Number(flag("pollMs", 4000));

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const show = (v: Val) => (typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 })) : v);

const sheet = rt.atom<Sheet>("sheet", { cells: {}, sel: "B1", draft: "", pending: 0, error: "" });

// ------------------------------------------------------------------------------------------- recompute
function full(cells: Record<string, Cell>): Record<string, Cell> {
  const raws: Record<string, string> = {};
  for (const id of IDS) raws[id] = cells[id]?.raw ?? "";
  const vals = computeAll(raws);
  const out: Record<string, Cell> = {};
  for (const id of IDS) out[id] = { raw: raws[id]!, v: vals[id]! };
  return out;
}

/** After an edit of `id`: the whole sheet, or (direct-only) the cell and the formulas that name it. */
function recompute(cells: Record<string, Cell>, id: string): Record<string, Cell> {
  if (RECOMPUTE === "full") return full(cells);
  const out = { ...cells };
  const get = (x: string) => out[x]?.v ?? "";
  const own = out[id]!.raw;
  out[id] = { raw: own, v: own.startsWith("=") ? evaluate(own, get) : literal(own) };
  for (const other of IDS) {
    const raw = out[other]?.raw ?? "";
    if (other !== id && refsIn(raw).includes(id)) out[other] = { raw, v: evaluate(raw, get) };
  }
  return out;
}

const withRaw = (s: Sheet, id: string, raw: string): Sheet => ({ ...s, cells: recompute({ ...s.cells, [id]: { raw, v: s.cells[id]?.v ?? "" } }, id) });

// ----------------------------------------------------------------------------------------------- saves
let editSeq = 0;
const lastEdit: Record<string, number> = {}; // newest local edit per cell
const inflight: Record<string, number> = {};
const queued: Record<string, { raw: string; seq: number }> = {};
const undo: { id: string; raw: string }[] = [];

function commit(id: string, raw: string, record = true) {
  const cur = sheet.get().cells[id];
  if (cur && cur.raw === raw) return;
  if (record) undo.push({ id, raw: cur?.raw ?? "" });
  const seq = ++editSeq;
  lastEdit[id] = seq;
  sheet.update((s) => ({ ...withRaw(s, id, raw), error: "" }));
  if (SAVE_MODE === "serial" && inflight[id]) queued[id] = { raw, seq };
  else void send(id, raw, seq);
}

async function send(id: string, raw: string, seq: number) {
  inflight[id] = (inflight[id] ?? 0) + 1;
  sheet.update((s) => ({ ...s, pending: s.pending + 1 }));
  try {
    const r = await fetch(`/api/cells/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw }) });
    if (!r.ok) throw new Error(String(r.status));
    const saved = (await r.json()) as { id: string; raw: string };
    if (ECHO === "apply" || lastEdit[id] === seq) sheet.update((s) => withRaw(s, id, saved.raw));
  } catch {
    sheet.update((s) => ({ ...s, error: `${id} could not be saved. It will be retried with your next change or sync.` }));
    if (lastEdit[id] === seq && !queued[id]) setTimeout(() => lastEdit[id] === seq && !inflight[id] && void send(id, sheet.get().cells[id]?.raw ?? raw, seq), 2500);
  } finally {
    inflight[id] = Math.max(0, (inflight[id] ?? 1) - 1);
    sheet.update((s) => ({ ...s, pending: Math.max(0, s.pending - 1) }));
    const next = queued[id];
    if (next && !inflight[id]) {
      delete queued[id];
      void send(id, next.raw, next.seq);
    }
  }
}

// ------------------------------------------------------------------------------------------------ sync
let syncing = false;
async function sync() {
  if (syncing) return;
  syncing = true;
  const startedAt = editSeq;
  try {
    const r = await fetch(`/api/cells?limit=100`);
    if (!r.ok) throw new Error(String(r.status));
    const rows = (await r.json()) as { id: string; raw: string }[];
    sheet.update((s) => {
      const cells = { ...s.cells };
      for (const row of rows) {
        const busy = inflight[row.id] || queued[row.id] || (lastEdit[row.id] ?? 0) > startedAt;
        if (POLL_MERGE === "skip-pending" && busy) continue;
        cells[row.id] = { raw: String(row.raw ?? ""), v: cells[row.id]?.v ?? "" };
      }
      return { ...s, cells: full(cells) };
    });
  } catch {
    /* next tick */
  } finally {
    syncing = false;
  }
}

// ---------------------------------------------------------------------------------------------- render
const root = document.getElementById("app")!;
root.innerHTML = `
  <header><h1>FY26 Q1 budget — Operations</h1><p class="share">Shared with finance · autosaves</p></header>
  <form class="bar"><label class="name">B1</label> <input name="formula" class="formula" autocomplete="off" aria-label="Cell contents">
    <button type="button" class="recalc">Recalculate</button> <button type="button" class="sync">Sync</button> <button type="button" class="undo">Undo</button> <span class="status"></span></form>
  <div class="sheet-error"></div>
  <table class="grid"><thead><tr><th></th>${COLS.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${Array.from({ length: ROWS }, (_, r) => `<tr><th>${r + 1}</th>${COLS.map((c) => `<td class="cell" data-id="${c}${r + 1}"></td>`).join("")}</tr>`).join("")}</tbody></table>`;
const input = root.querySelector<HTMLInputElement>("input.formula")!;

function render() {
  const s = sheet.get();
  for (const td of root.querySelectorAll<HTMLElement>("td.cell")) {
    const c = s.cells[td.dataset.id!];
    const text = c ? String(show(c.v)) : "";
    if (td.textContent !== text) td.textContent = text;
    td.classList.toggle("selected", td.dataset.id === s.sel);
    td.classList.toggle("num", typeof c?.v === "number" && !c.raw.startsWith("="));
    td.classList.toggle("formula", !!c?.raw.startsWith("="));
  }
  root.querySelector(".name")!.textContent = s.sel;
  root.querySelector(".status")!.textContent = s.pending ? "Saving…" : "All changes saved";
  root.querySelector(".sheet-error")!.innerHTML = s.error ? `<p role="alert">${esc(s.error)}</p>` : "";
}
sheet.subscribe(render);

root.querySelector("tbody")!.addEventListener("click", (e) => {
  const td = (e.target as Element).closest<HTMLElement>("td.cell");
  if (!td) return;
  const id = td.dataset.id!;
  const raw = sheet.get().cells[id]?.raw ?? "";
  input.value = raw;
  sheet.update((s) => ({ ...s, sel: id, draft: raw }));
});
input.addEventListener("input", () => sheet.update((s) => ({ ...s, draft: input.value })));
input.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  input.value = sheet.get().cells[sheet.get().sel]?.raw ?? "";
  sheet.update((s) => ({ ...s, draft: input.value }));
});
root.querySelector("form.bar")!.addEventListener("submit", (e) => {
  e.preventDefault();
  const s = sheet.get();
  commit(s.sel, s.draft.trim());
});
root.querySelector(".recalc")!.addEventListener("click", () => sheet.update((s) => ({ ...s, cells: full(s.cells) })));
root.querySelector(".sync")!.addEventListener("click", () => void sync());
root.querySelector(".undo")!.addEventListener("click", () => {
  const last = undo.pop();
  if (!last) return;
  commit(last.id, last.raw, false);
  if (sheet.get().sel === last.id) input.value = last.raw;
});

async function boot() {
  try {
    const r = await fetch(`/api/cells?limit=100`);
    if (!r.ok) throw new Error(String(r.status));
    const rows = (await r.json()) as { id: string; raw: string }[];
    const cells: Record<string, Cell> = {};
    for (const row of rows) cells[row.id] = { raw: String(row.raw ?? ""), v: "" };
    sheet.update((s) => ({ ...s, cells: full(cells), draft: cells[s.sel]?.raw ?? "" }));
    input.value = sheet.get().draft;
  } catch {
    sheet.update((s) => ({ ...s, error: "The sheet could not be opened. Retrying…" }));
    setTimeout(() => void boot(), 2000);
    return;
  }
  setInterval(() => void sync(), POLL_MS);
}
render();
void boot();
