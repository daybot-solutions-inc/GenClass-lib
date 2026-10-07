// Notes editor with autosave. Written like many real editors: debounced saves plus a max-wait while typing,
// the server's echo becomes the note (so server-side normalisation shows up), and a background refresh picks up
// edits made on other devices.
// Latent bugs (deliberate, realistic, invisible on a fast network):
//   - saves are not serialised, so they can overlap and reach the server out of order;
//   - the echo is applied unless the user typed in the last 300 ms (works when saves answer in ~50 ms);
//   - any successful save shows "Saved", even the echo of an older version;
//   - the refresh checks for local edits when it starts, not when it answers.
import type { AppContext } from "../../shared/demo-def.ts";
import { api } from "../../shared/api.ts";
import { createNotesStore, type Note, type NotesState } from "./store.ts";
import "./app.css";

const DEBOUNCE_MS = 700;
const MAX_WAIT_MS = 3000;
const REFRESH_MS = 5000;
const TYPING_GUARD_MS = 300;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function relTime(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export async function mountEditor({ gc, el }: AppContext): Promise<void> {
  const store = createNotesStore(gc);

  el.innerHTML = `
    <div class="ed">
      <aside class="ed-side">
        <div class="ed-side-head"><span>Notes</span><span class="ed-count"></span></div>
        <nav class="ed-list" data-testid="note-list"></nav>
      </aside>
      <section class="ed-main">
        <div class="ed-bar">
          <span class="ed-crumb">Workspace / <b class="ed-crumb-title"></b></span>
          <span class="ed-status" data-testid="save-status" data-state="idle"><i></i><span></span></span>
        </div>
        <input class="ed-title" data-testid="note-title" aria-label="Note title" />
        <textarea class="ed-body" data-testid="note-body" aria-label="Note text" spellcheck="false"></textarea>
        <div class="ed-foot"><span class="ed-ver"></span><span class="ed-chars"></span></div>
      </section>
    </div>`;

  const listEl = el.querySelector<HTMLElement>('[data-testid="note-list"]')!;
  const titleEl = el.querySelector<HTMLInputElement>('[data-testid="note-title"]')!;
  const bodyEl = el.querySelector<HTMLTextAreaElement>('[data-testid="note-body"]')!;
  const statusEl = el.querySelector<HTMLElement>('[data-testid="save-status"]')!;
  const crumb = el.querySelector<HTMLElement>(".ed-crumb-title")!;
  const verEl = el.querySelector<HTMLElement>(".ed-ver")!;
  const charsEl = el.querySelector<HTMLElement>(".ed-chars")!;
  const countEl = el.querySelector<HTMLElement>(".ed-count")!;

  let lastKeyAt = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let firstUnsavedEditAt: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const active = (): Note | null => {
    const s = store.getState();
    return s.activeId ? s.notes[s.activeId] ?? null : null;
  };

  async function save() {
    const note = active();
    if (!note) return;
    firstUnsavedEditAt = null;
    store.dispatch({ type: "save/started" });
    try {
      const res = await fetch(api(`notes/${note.id}`), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: note.title, body: note.body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved = (await res.json()) as Note;
      // Take the server's copy as the note, unless the user is typing right now.
      const typing = performance.now() - lastKeyAt < TYPING_GUARD_MS;
      store.dispatch({ type: "save/succeeded", note: saved, applyBody: !typing });
    } catch {
      store.dispatch({ type: "save/failed" });
      clearTimeout(retryTimer);
      retryTimer = setTimeout(save, 2000);
    }
  }

  function scheduleSave() {
    const now = performance.now();
    if (firstUnsavedEditAt === null) firstUnsavedEditAt = now;
    clearTimeout(debounceTimer);
    if (now - firstUnsavedEditAt >= MAX_WAIT_MS) {
      void save();
      return;
    }
    debounceTimer = setTimeout(save, DEBOUNCE_MS);
  }

  function onEdit() {
    const note = active();
    if (!note) return;
    lastKeyAt = performance.now();
    store.dispatch({ type: "note/edited", id: note.id, title: titleEl.value, body: bodyEl.value });
    scheduleSave();
  }

  titleEl.addEventListener("input", onEdit);
  bodyEl.addEventListener("input", onEdit);

  listEl.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-id]");
    if (!b) return;
    store.dispatch({ type: "note/selected", id: b.dataset.id! });
    await loadNote(b.dataset.id!);
  });

  async function loadNote(id: string) {
    const res = await fetch(api(`notes/${id}`));
    if (res.ok) store.dispatch({ type: "note/loaded", note: (await res.json()) as Note });
  }

  // Pick up edits from other devices while the note is saved and the user is idle.
  setInterval(async () => {
    const s = store.getState();
    const note = active();
    if (!note || (s.status !== "saved" && s.status !== "idle") || performance.now() - lastKeyAt < 2000) return;
    try {
      const res = await fetch(api(`notes/${note.id}`));
      if (!res.ok) return;
      const remote = (await res.json()) as Note;
      const local = store.getState().notes[remote.id];
      if (local && remote.version > local.version) store.dispatch({ type: "note/loaded", note: remote });
    } catch {
      /* try again next time */
    }
  }, REFRESH_MS);

  const STATUS_TEXT: Record<NotesState["status"], string> = {
    idle: "Up to date",
    dirty: "Unsaved changes",
    saving: "Saving…",
    saved: "Saved",
    error: "Couldn’t save · retrying",
  };

  let lastListKey = "";
  function render() {
    const s = store.getState();
    const note = active();
    statusEl.dataset.state = s.status;
    statusEl.querySelector("span")!.textContent = STATUS_TEXT[s.status];
    if (note) {
      if (titleEl.value !== note.title) titleEl.value = note.title;
      if (bodyEl.value !== note.body) bodyEl.value = note.body;
      crumb.textContent = note.title;
      verEl.textContent = `v${note.version} · edited ${relTime(note.updatedAt)}`;
      charsEl.textContent = `${note.body.length.toLocaleString()} characters`;
    }
    const listKey = s.order.map((id) => `${id}:${s.notes[id]?.title}:${s.activeId === id}`).join("|");
    if (listKey !== lastListKey) {
      lastListKey = listKey;
      countEl.textContent = String(s.order.length);
      listEl.innerHTML = s.order
        .map((id) => {
          const n = s.notes[id];
          return `<button type="button" data-id="${id}" class="${s.activeId === id ? "on" : ""}"><b>${esc(n.title)}</b><span>${esc(n.body.split("\n")[0].slice(0, 60))}</span></button>`;
        })
        .join("");
    }
  }
  store.subscribe(render);
  setInterval(() => {
    const note = active();
    if (note) verEl.textContent = `v${note.version} · edited ${relTime(note.updatedAt)}`;
  }, 15000);

  const res = await fetch(api("notes"));
  if (res.ok) store.dispatch({ type: "notes/listed", notes: await res.json() });
  const first = store.getState().activeId;
  if (first) await loadNote(first);
  render();
}
