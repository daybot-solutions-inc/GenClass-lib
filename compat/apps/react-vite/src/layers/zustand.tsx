// Data layer "zustand": Zustand 5 stores with the `devtools` middleware (the documented way GenClass discovers
// Zustand state), actions that fetch and `set`. Written the common way: the search action sets whatever answer
// arrives (a: no ordering guard), the create action has no in-flight guard (b). The other scenarios are correct.
//
// Zustand turns the devtools middleware off in production builds unless `enabled: true` is passed, so in a
// production build GenClass cannot discover these stores. ?layer=zustand is the idiomatic app (no `enabled`);
// ?layer=zustand-on is the same app with `enabled: true` (keeps discovery in production).
import { useEffect } from "react";
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import * as api from "../api";
import * as V from "../views";

const DEVTOOLS = new URLSearchParams(location.search).get("layer") === "zustand-on" ? { enabled: true } : {};

type SearchState = { q: string; results: string[]; setQ(q: string): void };
const useSearch = create<SearchState>()(
  devtools(
    (set) => ({
      q: "",
      results: [],
      setQ(q) {
        set({ q }, false, "search/setQ");
        if (!q) return set({ results: [] }, false, "search/clear");
        api.search(q).then((r) => set({ results: r.results }, false, "search/results"), () => {});
      },
    }),
    { name: "search", ...DEVTOOLS },
  ),
);

type ItemsState = { items: api.Item[] | null; title: string; error: string | null; load(): void; setTitle(t: string): void; create(): Promise<void> };
const useItems = create<ItemsState>()(
  devtools(
    (set, get) => ({
      items: null,
      title: "",
      error: null,
      load() {
        api.items().then((r) => set({ items: r.items }, false, "items/loaded"));
      },
      setTitle: (title) => set({ title }, false, "items/title"),
      async create() {
        try {
          const item = await api.createItem(get().title);
          set((s) => ({ items: [...(s.items ?? []), item], title: "" }), false, "items/created");
        } catch {
          set({ error: "Could not create" }, false, "items/error");
        }
      },
    }),
    { name: "items", ...DEVTOOLS },
  ),
);

type PanelsState = { left: string[] | null; right: string[] | null; load(): void };
const usePanels = create<PanelsState>()(
  devtools(
    (set) => ({
      left: null,
      right: null,
      load() {
        api.left().then((p) => set({ left: p.rows }, false, "panels/left"));
        api.right().then((p) => set({ right: p.rows }, false, "panels/right"));
      },
    }),
    { name: "panels", ...DEVTOOLS },
  ),
);

type TodosState = { todos: api.Todo[] | null; error: string | null; load(): void; toggle(t: api.Todo): Promise<void> };
const useTodos = create<TodosState>()(
  devtools(
    (set) => ({
      todos: null,
      error: null,
      load() {
        api.todos().then((r) => set({ todos: r.todos }, false, "todos/loaded"));
      },
      async toggle(t) {
        const done = !t.done;
        const patch = (fn: (x: api.Todo) => api.Todo) => (s: TodosState) => ({ todos: s.todos!.map((x) => (x.id === t.id ? fn(x) : x)) });
        set(patch((x) => ({ ...x, done })), false, "todos/optimistic");
        try {
          const saved = await api.toggleTodo(t.id, done);
          set(patch(() => saved), false, "todos/confirmed");
        } catch {
          set(patch((x) => ({ ...x, done: t.done })), false, "todos/rollback");
          set({ error: `Could not save "${t.title}"` }, false, "todos/error");
        }
      },
    }),
    { name: "todos", ...DEVTOOLS },
  ),
);

let noteSeq = 0;
type NotesState = { notes: V.NoteRow[] | null; draft: string; load(): void; setDraft(t: string): void; add(): void };
const useNotes = create<NotesState>()(
  devtools(
    (set, get) => {
      const outbox = api.createOutbox<V.NoteRow>(async (row) => {
        try {
          const saved = await api.addNote(row.text);
          set((s) => ({ notes: s.notes!.map((n) => (n.key === row.key ? { key: `s${saved.id}`, text: saved.text } : n)) }), false, "notes/synced");
          return true;
        } catch {
          return false;
        }
      });
      return {
        notes: null,
        draft: "",
        load() {
          api.notes().then((r) => set({ notes: r.notes.map((n) => ({ key: `s${n.id}`, text: n.text })) }, false, "notes/loaded"));
        },
        setDraft: (draft) => set({ draft }, false, "notes/draft"),
        add() {
          const row = { key: `l${++noteSeq}`, text: get().draft, pending: true };
          set((s) => ({ draft: "", notes: [...(s.notes ?? []), row] }), false, "notes/queued");
          void outbox.submit(row);
        },
      };
    },
    { name: "notes", ...DEVTOOLS },
  ),
);

type CounterState = { count: number; synced: number; plus(): void };
const useCounter = create<CounterState>()(
  devtools(
    (set) => ({
      count: 0,
      synced: 0,
      plus() {
        set((s) => ({ count: s.count + 1 }), false, "counter/plus");
        api.increment().then((r) => set((s) => ({ synced: Math.max(s.synced, r.count) }), false, "counter/synced"));
      },
    }),
    { name: "counter", ...DEVTOOLS },
  ),
);

type LiveState = { tick: number; polls: number; details: Record<number, api.Detail>; start(): () => void };
const useLive = create<LiveState>()(
  devtools(
    (set) => ({
      tick: 0,
      polls: 0,
      details: {},
      start() {
        for (const id of api.DETAIL_IDS) api.detail(id).then((d) => set((s) => ({ details: { ...s.details, [id]: d } }), false, "live/detail"));
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
          const r = await api.status();
          if (stopped) return;
          set((s) => ({ tick: r.tick, polls: s.polls + 1 }), false, "live/status");
          if (r.tick < 8) timer = setTimeout(poll, 250);
        };
        void poll();
        return () => {
          stopped = true;
          clearTimeout(timer);
        };
      },
    }),
    { name: "live", ...DEVTOOLS },
  ),
);

function A() {
  const { q, results, setQ } = useSearch();
  return <V.Typeahead q={q} onQ={setQ} results={results} />;
}

function B() {
  const { items, title, error, load, setTitle, create } = useItems();
  useEffect(load, [load]);
  return <V.Create ready={items !== null} items={items ?? []} title={title} onTitle={setTitle} onSubmit={() => void create()} error={error} />;
}

function C() {
  const { left, right, load } = usePanels();
  return <V.Panels onLoad={load} left={left} right={right} />;
}

function D() {
  const { todos, error, load, toggle } = useTodos();
  useEffect(load, [load]);
  return <V.Todos ready={todos !== null} todos={todos ?? []} onToggle={(t) => void toggle(t)} error={error} />;
}

function E() {
  const { notes, draft, load, setDraft, add } = useNotes();
  useEffect(load, [load]);
  return <V.Notes ready={notes !== null} notes={notes ?? []} draft={draft} onDraft={setDraft} onAdd={add} />;
}

function F() {
  const { count, synced, plus } = useCounter();
  return <V.Counter count={count} synced={synced} onPlus={plus} />;
}

let liveStarted = false;
function LiveData() {
  const { tick, polls, details, start } = useLive();
  useEffect(() => {
    if (liveStarted) return; // StrictMode mounts effects twice in development; the store is global
    liveStarted = true;
    start();
  }, [start]);
  return <V.LivePanel tick={tick} polls={polls} details={api.DETAIL_IDS.map((id) => details[id])} />;
}
const G = () => (
  <V.Live>
    <LiveData />
  </V.Live>
);

function H() {
  const items = useItems();
  const search = useSearch();
  useEffect(items.load, [items.load]);
  return (
    <V.Clean
      ready={items.items !== null}
      items={items.items ?? []}
      q={search.q}
      onQ={search.setQ}
      results={search.results}
      title={items.title}
      onTitle={items.setTitle}
      onCreate={() => void items.create()}
    />
  );
}

const S: Record<string, () => React.ReactElement> = { a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H };
export default function ZustandLayer({ s }: { s: string }) {
  const C = S[s] ?? H;
  return <C />;
}
