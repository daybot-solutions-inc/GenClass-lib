// Webmail inbox built from Lit web components (shadow DOM) + fetch, state in runtime atoms bound to the
// components through a reactive controller. Latent bugs by flag: "Load more" without an in-flight guard (the same
// page appended twice, loadGuard=none), page responses applied after the folder changed (folderGuard=none),
// relative read toggles (readWrite=relative: replays and double clicks flip twice), and an unread badge kept by
// +1/-1 bookkeeping that misses rollbacks and server echoes (badge=incremental).
import { LitElement, html, css, nothing } from "lit";
import { rt, flag } from "../_shared/genclass";
import { AtomController } from "../_shared/lit-atom";
import { toast } from "../_shared/lit-toast";

type Msg = { id: number; folder: string; from: string; subject: string; snippet: string; body?: string; read: boolean; createdAt?: string };
type Page = { items: Msg[]; total: number; page: number };

const LOAD_GUARD = flag("loadGuard", "inflight") as "inflight" | "none";
const FOLDER_GUARD = flag("folderGuard", "token") as "token" | "none";
const READ_WRITE = flag("readWrite", "absolute") as "absolute" | "relative";
const BADGE = flag("badge", "derive") as "derive" | "incremental";
const PAGE = Number(flag("pageSize", 6));
const FOLDERS = ["inbox", "updates", "promotions", "archive"];

const unreadOf = (items: Msg[]) => items.filter((m) => !m.read).length;
const inbox = rt.atom("inbox", { folder: "inbox", items: [] as Msg[], page: 0, total: 0, unread: 0, loading: true, loadingMore: false, error: "" });
const reader = rt.atom("reader", { id: 0, msg: null as Msg | null, loading: false, error: "" });

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}
async function api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new HttpError(r.status);
  return (await r.json()) as T;
}
const pageUrl = (folder: string, page: number) => `/api/messages?folder=${folder}&sort=-createdAt&page=${page}&limit=${PAGE}`;

// ---------------------------------------------------------------------------------------------- list
let gen = 0;

async function loadFolder(folder: string) {
  const my = ++gen;
  inbox.update((s) => ({ ...s, folder, items: s.folder === folder ? s.items : [], loading: true, loadingMore: false, error: "" }));
  try {
    const d = await api<Page>(pageUrl(folder, 1));
    if (FOLDER_GUARD === "token" && my !== gen) return;
    inbox.update((s) => ({ ...s, items: d.items, page: 1, total: d.total, unread: unreadOf(d.items), loading: false }));
  } catch {
    if (FOLDER_GUARD === "token" && my !== gen) return;
    inbox.update((s) => ({ ...s, loading: false, error: "Couldn't load this folder." }));
    toast("Couldn't load this folder. Check your connection.");
  }
}

async function loadMore() {
  const s = inbox.get();
  if (LOAD_GUARD === "inflight" && (s.loading || s.loadingMore)) return;
  if (s.items.length >= s.total) return;
  const my = gen;
  inbox.update((x) => ({ ...x, loadingMore: true }));
  try {
    const d = await api<Page>(pageUrl(s.folder, s.page + 1));
    if (FOLDER_GUARD === "token" && my !== gen) return;
    inbox.update((x) => {
      const items = [...x.items, ...d.items];
      return { ...x, items, page: d.page, total: d.total, loadingMore: false, unread: BADGE === "derive" ? unreadOf(items) : x.unread + unreadOf(d.items) };
    });
  } catch {
    if (FOLDER_GUARD === "token" && my !== gen) return;
    inbox.update((x) => ({ ...x, loadingMore: false, error: "Couldn't load more messages." }));
    toast("Couldn't load more messages.");
  }
}

// ------------------------------------------------------------------------------------------ read state
function setLocalRead(id: number, read: boolean) {
  inbox.update((s) => {
    const before = s.items.find((m) => m.id === id);
    const items = s.items.map((m) => (m.id === id ? { ...m, read } : m));
    const delta = before && before.read !== read ? (read ? -1 : 1) : 0;
    return { ...s, items, unread: BADGE === "derive" ? unreadOf(items) : s.unread + delta };
  });
}

async function writeRead(id: number, read: boolean, prev: boolean) {
  setLocalRead(id, read);
  try {
    const saved = READ_WRITE === "absolute" ? await api<Msg>(`/api/messages/${id}`, "PATCH", { read }) : await api<Msg>(`/api/messages/${id}/toggle-read`, "POST", {});
    inbox.update((s) => {
      const items = s.items.map((m) => (m.id === id ? { ...m, ...saved } : m));
      return { ...s, items, unread: BADGE === "derive" ? unreadOf(items) : s.unread };
    });
  } catch {
    // roll the optimistic flip back
    inbox.update((s) => {
      const items = s.items.map((m) => (m.id === id ? { ...m, read: prev } : m));
      return { ...s, items, unread: BADGE === "derive" ? unreadOf(items) : s.unread };
    });
    toast("Couldn't update the message. Please try again.");
  }
}

function toggleRead(id: number) {
  const m = inbox.get().items.find((x) => x.id === id);
  if (m) void writeRead(id, !m.read, m.read);
}

async function markAllRead() {
  const ids = inbox.get().items.filter((m) => !m.read).map((m) => m.id);
  if (!ids.length) return;
  try {
    const r = await api<{ results: { id: number; ok: boolean }[] }>("/api/messages/bulk", "POST", { ids, op: "patch", patch: { read: true } });
    const ok = new Set(r.results.filter((x) => x.ok).map((x) => x.id));
    inbox.update((s) => {
      const items = s.items.map((m) => (ok.has(m.id) ? { ...m, read: true } : m));
      return { ...s, items, unread: BADGE === "derive" ? unreadOf(items) : Math.max(0, s.unread - ok.size) };
    });
    if (ok.size < ids.length) toast(`${ids.length - ok.size} message(s) could not be marked as read.`);
  } catch {
    toast("Couldn't mark messages as read.");
  }
}

// ---------------------------------------------------------------------------------------------- reader
async function openMessage(id: number) {
  reader.set({ id, msg: null, loading: true, error: "" });
  try {
    const m = await api<Msg>(`/api/messages/${id}`);
    if (reader.get().id !== id) return;
    reader.update((r) => ({ ...r, msg: m, loading: false }));
    const local = inbox.get().items.find((x) => x.id === id);
    if (local && !local.read) void writeRead(id, true, false);
  } catch {
    if (reader.get().id !== id) return;
    reader.update((r) => ({ ...r, loading: false, error: "This message could not be opened." }));
    toast("This message could not be opened.");
  }
}

// ------------------------------------------------------------------------------------------ components
class MessageRow extends LitElement {
  static properties = { msg: { attribute: false }, selected: { type: Boolean } };
  declare msg: Msg;
  declare selected: boolean;
  static styles = css`
    .row { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; }
    .unread .subject { font-weight: 700; }
    .open { flex: 1; text-align: left; background: none; border: 0; }
    .selected { background: #eef4ff; }
  `;
  constructor() {
    super();
    this.selected = false;
  }
  render() {
    const m = this.msg;
    return html`<div class="row ${m.read ? "read" : "unread"} ${this.selected ? "selected" : ""}">
      <button class="open" @click=${() => openMessage(m.id)}><span class="from">${m.from}</span> — <span class="subject">${m.subject}</span> <span class="snippet">${m.snippet}</span></button>
      <button class="toggle-read" @click=${() => toggleRead(m.id)}>${m.read ? "Mark unread" : "Mark read"}</button>
    </div>`;
  }
}
customElements.define("message-row", MessageRow);

class InboxApp extends LitElement {
  private box = new AtomController(this, inbox);
  private rd = new AtomController(this, reader);
  static styles = css`
    :host { display: grid; grid-template-columns: 160px 1fr 1fr; gap: 16px; font: 14px system-ui, sans-serif; }
    nav button { display: block; width: 100%; text-align: left; }
    nav button.current { font-weight: 700; }
    .muted { color: #777; }
  `;
  render() {
    const s = this.box.value;
    const r = this.rd.value;
    const more = s.items.length < s.total;
    const busyMore = LOAD_GUARD === "inflight" && s.loadingMore;
    return html`
      <nav>
        <h1>Mail</h1>
        ${FOLDERS.map((f) => html`<button class="folder ${f === s.folder ? "current" : ""}" @click=${() => loadFolder(f)}>${f[0]!.toUpperCase() + f.slice(1)}${f === s.folder && s.unread > 0 ? html` <span class="badge">${s.unread}</span>` : nothing}</button>`)}
        <button class="check-mail" @click=${() => loadFolder(inbox.get().folder)}>Check mail</button>
      </nav>
      <section class="list">
        <header><strong>${s.folder}</strong> · ${s.unread} unread of ${s.total} <button class="mark-all" @click=${() => void markAllRead()}>Mark all as read</button></header>
        ${s.loading && !s.items.length ? html`<p class="muted">Loading messages…</p>` : nothing}
        ${!s.loading && !s.items.length ? html`<p class="muted">No messages in ${s.folder}.</p>` : nothing}
        ${s.items.map((m) => html`<message-row .msg=${m} ?selected=${m.id === r.id}></message-row>`)}
        ${more ? html`<button class="load-more" ?disabled=${busyMore} @click=${() => void loadMore()}>${s.loadingMore ? "Loading…" : `Load more (${s.total - s.items.length} older)`}</button>` : nothing}
      </section>
      <article class="reader">
        ${r.id === 0
          ? html`<p class="muted">Select a message to read it.</p>`
          : r.loading
            ? html`<p class="muted">Opening…</p>`
            : r.msg
              ? html`<h2>${r.msg.subject}</h2><p class="meta">From ${r.msg.from}</p><p class="body">${r.msg.body ?? r.msg.snippet}</p>`
              : html`<p class="muted">${r.error || "Message unavailable."}</p>`}
        ${r.id ? html`<button class="close-reader" @click=${() => reader.set({ id: 0, msg: null, loading: false, error: "" })}>Close</button>` : nothing}
      </article>`;
  }
}
customElements.define("inbox-app", InboxApp);

document.getElementById("app")!.appendChild(document.createElement("inbox-app"));
void loadFolder("inbox");
