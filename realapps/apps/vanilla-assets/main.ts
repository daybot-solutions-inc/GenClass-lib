// IT asset register (vanilla TS + axios with AbortController; state in a runtime atom, rendered with template
// strings). The service desk filters/searches a paged table, assigns available assets to a person (versioned PATCH)
// and takes them back; the helpdesk assigns assets too. Latent bugs by flag: page/filter loads not aborted
// (pageSeq=none: an older page lands last), assign buttons live while posting (assignGuard=none), assignments sent
// without the version (assign=force: an asset the helpdesk just gave out is re-assigned) and an "available" count
// adjusted by hand (availCount=manual).
import axios from "axios";
import { rt, flag } from "../_shared/genclass";

type Asset = { id: number; tag: string; kind: string; model: string; holder: string; status: string; version: number };
const PAGE_SEQ = flag("pageSeq", "abort");
const ASSIGN_GUARD = flag("assignGuard", "pending") === "pending";
const ASSIGN = flag("assign", "if-match");
const AVAIL = flag("availCount", "derive");

const st = rt.atom("assets", { kind: "", q: "", page: 1, pages: 1, rows: [] as Asset[], available: 0, assignee: "ana", busy: [] as number[], loading: true, error: "", notice: "" });
type S = ReturnType<typeof st.get>;
const availOf = (rs: Asset[]) => rs.filter((r) => r.status === "available").length;
const errOf = (e: any, what: string) => (e?.response ? (e.response.status === 409 ? `Someone else changed this asset — ${what} was not saved.` : `${what} failed (${e.response.status}).`) : `Network problem — ${what} did not go through.`);
const http = axios.create({ baseURL: "/api" });

let ctl: AbortController | null = null;
async function load(patch: Partial<S> = {}) {
  if (PAGE_SEQ === "abort") ctl?.abort();
  const mine = (ctl = new AbortController());
  st.update((s) => ({ ...s, ...patch, loading: true, error: "" }));
  const { kind, q, page } = st.get();
  try {
    const r = await http.get(`/assets`, { params: { page, limit: 8, ...(kind ? { kind } : {}), ...(q.trim() ? { q: q.trim() } : {}) }, signal: mine.signal });
    const rows = (r.data.items ?? []) as Asset[];
    st.update((s) => ({ ...s, rows, available: availOf(rows), pages: Math.max(1, Math.ceil(Number(r.data.total ?? rows.length) / 8)), loading: false }));
  } catch (e) {
    if (axios.isCancel(e)) return;
    st.update((s) => ({ ...s, loading: false, error: errOf(e, "loading assets") }));
  }
}

const busy = (id: number, on: boolean) => st.update((s) => ({ ...s, busy: on ? [...s.busy, id] : s.busy.filter((x) => x !== id) }));
function replace(s: S, a: Asset, delta: number): S {
  const rows = s.rows.map((r) => (r.id === a.id ? a : r));
  return { ...s, rows, available: AVAIL === "derive" ? availOf(rows) : s.available + delta };
}
async function assign(a: Asset) {
  const s0 = st.get();
  if (ASSIGN_GUARD && s0.busy.includes(a.id)) return;
  busy(a.id, true);
  try {
    const body: Record<string, unknown> = { holder: s0.assignee, status: "assigned" };
    if (ASSIGN === "if-match") body.version = a.version;
    const { data } = await http.patch(`/assets/${a.id}`, body);
    st.update((s) => ({ ...replace(s, data, -1), notice: `${data.tag} assigned to ${data.holder}.`, error: "" }));
  } catch (e: any) {
    const cur = e?.response?.status === 409 ? (e.response.data?.current as Asset | undefined) : undefined;
    st.update((s) => ({ ...(cur ? replace(s, cur, 0) : s), error: errOf(e, `assigning ${a.tag}`) }));
  } finally {
    busy(a.id, false);
  }
}
async function giveBack(a: Asset) {
  if (st.get().busy.includes(a.id)) return;
  busy(a.id, true);
  try {
    const { data } = await http.patch(`/assets/${a.id}`, { holder: "", status: "available", version: a.version });
    st.update((s) => ({ ...replace(s, data, 1), notice: `${data.tag} is back in stock.`, error: "" }));
  } catch (e: any) {
    st.update((s) => ({ ...s, error: errOf(e, `returning ${a.tag}`) }));
  } finally {
    busy(a.id, false);
  }
}

const root = document.getElementById("app")!;
root.innerHTML = `<h1>IT asset register</h1>
  <div class="filters"><label>Type <select name="kind"><option value="">All</option><option value="laptop">Laptops</option><option value="monitor">Monitors</option><option value="phone">Phones</option><option value="dock">Docks</option></select></label>
  <input name="q" placeholder="Tag, model or person"> <label>Assign to <select name="assignee">${["ana", "raj", "li", "max", "sam"].map((p) => `<option>${p}</option>`).join("")}</select></label></div>
  <p class="status"></p><div class="msg"></div><table class="assets"><tbody></tbody></table>
  <nav class="pager"><button type="button" class="prev">Prev</button> <span class="pageno"></span> <button type="button" class="next">Next</button></nav>`;
const q = <T extends Element>(sel: string) => root.querySelector(sel) as T;
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

st.subscribe((s) => {
  q(".status").textContent = s.loading ? "Loading…" : `${s.available} available on this page`;
  q(".msg").innerHTML = s.error ? `<p role="alert">${esc(s.error)}</p>` : s.notice ? `<p class="notice">${esc(s.notice)}</p>` : "";
  q("tbody").innerHTML = s.rows
    .map((r) => {
      const dis = ASSIGN_GUARD && s.busy.includes(r.id) ? " disabled" : "";
      const btn = r.status === "available" ? `<button type="button" class="assign"${dis}>Assign</button>` : r.status === "assigned" ? `<button type="button" class="return"${s.busy.includes(r.id) ? " disabled" : ""}>Return</button>` : "";
      return `<tr class="asset ${r.status}" data-id="${r.id}"><td>${esc(r.tag)}</td><td>${esc(r.model)}</td><td>${r.status}</td><td>${esc(r.holder || "—")}</td><td>${btn}</td></tr>`;
    })
    .join("") || `<tr><td>No assets match.</td></tr>`;
  q(".pageno").textContent = `Page ${s.page} of ${s.pages}`;
});

let debounce: ReturnType<typeof setTimeout> | undefined;
root.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.name !== "q") return;
  st.update((s) => ({ ...s, q: t.value }));
  clearTimeout(debounce);
  debounce = setTimeout(() => void load({ page: 1 }), 300);
});
root.addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.name === "kind") void load({ kind: t.value, page: 1 });
  if (t.name === "assignee") st.update((s) => ({ ...s, assignee: t.value }));
});
root.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  const s = st.get();
  if (b.classList.contains("prev") && s.page > 1) return void load({ page: s.page - 1 });
  if (b.classList.contains("next") && s.page < s.pages) return void load({ page: s.page + 1 });
  const row = s.rows.find((r) => r.id === Number(b.closest("tr")?.getAttribute("data-id")));
  if (!row) return;
  if (b.classList.contains("assign")) void assign(row);
  if (b.classList.contains("return")) void giveBack(row);
});
void load();
