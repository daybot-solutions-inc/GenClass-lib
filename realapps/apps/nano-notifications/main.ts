// Notification center (nanostores map + computed, vanilla DOM, fetch). The inbox map is registered with rt.guard: the
// user's clicks mutate the nanostore directly (traced), network results are written through the guarded handle. The
// list is polled every 5 s; "Mark all as read" is a bulk PATCH whose per-item results can partially fail. Latent bugs
// by flag: bulk results assumed to have all succeeded (bulkResult=assume-all: failed items show as read until the next
// poll flips them back), the unread badge kept as a running count (unread=incremental: drifts when another device
// reads or new items arrive), polls that replace items with read/unread changes still in flight (poll=replace), and
// "Mark all as read" not locked while it runs (bulkLock=false).
import { computed, map } from "nanostores";
import { rt, flag } from "../_shared/genclass";

type Note = { id: number; kind: "mention" | "review" | "deploy" | "billing" | "comment"; title: string; read: boolean; createdAt?: string };
type Inbox = { items: Note[]; unread: number; filter: string; loaded: boolean; busy: boolean; notice: string; error: string };

const BULK_RESULT = flag("bulkResult", "per-item") as "per-item" | "assume-all";
const UNREAD = flag("unread", "derive") as "derive" | "incremental";
const POLL = flag("poll", "keep-pending") as "keep-pending" | "replace";
const BULK_LOCK = Boolean(flag("bulkLock", true));
const KIND_LABEL: Record<string, string> = { mention: "Mention", review: "Review request", deploy: "Deploy", billing: "Billing", comment: "Comment" };

const $inbox = map<Inbox>({ items: [], unread: 0, filter: "all", loaded: false, busy: false, notice: "", error: "" });
const $visible = computed($inbox, (s) => (s.filter === "unread" ? s.items.filter((n) => !n.read) : s.filter === "all" ? s.items : s.items.filter((n) => n.kind === s.filter)));
const inbox = rt.guard<Inbox>("inbox", { get: () => $inbox.get(), set: (v) => $inbox.set(v), subscribe: (fn) => $inbox.listen(() => fn()) });

const countUnread = (items: Note[]) => items.filter((n) => !n.read).length;
const withItems = (s: Inbox, items: Note[], delta: number): Inbox => ({ ...s, items, unread: UNREAD === "derive" ? countUnread(items) : Math.max(0, s.unread + delta) });
const setRead = (items: Note[], ids: Set<number>, read: boolean) => items.map((n) => (ids.has(n.id) ? { ...n, read } : n));

/** Local read-state changes not yet confirmed by the server (id -> desired read). */
const pending = new Map<number, boolean>();
let writesSent = 0;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (r.status === 204 ? null : await r.json()) as T;
}

// --------------------------------------------------------------------------------------------- polling
async function poll() {
  const sent = writesSent;
  try {
    const body = await api<{ items: Note[] }>("/api/notifications?limit=30&sort=-createdAt");
    const server = Array.isArray(body.items) ? body.items : [];
    inbox.update((s) => {
      if (!s.loaded) return { ...s, items: server, unread: countUnread(server), loaded: true, error: "" };
      if (POLL === "keep-pending" && sent !== writesSent) return s; // a change was sent while this poll was out; wait for the next one
      const known = new Set(s.items.map((n) => n.id));
      const items = POLL === "keep-pending" ? server.map((n) => (pending.has(n.id) ? { ...n, read: pending.get(n.id)! } : n)) : server;
      const arrivals = items.filter((n) => !known.has(n.id) && !n.read).length;
      return withItems(s, items, arrivals);
    });
  } catch {
    inbox.update((s) => (s.loaded ? s : { ...s, error: "Notifications couldn't be loaded. Retrying…" }));
  }
}

// ------------------------------------------------------------------------------------------------ edits
async function toggleRead(id: number) {
  const note = $inbox.get().items.find((n) => n.id === id);
  if (!note) return;
  const read = !note.read;
  pending.set(id, read);
  writesSent++;
  const s0 = $inbox.get();
  $inbox.set({ ...withItems(s0, setRead(s0.items, new Set([id]), read), read ? -1 : 1), notice: "", error: "" });
  try {
    const saved = await api<Note>(`/api/notifications/${id}`, { method: "PATCH", body: JSON.stringify({ read }) });
    if (pending.get(id) === read) pending.delete(id);
    inbox.update((s) => {
      const cur = s.items.find((n) => n.id === id);
      if (!cur || pending.has(id) || cur.read === Boolean(saved.read)) return s;
      return withItems(s, setRead(s.items, new Set([id]), Boolean(saved.read)), saved.read ? -1 : 1);
    });
  } catch {
    if (pending.get(id) === read) pending.delete(id);
    inbox.update((s) => ({ ...withItems(s, setRead(s.items, new Set([id]), !read), read ? 1 : -1), error: `Couldn't mark “${note.title}” as ${read ? "read" : "unread"}.` }));
  }
}

async function markAllRead() {
  const s0 = $inbox.get();
  if (BULK_LOCK && s0.busy) return;
  const ids = s0.items.filter((n) => !n.read).map((n) => n.id);
  if (!ids.length) return;
  for (const id of ids) pending.set(id, true);
  writesSent++;
  $inbox.set({ ...withItems(s0, setRead(s0.items, new Set(ids), true), -ids.length), busy: true, notice: "", error: "" });
  try {
    const r = await fetch("/api/notifications/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, op: "patch", patch: { read: true } }) });
    if (!r.ok && r.status !== 207) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as { results?: { id: number; ok: boolean; status: number }[] };
    const failed = BULK_RESULT === "per-item" ? (body.results ?? []).filter((x) => !x.ok && x.status !== 404).map((x) => Number(x.id)) : [];
    for (const id of ids) if (pending.get(id) === true) pending.delete(id);
    inbox.update((s) => {
      if (!failed.length) return { ...s, busy: false, notice: `Marked ${ids.length} as read.` };
      const back = new Set(failed);
      return { ...withItems(s, setRead(s.items, back, false), failed.length), busy: false, error: `${failed.length} of ${ids.length} notifications couldn't be marked as read. Try again.` };
    });
  } catch {
    for (const id of ids) if (pending.get(id) === true) pending.delete(id);
    inbox.update((s) => ({ ...withItems(s, setRead(s.items, new Set(ids), false), ids.length), busy: false, error: "Couldn't mark your notifications as read." }));
  }
}

async function dismiss(id: number) {
  const s0 = $inbox.get();
  const note = s0.items.find((n) => n.id === id);
  if (!note) return;
  writesSent++;
  $inbox.set({ ...withItems(s0, s0.items.filter((n) => n.id !== id), note.read ? 0 : -1), notice: "", error: "" });
  try {
    await api<null>(`/api/notifications/${id}`, { method: "DELETE" });
  } catch {
    inbox.update((s) => ({ ...(s.items.some((n) => n.id === id) ? s : withItems(s, [...s.items, note], note.read ? 0 : 1)), error: `Couldn't dismiss “${note.title}”.` }));
  }
}

// --------------------------------------------------------------------------------------------------- DOM
const esc = (x: unknown) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const when = (iso?: string) => (iso ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : "");
const root = document.getElementById("app")!;
root.innerHTML = `<main class="notifications">
  <header><h1>Notifications</h1><p class="badge"></p></header>
  <div class="toolbar">
    <label>Show <select name="filter" aria-label="Show"><option value="all">Everything</option><option value="unread">Unread</option><option value="mention">Mentions</option><option value="review">Review requests</option><option value="deploy">Deploys</option></select></label>
    <button class="mark-all">Mark all as read</button>
  </div>
  <div class="msg"></div>
  <ul class="list"></ul>
</main>`;
const badge = root.querySelector(".badge")!;
const msg = root.querySelector(".msg")!;
const list = root.querySelector("ul.list")!;
const markAllBtn = root.querySelector("button.mark-all") as HTMLButtonElement;
const filterSel = root.querySelector("select[name=filter]") as HTMLSelectElement;

function render() {
  const s = $inbox.get();
  badge.textContent = s.loaded ? `${s.unread} unread` : "Loading…";
  markAllBtn.disabled = BULK_LOCK && s.busy;
  markAllBtn.textContent = s.busy ? "Marking…" : "Mark all as read";
  msg.innerHTML = (s.error ? `<p role="alert">${esc(s.error)}</p>` : "") + (s.notice ? `<p class="notice">${esc(s.notice)}</p>` : "");
  const shown = $visible.get();
  list.innerHTML = shown.length
    ? shown.map((n) => `<li class="note ${n.read ? "read" : "unread"}" data-id="${n.id}"><span class="kind">${esc(KIND_LABEL[n.kind] ?? n.kind)}</span> ${esc(n.title)} <small>${when(n.createdAt)}</small> <button class="toggle-read">${n.read ? "Mark unread" : "Mark read"}</button> <button class="dismiss" aria-label="Dismiss">Dismiss</button></li>`).join("")
    : `<li class="empty">You're all caught up.</li>`;
}
$visible.subscribe(render);
$inbox.listen(render);

list.addEventListener("click", (e) => {
  const btn = (e.target as Element).closest("button");
  const id = Number(btn?.closest("li")?.getAttribute("data-id"));
  if (!btn || !id) return;
  if (btn.classList.contains("toggle-read")) void toggleRead(id);
  else if (btn.classList.contains("dismiss")) void dismiss(id);
});
markAllBtn.addEventListener("click", () => void markAllRead());
filterSel.addEventListener("change", () => $inbox.setKey("filter", filterSel.value));

void poll();
setInterval(() => void poll(), 5000);
