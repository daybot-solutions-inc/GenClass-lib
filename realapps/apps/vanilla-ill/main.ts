// Interlibrary loan desk (vanilla TS + ky; state in a runtime atom, rendered with template strings). A patron
// searches the partner union catalogue as they type, requests a title (ISBN is unique per patron server-side),
// watches request status (polled: requested → shipped → arrived) and can cancel (versioned PATCH). Latent bugs by
// flag: search results applied in arrival order (searchSeq=blind), Request buttons live while posting
// (requestGuard=none: the duplicate answers 409), polls that overwrite a request being cancelled
// (statusPoll=blind), cancels sent without the version (cancel=force: cancels a book already on its way) and an
// active-request counter adjusted by hand (activeCount=manual).
import ky, { HTTPError } from "ky";
import { rt, flag } from "../_shared/genclass";

type Hit = { id: number; title: string; author: string; isbn: string; holder: string };
type Req = { id: number; isbn: string; title: string; status: string; holder: string; version: number };
const SEARCH_SEQ = flag("searchSeq", "latest");
const REQUEST_GUARD = flag("requestGuard", "disable") === "disable";
const STATUS_POLL = flag("statusPoll", "keep-pending");
const CANCEL = flag("cancel", "if-match");
const ACTIVE = flag("activeCount", "derive");

const ill = rt.atom("ill", { q: "", shownQ: "", hits: [] as Hit[], requests: [] as Req[], active: 0, busy: [] as string[], searching: false, error: "", notice: "" });
type S = ReturnType<typeof ill.get>;
const http = ky.create({ prefixUrl: "/api", timeout: 10000 });
const activeOf = (rs: Req[]) => rs.filter((r) => r.status !== "cancelled" && r.status !== "arrived").length;
const isActive = (r?: Req) => !!r && r.status !== "cancelled" && r.status !== "arrived";
const status = (e: unknown) => (e instanceof HTTPError ? e.response.status : 0);
const fail = (e: unknown, what: string) => (status(e) ? `${what} failed (${status(e)}).` : `The union catalogue is unreachable — ${what} did not go through.`);
function putReq(s: S, r: Req): S {
  const cur = s.requests.find((x) => x.id === r.id);
  const requests = cur ? s.requests.map((x) => (x.id === r.id ? r : x)) : [...s.requests, r];
  return { ...s, requests, active: ACTIVE === "derive" ? activeOf(requests) : s.active + (isActive(r) ? 1 : 0) - (isActive(cur) ? 1 : 0) };
}
const busy = (k: string, on: boolean) => ill.update((s) => ({ ...s, busy: on ? [...s.busy, k] : s.busy.filter((x) => x !== k) }));

let seq = 0;
async function search(q: string) {
  const my = ++seq;
  if (!q) return ill.update((s) => ({ ...s, hits: [], shownQ: "", searching: false }));
  ill.update((s) => ({ ...s, searching: true }));
  try {
    const body = await http.get("catalog", { searchParams: { q, limit: 8 } }).json<{ results: Hit[] }>();
    if (SEARCH_SEQ === "latest" && my !== seq) return;
    ill.update((s) => ({ ...s, hits: body.results ?? [], shownQ: q, searching: my === seq ? false : s.searching }));
  } catch (e) {
    if (my === seq) ill.update((s) => ({ ...s, searching: false, error: fail(e, "the search") }));
  }
}

async function request(h: Hit) {
  if (REQUEST_GUARD && ill.get().busy.includes(h.isbn)) return;
  if (ill.get().requests.some((r) => r.isbn === h.isbn && r.status !== "cancelled")) return ill.update((s) => ({ ...s, notice: `You already requested “${h.title}”.` }));
  busy(h.isbn, true);
  ill.update((s) => ({ ...s, error: "", notice: "" }));
  try {
    const r = await http.post("requests", { json: { isbn: h.isbn, title: h.title, holder: h.holder, status: "requested" } }).json<Req>();
    ill.update((s) => ({ ...putReq(s, r), notice: `Requested “${r.title}” from ${r.holder}.` }));
  } catch (e) {
    ill.update((s) => ({ ...s, error: status(e) === 409 ? `“${h.title}” is already on your request list.` : fail(e, "the request") }));
  } finally {
    busy(h.isbn, false);
  }
}

async function cancel(r: Req) {
  if (ill.get().busy.includes(r.isbn)) return;
  busy(r.isbn, true);
  try {
    const saved = await http.patch(`requests/${r.id}`, { json: CANCEL === "if-match" ? { status: "cancelled", version: r.version } : { status: "cancelled" } }).json<Req>();
    ill.update((s) => ({ ...putReq(s, saved), notice: `Cancelled “${saved.title}”.`, error: "" }));
  } catch (e) {
    const cur = status(e) === 409 && e instanceof HTTPError ? ((await e.response.json().catch(() => ({}))) as { current?: Req }).current : undefined;
    ill.update((s) => ({ ...(cur ? putReq(s, cur) : s), error: cur ? `“${r.title}” has already ${cur.status}; it can't be cancelled now.` : fail(e, "the cancellation") }));
  } finally {
    busy(r.isbn, false);
  }
}

async function poll(initial = false) {
  try {
    const body = await http.get("requests", { searchParams: { limit: 30 } }).json<{ results: Req[] }>();
    ill.update((s) => {
      const mine = new Map(s.requests.map((x) => [x.id, x]));
      const reqs = (body.results ?? []).map((r) => (STATUS_POLL === "keep-pending" && s.busy.includes(r.isbn) ? (mine.get(r.id) ?? r) : r));
      return { ...s, requests: reqs, active: ACTIVE === "derive" || initial ? activeOf(reqs) : s.active };
    });
  } catch (e) {
    if (initial) ill.update((s) => ({ ...s, error: fail(e, "loading your requests") }));
  }
}

const root = document.getElementById("app")!;
root.innerHTML = `<h1>Interlibrary loans</h1><p class="active"></p>
  <label>Search partner libraries <input name="q" autocomplete="off" placeholder="Title, author or ISBN"></label> <span class="searching muted"></span>
  <div class="msg"></div><ul class="hits"></ul><h2>My requests <button type="button" class="refresh">Refresh</button></h2><ul class="reqs"></ul>`;
const $ = (sel: string) => root.querySelector(sel) as HTMLElement;
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
ill.subscribe((s) => {
  $(".active").textContent = `${s.active} active request(s)`;
  $(".searching").textContent = s.searching ? "Searching…" : "";
  $(".msg").innerHTML = s.error ? `<p role="alert">${esc(s.error)}</p>` : s.notice ? `<p class="notice">${esc(s.notice)}</p>` : "";
  $(".hits").innerHTML = s.hits.map((h) => `<li class="hit" data-isbn="${h.isbn}">${esc(h.title)} — ${esc(h.author)} <small>${h.isbn} · ${esc(h.holder)}</small> <button type="button" class="request"${REQUEST_GUARD && s.busy.includes(h.isbn) ? " disabled" : ""}>Request</button></li>`).join("");
  $(".reqs").innerHTML = s.requests.map((r) => `<li class="req ${r.status}" data-id="${r.id}">${esc(r.title)} · ${esc(r.holder)} · ${r.status} ${r.status === "requested" || r.status === "shipped" ? `<button type="button" class="cancel"${s.busy.includes(r.isbn) ? " disabled" : ""}>Cancel</button>` : ""}</li>`).join("") || `<li class="muted">No requests yet.</li>`;
});

let debounce: ReturnType<typeof setTimeout> | undefined;
root.addEventListener("input", (e) => {
  const q = (e.target as HTMLInputElement).value;
  ill.update((s) => ({ ...s, q }));
  clearTimeout(debounce);
  debounce = setTimeout(() => void search(q.trim()), 250);
});
root.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  const s = ill.get();
  if (b.classList.contains("refresh")) return void poll();
  const hit = s.hits.find((h) => h.isbn === b.closest("li")?.getAttribute("data-isbn"));
  if (b.classList.contains("request") && hit) return void request(hit);
  const req = s.requests.find((r) => r.id === Number(b.closest("li")?.getAttribute("data-id")));
  if (b.classList.contains("cancel") && req) void cancel(req);
});
void poll(true);
setInterval(() => void poll(), 4000);
