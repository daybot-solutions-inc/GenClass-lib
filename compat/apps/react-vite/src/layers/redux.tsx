// Data layer "redux": Redux Toolkit 2 (`configureStore`, devTools on as by default) with both styles real apps mix:
// slices + createAsyncThunk for the typeahead (a, no ordering guard), the create form (b, no in-flight guard), the
// offline outbox (e) and the counter (f); RTK Query for the panels (c), optimistic toggles with
// updateQueryData / patch.undo (d), polling (g) and the clean page (h).
import { configureStore, createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import { useEffect, useRef, useState } from "react";
import { Provider, useDispatch, useSelector } from "react-redux";
import * as api from "../api";
import * as V from "../views";

// ------------------------------------------------------------------------------------------- RTK Query
const rtk = createApi({
  reducerPath: "rtk",
  baseQuery: fetchBaseQuery({ baseUrl: "/api" }),
  tagTypes: ["Items", "Todos"],
  endpoints: (b) => ({
    items: b.query<{ items: api.Item[] }, void>({ query: () => "items", providesTags: ["Items"] }),
    search: b.query<{ q: string; results: string[] }, string>({ query: (q) => `search?q=${encodeURIComponent(q)}` }),
    createItem: b.mutation<api.Item, string>({ query: (title) => ({ url: "items", method: "POST", body: { title } }), invalidatesTags: ["Items"] }),
    left: b.query<api.Panel, void>({ query: () => "left" }),
    right: b.query<api.Panel, void>({ query: () => "right" }),
    todos: b.query<{ todos: api.Todo[] }, void>({ query: () => "todos", providesTags: ["Todos"] }),
    toggle: b.mutation<api.Todo, { id: number; done: boolean }>({
      query: ({ id, done }) => ({ url: `todos/${id}`, method: "PATCH", body: { done } }),
      async onQueryStarted({ id, done }, { dispatch, queryFulfilled }) {
        const patch = dispatch(rtk.util.updateQueryData("todos", undefined, (d) => void (d.todos.find((t) => t.id === id)!.done = done)));
        try {
          const { data } = await queryFulfilled;
          dispatch(rtk.util.updateQueryData("todos", undefined, (d) => void Object.assign(d.todos.find((t) => t.id === id)!, data)));
        } catch {
          patch.undo();
        }
      },
    }),
    status: b.query<{ tick: number }, void>({ query: () => "status" }),
    detail: b.query<api.Detail, number>({ query: (id) => `detail/${id}` }),
  }),
});

// --------------------------------------------------------------------------------------------- slices
const searchCities = createAsyncThunk("search/fetch", (q: string) => api.search(q));
const search = createSlice({
  name: "search",
  initialState: { q: "", results: [] as string[] },
  reducers: {
    setQ(s, a: PayloadAction<string>) {
      s.q = a.payload;
      if (!a.payload) s.results = [];
    },
  },
  extraReducers: (b) => b.addCase(searchCities.fulfilled, (s, a) => void (s.results = a.payload.results)),
});

const loadItems = createAsyncThunk("items/load", () => api.items());
const createItem = createAsyncThunk("items/create", (title: string) => api.createItem(title));
const items = createSlice({
  name: "items",
  initialState: { items: null as api.Item[] | null, title: "", error: null as string | null },
  reducers: { setTitle: (s, a: PayloadAction<string>) => void (s.title = a.payload) },
  extraReducers: (b) =>
    b
      .addCase(loadItems.fulfilled, (s, a) => void (s.items = a.payload.items))
      .addCase(createItem.fulfilled, (s, a) => {
        s.items = [...(s.items ?? []), a.payload];
        s.title = "";
      })
      .addCase(createItem.rejected, (s) => void (s.error = "Could not create")),
});

let noteSeq = 0;
const loadNotes = createAsyncThunk("notes/load", () => api.notes());
const notes = createSlice({
  name: "notes",
  initialState: { notes: null as V.NoteRow[] | null, draft: "" },
  reducers: {
    setDraft: (s, a: PayloadAction<string>) => void (s.draft = a.payload),
    queued(s, a: PayloadAction<V.NoteRow>) {
      s.notes = [...(s.notes ?? []), a.payload];
      s.draft = "";
    },
    synced(s, a: PayloadAction<{ key: string; note: api.Note }>) {
      s.notes = s.notes!.map((n) => (n.key === a.payload.key ? { key: `s${a.payload.note.id}`, text: a.payload.note.text } : n));
    },
  },
  extraReducers: (b) => b.addCase(loadNotes.fulfilled, (s, a) => void (s.notes = a.payload.notes.map((n) => ({ key: `s${n.id}`, text: n.text })))),
});

const increment = createAsyncThunk("counter/increment", () => api.increment());
const counter = createSlice({
  name: "counter",
  initialState: { count: 0, synced: 0 },
  reducers: { plus: (s) => void s.count++ },
  extraReducers: (b) => b.addCase(increment.fulfilled, (s, a) => void (s.synced = Math.max(s.synced, a.payload.count))),
});

const store = configureStore({
  reducer: { search: search.reducer, items: items.reducer, notes: notes.reducer, counter: counter.reducer, [rtk.reducerPath]: rtk.reducer },
  middleware: (gdm) => gdm().concat(rtk.middleware),
});
type State = ReturnType<typeof store.getState>;
type Dispatch = typeof store.dispatch;
const useD = () => useDispatch<Dispatch>();
const useS = <T,>(f: (s: State) => T) => useSelector(f);

const outbox = api.createOutbox<V.NoteRow>(async (row) => {
  try {
    const note = await api.addNote(row.text);
    store.dispatch(notes.actions.synced({ key: row.key, note }));
    return true;
  } catch {
    return false;
  }
});

// ----------------------------------------------------------------------------------------- scenarios
function A() {
  const d = useD();
  const { q, results } = useS((s) => s.search);
  const onQ = (v: string) => {
    d(search.actions.setQ(v));
    if (v) void d(searchCities(v));
  };
  return <V.Typeahead q={q} onQ={onQ} results={results} />;
}

function B() {
  const d = useD();
  const s = useS((x) => x.items);
  useEffect(() => void d(loadItems()), [d]);
  return <V.Create ready={s.items !== null} items={s.items ?? []} title={s.title} onTitle={(t) => d(items.actions.setTitle(t))} onSubmit={() => void d(createItem(s.title))} error={s.error} />;
}

function C() {
  const [go, setGo] = useState(false);
  const left = rtk.useLeftQuery(undefined, { skip: !go });
  const right = rtk.useRightQuery(undefined, { skip: !go });
  return <V.Panels onLoad={() => setGo(true)} left={left.data?.rows} right={right.data?.rows} />;
}

function D() {
  const todos = rtk.useTodosQuery();
  const [toggle] = rtk.useToggleMutation();
  const [error, setError] = useState<string | null>(null);
  const onToggle = (t: api.Todo) =>
    toggle({ id: t.id, done: !t.done })
      .unwrap()
      .catch(() => setError(`Could not save "${t.title}"`));
  return <V.Todos ready={todos.isSuccess} todos={todos.data?.todos ?? []} onToggle={onToggle} error={error} />;
}

function E() {
  const d = useD();
  const s = useS((x) => x.notes);
  useEffect(() => void d(loadNotes()), [d]);
  const add = () => {
    const row = { key: `l${++noteSeq}`, text: s.draft, pending: true };
    d(notes.actions.queued(row));
    void outbox.submit(row);
  };
  return <V.Notes ready={s.notes !== null} notes={s.notes ?? []} draft={s.draft} onDraft={(t) => d(notes.actions.setDraft(t))} onAdd={add} />;
}

function F() {
  const d = useD();
  const { count, synced } = useS((s) => s.counter);
  const plus = () => {
    d(counter.actions.plus());
    void d(increment());
  };
  return <V.Counter count={count} synced={synced} onPlus={plus} />;
}

function DetailRow({ id, onData }: { id: number; onData: (d: api.Detail) => void }) {
  const { data } = rtk.useDetailQuery(id);
  useEffect(() => void (data && onData(data)), [data, onData]);
  return null;
}
function LiveData() {
  const [done, setDone] = useState(false);
  const status = rtk.useStatusQuery(undefined, { pollingInterval: done ? 0 : 250 });
  const [polls, setPolls] = useState(0);
  const seen = useRef(0);
  const [details, setDetails] = useState<Record<number, api.Detail>>({});
  const onData = useRef((d: api.Detail) => setDetails((m) => (m[d.id] ? m : { ...m, [d.id]: d }))).current;
  useEffect(() => {
    if (status.fulfilledTimeStamp && status.fulfilledTimeStamp !== seen.current) {
      seen.current = status.fulfilledTimeStamp;
      setPolls((p) => p + 1);
    }
    if ((status.data?.tick ?? 0) >= 8) setDone(true);
  }, [status.fulfilledTimeStamp, status.data?.tick]);
  return (
    <>
      {api.DETAIL_IDS.map((id) => (
        <DetailRow key={id} id={id} onData={onData} />
      ))}
      <V.LivePanel tick={status.data?.tick ?? 0} polls={polls} details={api.DETAIL_IDS.map((id) => details[id])} />
    </>
  );
}
const G = () => (
  <V.Live>
    <LiveData />
  </V.Live>
);

function H() {
  const list = rtk.useItemsQuery();
  const [q, setQ] = useState("");
  const results = rtk.useSearchQuery(q, { skip: !q });
  const [create] = rtk.useCreateItemMutation();
  const [title, setTitle] = useState("");
  return (
    <V.Clean
      ready={list.isSuccess}
      items={list.data?.items ?? []}
      q={q}
      onQ={setQ}
      results={q ? (results.currentData?.results ?? []) : []}
      title={title}
      onTitle={setTitle}
      onCreate={() => void create(title).unwrap().then(() => setTitle(""))}
    />
  );
}

const S: Record<string, () => React.ReactElement> = { a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H };
export default function ReduxLayer({ s }: { s: string }) {
  const C = S[s] ?? H;
  return (
    <Provider store={store}>
      <C />
    </Provider>
  );
}
