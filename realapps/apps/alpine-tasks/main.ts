// Shared team task list (Alpine.js 3 components + fetch; the Alpine store mirrors a runtime atom that owns the
// state). Toggles and inline title edits are optimistic PATCHes carrying the task's version; teammates edit the
// same tasks, so writes can answer 409. Latent bugs by flag: conflicts resolved by blindly re-sending with the
// server's version (conflict=overwrite) or by keeping the local copy (conflict=keep-local), failed writes not
// rolled back (rollback=false), the version from the echo not adopted (versionFromEcho=false: the next edit
// conflicts with ourselves), concurrent writes to one task (serialize=false) and an Add button that is not
// disabled while posting (addDisable=false).
import Alpine from "alpinejs";
import { rt, flag } from "../_shared/genclass";

type Task = { id: number; title: string; done: boolean; project: string; priority: "low" | "normal" | "high"; version: number };

const CONFLICT = flag("conflict", "refetch") as "refetch" | "overwrite" | "keep-local";
const ROLLBACK = Boolean(flag("rollback", true));
const VERSION_FROM_ECHO = Boolean(flag("versionFromEcho", true));
const SERIALIZE = Boolean(flag("serialize", true));
const ADD_DISABLE = Boolean(flag("addDisable", true));
const SYNC_MS = Number(flag("syncMs", 12000));
const PROJECTS = ["work", "personal", "errands"];

const remainingOf = (items: Task[]) => items.filter((t) => !t.done).length;
const tasks = rt.atom("tasks", { project: "work", items: [] as Task[], remaining: 0, loading: true, adding: false, error: "", notice: "" });

// Alpine's reactive store mirrors the atom (the atom is the source of truth)
Alpine.store("tasks", { ...tasks.get() });
tasks.subscribe((v) => Object.assign(Alpine.store("tasks") as Record<string, unknown>, v));

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}
const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function setItems(items: Task[], extra: Partial<ReturnType<typeof tasks.get>> = {}) {
  tasks.update((s) => ({ ...s, ...extra, items, remaining: remainingOf(items) }));
}
function patchLocal(id: number, patch: Partial<Task>) {
  const items = tasks.get().items.map((t) => (t.id === id ? { ...t, ...patch } : t));
  setItems(items);
}
const find = (id: number) => tasks.get().items.find((t) => t.id === id);

// ------------------------------------------------------------------------------------------- loading
const pending = new Map<number, number>();
async function load(project: string, background = false) {
  if (!background) tasks.update((s) => ({ ...s, project, loading: true, error: "", notice: "" }));
  try {
    const r = await fetch(`/api/tasks?project=${project}`);
    if (!r.ok) throw new HttpError(r.status);
    const { data } = (await r.json()) as { data: Task[] };
    if (tasks.get().project !== project) return;
    // keep our own unsaved edits when a background sync lands
    const local = new Map(tasks.get().items.map((t) => [t.id, t]));
    const items = data.map((t) => (pending.get(t.id) && local.has(t.id) ? local.get(t.id)! : t));
    setItems(items, { loading: false });
  } catch {
    if (tasks.get().project !== project) return;
    tasks.update((s) => ({ ...s, loading: false, ...(background ? {} : { error: "Couldn't load tasks." }) }));
  }
}

// -------------------------------------------------------------------------------------------- writes
const queues = new Map<number, Promise<void>>();
function enqueue(id: number, fn: () => Promise<void>): Promise<void> {
  if (!SERIALIZE) return fn();
  const next = (queues.get(id) ?? Promise.resolve()).then(fn, fn);
  queues.set(id, next);
  void next.catch(() => undefined).then(() => {
    if (queues.get(id) === next) queues.delete(id);
  });
  return next;
}

async function onConflict(id: number, patch: Partial<Task>, current: Task) {
  if (CONFLICT === "refetch") {
    patchLocal(id, current);
    tasks.update((s) => ({ ...s, notice: `"${current.title}" was changed by a teammate — showing their version.` }));
  } else if (CONFLICT === "overwrite") {
    const r = await fetch(`/api/tasks/${id}`, jsonInit("PATCH", { ...patch, version: current.version }));
    if (!r.ok) throw new HttpError(r.status);
    patchLocal(id, (await r.json()) as Task);
  } else {
    tasks.update((s) => ({ ...s, error: "Couldn't save: this task was modified elsewhere." }));
  }
}

function saveTask(id: number, patch: Partial<Task>) {
  const before = find(id);
  if (!before) return;
  const undo: Partial<Task> = {};
  for (const k of Object.keys(patch) as (keyof Task)[]) (undo as Record<string, unknown>)[k] = before[k];
  patchLocal(id, patch);
  pending.set(id, (pending.get(id) ?? 0) + 1);
  void enqueue(id, async () => {
    const cur = find(id);
    if (!cur) return;
    const r = await fetch(`/api/tasks/${id}`, jsonInit("PATCH", { ...patch, version: cur.version }));
    if (r.status === 409) return onConflict(id, patch, ((await r.json()) as { current: Task }).current);
    if (!r.ok) throw new HttpError(r.status);
    const saved = (await r.json()) as Task;
    patchLocal(id, VERSION_FROM_ECHO ? saved : patch);
  })
    .catch(() => {
      if (ROLLBACK) patchLocal(id, undo);
      tasks.update((s) => ({ ...s, error: "Couldn't save your change. Please try again." }));
    })
    .finally(() => pending.set(id, (pending.get(id) ?? 1) - 1));
}

async function addTask(title: string) {
  if (ADD_DISABLE && tasks.get().adding) return false;
  tasks.update((s) => ({ ...s, adding: true, error: "" }));
  try {
    const r = await fetch("/api/tasks", jsonInit("POST", { title, project: tasks.get().project, done: false, priority: "normal" }));
    if (!r.ok) throw new HttpError(r.status);
    const t = (await r.json()) as Task;
    if (t.project === tasks.get().project) setItems([...tasks.get().items, t]);
    return true;
  } catch {
    tasks.update((s) => ({ ...s, error: "Couldn't add the task." }));
    return false;
  } finally {
    tasks.update((s) => ({ ...s, adding: false }));
  }
}

async function removeTask(id: number) {
  const before = tasks.get().items;
  setItems(before.filter((t) => t.id !== id));
  try {
    const r = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new HttpError(r.status);
  } catch {
    const t = before.find((x) => x.id === id);
    if (t && !find(id)) setItems([...tasks.get().items, t]);
    tasks.update((s) => ({ ...s, error: "Couldn't delete the task." }));
  }
}

async function clearCompleted() {
  const ids = tasks.get().items.filter((t) => t.done).map((t) => t.id);
  if (!ids.length) return;
  try {
    const r = await fetch("/api/tasks/bulk", jsonInit("POST", { ids, op: "delete" }));
    if (!r.ok) throw new HttpError(r.status);
    const { results } = (await r.json()) as { results: { id: number; ok: boolean; status: number }[] };
    const gone = new Set(results.filter((x) => x.ok || x.status === 404).map((x) => x.id));
    setItems(tasks.get().items.filter((t) => !gone.has(t.id)));
    if (gone.size < ids.length) tasks.update((s) => ({ ...s, error: `${ids.length - gone.size} task(s) could not be removed.` }));
  } catch {
    tasks.update((s) => ({ ...s, error: "Couldn't clear completed tasks." }));
  }
}

// ------------------------------------------------------------------------------------------ components
Alpine.data("taskApp", () => ({
  draft: "",
  projects: PROJECTS,
  guardAdd: ADD_DISABLE,
  init() {
    void load("work");
    setInterval(() => void load(tasks.get().project, true), SYNC_MS);
  },
  label: (p: string) => p[0]!.toUpperCase() + p.slice(1),
  switchProject(p: string) {
    if (p !== tasks.get().project) void load(p);
  },
  async add() {
    const title = this.draft.trim();
    if (!title) return;
    if (await addTask(title)) this.draft = "";
  },
  toggle(id: number) {
    const t = find(id);
    if (t) saveTask(id, { done: !t.done });
  },
  rename(id: number, title: string) {
    const t = find(id);
    const next = title.trim();
    if (t && next && next !== t.title) saveTask(id, { title: next });
  },
  remove: (id: number) => void removeTask(id),
  clearDone: () => void clearCompleted(),
  dismiss: () => tasks.update((s) => ({ ...s, error: "", notice: "" })),
}));

document.getElementById("app")!.innerHTML = `
  <div class="task-app" x-data="taskApp">
    <header>
      <h1>Team tasks</h1>
      <nav><template x-for="p in projects" :key="p"><button type="button" class="project" :class="{ active: p === $store.tasks.project }" @click="switchProject(p)" x-text="label(p)"></button></template></nav>
      <p class="counts" x-text="$store.tasks.remaining + ' of ' + $store.tasks.items.length + ' open'"></p>
    </header>
    <form class="add-form" @submit.prevent="add()">
      <input name="new-task" x-model="draft" placeholder="Add a task…" autocomplete="off">
      <button type="submit" class="add-btn" :disabled="guardAdd && $store.tasks.adding">Add</button>
    </form>
    <p class="loading" x-show="$store.tasks.loading">Loading tasks…</p>
    <template x-if="$store.tasks.error"><p role="alert"><span x-text="$store.tasks.error"></span> <button type="button" class="dismiss" @click="dismiss()">Dismiss</button></p></template>
    <template x-if="$store.tasks.notice"><p class="notice" role="status" x-text="$store.tasks.notice"></p></template>
    <ul class="tasks">
      <template x-for="t in $store.tasks.items" :key="t.id">
        <li class="task" :class="{ done: t.done }" x-data="{ editing: false, title: '' }">
          <input type="checkbox" class="toggle" :checked="t.done" @change="toggle(t.id)" :aria-label="'Done: ' + t.title">
          <span class="title" x-show="!editing" x-text="t.title" @dblclick="editing = true; title = t.title; $nextTick(() => $refs.edit.focus())"></span>
          <form class="edit-form" x-show="editing" @submit.prevent="rename(t.id, title); editing = false"><input class="edit-title" x-ref="edit" x-model="title" @keydown.escape="editing = false"></form>
          <span class="prio" x-text="t.priority === 'high' ? '!' : ''"></span>
          <button type="button" class="delete" @click="remove(t.id)" aria-label="Delete">×</button>
        </li>
      </template>
    </ul>
    <button type="button" class="clear-done" @click="clearDone()">Clear completed</button>
  </div>`;

(window as unknown as { Alpine: typeof Alpine }).Alpine = Alpine;
Alpine.start();
