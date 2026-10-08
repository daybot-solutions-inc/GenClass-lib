// Team todo list synced to a server (React 19 + Redux Toolkit createSlice/createAsyncThunk + axios over XHR; the
// store goes through GenClass via genclassEnhancer). Optimistic toggles and deletes, background sync every few
// seconds, bulk "clear completed". Latent bugs by flag: double adds (addGuard=none: button stays enabled, no thunk
// condition), relative toggles that a retry or replay applies twice (toggle=relative), optimistic writes not undone
// on failure (rollback=false), the `remaining` counter forgotten on one code path (remaining=forget-*), background
// sync overwriting edits made while it was in flight (sync=blind).
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { configureStore, createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { Provider, useDispatch, useSelector } from "react-redux";
import axios from "axios";
import { genclassEnhancer } from "@genclass/runtime/redux";
import { rt, flag } from "../_shared/genclass";

type Todo = { id: number; title: string; done: boolean; assignee: string };
type Filter = "all" | "active" | "done";
const ADD_GUARD = flag("addGuard", "disable") as "disable" | "none";
const TOGGLE = flag("toggle", "patch") as "patch" | "relative";
const ROLLBACK = Boolean(flag("rollback", true));
const REMAINING = flag("remaining", "recount") as "recount" | "forget-delete" | "forget-rollback";
const SYNC = flag("sync", "skip-if-dirty") as "skip-if-dirty" | "blind";
const POLL_MS = Number(flag("pollMs", 8000));
const ME = "ana";

const api = axios.create({ baseURL: "/api", timeout: 10000, headers: { "X-Client": "todos-web/2.3" } });

interface TodosState {
  items: Todo[];
  filter: Filter;
  remaining: number;
  draft: string;
  adding: boolean;
  clearing: boolean;
  loading: boolean;
  syncId: string;
  error: string;
}

const initialState: TodosState = { items: [], filter: "all", remaining: 0, draft: "", adding: false, clearing: false, loading: false, syncId: "", error: "" };

function message(e: { message?: string } | undefined, what: string): string {
  return `${what}: ${e?.message ?? "network error"}`;
}

// ------------------------------------------------------------------------------------------------ thunks
// Local writes in flight and made so far (bookkeeping for background sync, kept out of the store).
let writesInFlight = 0;
let writeSeq = 0;
async function tracked<T>(fn: () => Promise<T>): Promise<T> {
  writesInFlight++;
  writeSeq++;
  try {
    return await fn();
  } finally {
    writesInFlight--;
  }
}

export const fetchTodos = createAsyncThunk("todos/fetch", async () => {
  const seq = writeSeq;
  const r = await api.get<{ data: Todo[] }>("/todos", { params: { limit: 100 } });
  if (!Array.isArray(r.data?.data)) throw new Error("unexpected response");
  // a sync that raced with local edits would bring back what the user just changed
  return { items: r.data.data, raced: writesInFlight > 0 || writeSeq !== seq };
});

export const addTodo = createAsyncThunk(
  "todos/add",
  (title: string) => tracked(async () => (await api.post<Todo>("/todos", { title, done: false, assignee: ME })).data),
  { condition: (_t, { getState }) => ADD_GUARD === "none" || !(getState() as TodosState).adding },
);

export const toggleTodo = createAsyncThunk("todos/toggle", (t: Todo) =>
  tracked(async () => {
    if (TOGGLE === "relative") return (await api.post<Todo>(`/todos/${t.id}/toggle`)).data;
    return (await api.patch<Todo>(`/todos/${t.id}`, { done: !t.done })).data;
  }),
);

export const deleteTodo = createAsyncThunk("todos/delete", (t: Todo) =>
  tracked(async () => {
    await api.delete(`/todos/${t.id}`);
    return t.id;
  }),
);

export const clearCompleted = createAsyncThunk("todos/clearCompleted", (ids: number[]) =>
  tracked(async () => {
    const r = await api.post<{ results: { id: number; ok: boolean; status: number }[] }>("/todos/bulk", { ids, op: "delete" }, { validateStatus: (s) => s === 200 || s === 207 });
    return r.data.results;
  }),
);

// ------------------------------------------------------------------------------------------------- slice
function replaceItem(s: TodosState, next: Todo): void {
  const i = s.items.findIndex((x) => x.id === next.id);
  if (i < 0) return;
  const prev = s.items[i]!;
  if (prev.done !== next.done) s.remaining += next.done ? -1 : 1;
  s.items[i] = next;
}

const slice = createSlice({
  name: "todos",
  initialState,
  reducers: {
    draftChanged(s, a: PayloadAction<string>) {
      s.draft = a.payload;
    },
    filterChanged(s, a: PayloadAction<Filter>) {
      s.filter = a.payload;
    },
    dismissError(s) {
      s.error = "";
    },
  },
  extraReducers: (b) => {
    b.addCase(fetchTodos.pending, (s, a) => {
      s.syncId = a.meta.requestId;
      s.loading = true;
    })
      .addCase(fetchTodos.fulfilled, (s, a) => {
        if (a.meta.requestId !== s.syncId) return; // a newer refresh superseded this one
        s.loading = false;
        if (s.error.startsWith("Sync failed")) s.error = "";
        if (SYNC === "skip-if-dirty" && a.payload.raced) return;
        s.items = a.payload.items;
        s.remaining = a.payload.items.filter((t) => !t.done).length;
      })
      .addCase(fetchTodos.rejected, (s, a) => {
        if (a.meta.requestId !== s.syncId) return;
        s.loading = false;
        s.error = message(a.error, "Sync failed");
      })
      .addCase(addTodo.pending, (s) => {
        s.adding = true;
      })
      .addCase(addTodo.fulfilled, (s, a) => {
        s.adding = false;
        if (!s.items.some((x) => x.id === a.payload.id)) {
          s.items.push(a.payload);
          if (!a.payload.done) s.remaining++;
        }
        if (s.draft.trim() === a.meta.arg) s.draft = "";
      })
      .addCase(addTodo.rejected, (s, a) => {
        s.adding = false;
        s.error = message(a.error, "Could not add the todo");
      })
      .addCase(toggleTodo.pending, (s, a) => {
        const t = s.items.find((x) => x.id === a.meta.arg.id);
        if (t) {
          t.done = !a.meta.arg.done;
          s.remaining += t.done ? -1 : 1;
        }
      })
      .addCase(toggleTodo.fulfilled, (s, a) => {
        replaceItem(s, a.payload);
      })
      .addCase(toggleTodo.rejected, (s, a) => {
        s.error = message(a.error, `Could not update “${a.meta.arg.title}”`);
        if (!ROLLBACK) return;
        const t = s.items.find((x) => x.id === a.meta.arg.id);
        if (t && t.done !== a.meta.arg.done) {
          t.done = a.meta.arg.done;
          if (REMAINING !== "forget-rollback") s.remaining += t.done ? -1 : 1;
        }
      })
      .addCase(deleteTodo.pending, (s, a) => {
        const i = s.items.findIndex((x) => x.id === a.meta.arg.id);
        if (i < 0) return;
        const [gone] = s.items.splice(i, 1);
        if (gone && !gone.done && REMAINING !== "forget-delete") s.remaining--;
      })
      .addCase(deleteTodo.rejected, (s, a) => {
        s.error = message(a.error, `Could not delete “${a.meta.arg.title}”`);
        if (!ROLLBACK || a.error.message?.includes("404") || s.items.some((x) => x.id === a.meta.arg.id)) return;
        s.items.push(a.meta.arg);
        if (!a.meta.arg.done && REMAINING !== "forget-delete") s.remaining++;
      })
      .addCase(clearCompleted.pending, (s) => {
        s.clearing = true;
      })
      .addCase(clearCompleted.fulfilled, (s, a) => {
        s.clearing = false;
        const ok = new Set(a.payload.filter((r) => r.ok || r.status === 404).map((r) => r.id));
        const removed = s.items.filter((x) => ok.has(x.id));
        s.items = s.items.filter((x) => !ok.has(x.id));
        s.remaining -= removed.filter((x) => !x.done).length;
        const failed = a.payload.length - ok.size;
        if (failed > 0) s.error = `${failed} completed todo${failed > 1 ? "s" : ""} could not be cleared`;
      })
      .addCase(clearCompleted.rejected, (s, a) => {
        s.clearing = false;
        s.error = message(a.error, "Clear completed failed");
      });
  },
});
const { draftChanged, filterChanged, dismissError } = slice.actions;

const store = configureStore({
  reducer: slice.reducer,
  enhancers: (getDefault) => getDefault().concat(genclassEnhancer(rt, { name: "todos" })),
});
type AppDispatch = typeof store.dispatch;

// ---------------------------------------------------------------------------------------------------- UI
const LABEL: Record<Filter, string> = { all: "All", active: "Active", done: "Done" };

function TodoApp() {
  const s = useSelector((st: TodosState) => st);
  const dispatch = useDispatch<AppDispatch>();
  useEffect(() => {
    void dispatch(fetchTodos());
    const h = setInterval(() => void dispatch(fetchTodos()), POLL_MS);
    return () => clearInterval(h);
  }, [dispatch]);
  const visible = s.items.filter((t) => s.filter === "all" || (s.filter === "done" ? t.done : !t.done));
  const doneIds = s.items.filter((t) => t.done).map((t) => t.id);
  return (
    <main className="todos">
      <header>
        <h1>Team todos</h1>
        <p className="remaining">{s.remaining} remaining</p>
        <button className="refresh" onClick={() => void dispatch(fetchTodos())}>
          {s.loading ? "Syncing…" : "Refresh"}
        </button>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const title = s.draft.trim();
          if (title) void dispatch(addTodo(title));
        }}
      >
        <input name="newTodo" value={s.draft} onChange={(e) => dispatch(draftChanged(e.target.value))} placeholder="What needs doing?" aria-label="New todo" />
        <button className="add-todo" type="submit" disabled={ADD_GUARD === "disable" && s.adding}>
          {s.adding ? "Adding…" : "Add"}
        </button>
      </form>
      <nav className="filters">
        {(Object.keys(LABEL) as Filter[]).map((f) => (
          <button key={f} className={f === s.filter ? "on" : ""} aria-pressed={f === s.filter} onClick={() => dispatch(filterChanged(f))}>
            {LABEL[f]}
          </button>
        ))}
      </nav>
      {s.error && (
        <p role="alert">
          {s.error} <button className="dismiss" onClick={() => dispatch(dismissError())}>×</button>
        </p>
      )}
      <ul>
        {visible.map((t) => (
          <li key={t.id} className={t.done ? "todo done" : "todo"}>
            <label>
              <input type="checkbox" checked={t.done} onChange={() => void dispatch(toggleTodo(t))} /> {t.title}
            </label>{" "}
            <span className="who">@{t.assignee}</span>{" "}
            <button className="delete" aria-label={`Delete ${t.title}`} onClick={() => void dispatch(deleteTodo(t))}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      {!visible.length && <p className="empty">Nothing here.</p>}
      <footer>
        <button className="clear-completed" disabled={s.clearing || !doneIds.length} onClick={() => void dispatch(clearCompleted(doneIds))}>
          {s.clearing ? "Clearing…" : `Clear completed (${doneIds.length})`}
        </button>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(
  <Provider store={store}>
    <TodoApp />
  </Provider>,
);
