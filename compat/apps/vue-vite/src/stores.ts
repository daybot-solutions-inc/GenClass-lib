// Pinia setup stores, one per scenario, written the common way: the search action assigns whatever answer arrives
// (a: no ordering guard), the create action has no in-flight guard (b). The other scenarios are correct.
// GenClass does not discover Pinia state (README: not covered yet); it sees the network and user input.
import { defineStore } from "pinia";
import { ref } from "vue";
import * as api from "./api";

export type NoteRow = { key: string; text: string; pending?: boolean };

export const useSearch = defineStore("search", () => {
  const q = ref("");
  const results = ref<string[]>([]);
  function setQ(v: string) {
    q.value = v;
    if (!v) return void (results.value = []);
    api.search(v).then((r) => (results.value = r.results), () => {});
  }
  return { q, results, setQ };
});

export const useItems = defineStore("items", () => {
  const items = ref<api.Item[] | null>(null);
  const title = ref("");
  const error = ref<string | null>(null);
  const load = () => api.items().then((r) => (items.value = r.items));
  async function create() {
    try {
      const item = await api.createItem(title.value);
      items.value = [...(items.value ?? []), item];
      title.value = "";
    } catch {
      error.value = "Could not create";
    }
  }
  return { items, title, error, load, create };
});

export const usePanels = defineStore("panels", () => {
  const left = ref<string[] | null>(null);
  const right = ref<string[] | null>(null);
  function load() {
    api.left().then((p) => (left.value = p.rows));
    api.right().then((p) => (right.value = p.rows));
  }
  return { left, right, load };
});

export const useTodos = defineStore("todos", () => {
  const todos = ref<api.Todo[] | null>(null);
  const error = ref<string | null>(null);
  const load = () => api.todos().then((r) => (todos.value = r.todos));
  const patch = (id: number, fn: (x: api.Todo) => api.Todo) => (todos.value = todos.value!.map((x) => (x.id === id ? fn(x) : x)));
  async function toggle(t: api.Todo) {
    const done = !t.done;
    patch(t.id, (x) => ({ ...x, done })); // optimistic
    try {
      const saved = await api.toggleTodo(t.id, done);
      patch(t.id, () => saved);
    } catch {
      patch(t.id, (x) => ({ ...x, done: t.done })); // roll back
      error.value = `Could not save "${t.title}"`;
    }
  }
  return { todos, error, load, toggle };
});

let noteSeq = 0;
export const useNotes = defineStore("notes", () => {
  const notes = ref<NoteRow[] | null>(null);
  const draft = ref("");
  const load = () => api.notes().then((r) => (notes.value = r.notes.map((n) => ({ key: `s${n.id}`, text: n.text }))));
  const outbox = api.createOutbox<NoteRow>(async (row) => {
    try {
      const saved = await api.addNote(row.text);
      notes.value = notes.value!.map((n) => (n.key === row.key ? { key: `s${saved.id}`, text: saved.text } : n));
      return true;
    } catch {
      return false;
    }
  });
  function add() {
    const row = { key: `l${++noteSeq}`, text: draft.value, pending: true };
    draft.value = "";
    notes.value = [...(notes.value ?? []), row];
    void outbox.submit(row);
  }
  return { notes, draft, load, add };
});

export const useCounter = defineStore("counter", () => {
  const count = ref(0);
  const synced = ref(0);
  function plus() {
    count.value++;
    api.increment().then((r) => (synced.value = Math.max(synced.value, r.count)));
  }
  return { count, synced, plus };
});

export const useLive = defineStore("live", () => {
  const tick = ref(0);
  const polls = ref(0);
  const details = ref<Record<number, api.Detail>>({});
  function start() {
    for (const id of api.DETAIL_IDS) api.detail(id).then((d) => (details.value = { ...details.value, [id]: d }));
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const r = await api.status();
      if (stopped) return;
      tick.value = r.tick;
      polls.value++;
      if (r.tick < 8) timer = setTimeout(poll, 250);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }
  return { tick, polls, details, start };
});
