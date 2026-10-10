// Data layer "tanstack": TanStack Query v5, idiomatic. Queries are keyed (the typeahead cannot show stale results
// by construction), the create form is not guarded (b: double submit), optimistic toggles follow the docs'
// onMutate / onError rollback / onSettled invalidate pattern (d), offline adds are paused mutations resumed on
// reconnect in one scope (e), polling uses refetchInterval (g). GenClass sees the network, not the query cache.
import { QueryClient, QueryClientProvider, useMutation, useMutationState, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import * as V from "../views";

function A() {
  const [q, setQ] = useState("");
  const { data } = useQuery({ queryKey: ["search", q], queryFn: () => api.search(q), enabled: q.length > 0 });
  return <V.Typeahead q={q} onQ={setQ} results={q ? (data?.results ?? []) : []} />;
}

function useCreateItem() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.createItem, onSuccess: () => qc.invalidateQueries({ queryKey: ["items"] }) });
}

function B() {
  const items = useQuery({ queryKey: ["items"], queryFn: api.items });
  const create = useCreateItem();
  const [title, setTitle] = useState("");
  const submit = () => create.mutate(title, { onSuccess: () => setTitle("") });
  return <V.Create ready={items.isSuccess} items={items.data?.items ?? []} title={title} onTitle={setTitle} onSubmit={submit} error={create.isError ? "Could not create" : null} />;
}

function C() {
  const [go, setGo] = useState(false);
  const left = useQuery({ queryKey: ["left"], queryFn: api.left, enabled: go });
  const right = useQuery({ queryKey: ["right"], queryFn: api.right, enabled: go });
  return <V.Panels onLoad={() => setGo(true)} left={left.data?.rows} right={right.data?.rows} />;
}

function D() {
  const qc = useQueryClient();
  const todos = useQuery({ queryKey: ["todos"], queryFn: api.todos });
  const [error, setError] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: (t: api.Todo) => api.toggleTodo(t.id, !t.done),
    onMutate: async (t) => {
      await qc.cancelQueries({ queryKey: ["todos"] });
      const previous = qc.getQueryData<{ todos: api.Todo[] }>(["todos"]);
      qc.setQueryData<{ todos: api.Todo[] }>(["todos"], (old) => old && { todos: old.todos.map((x) => (x.id === t.id ? { ...x, done: !t.done } : x)) });
      return { previous };
    },
    onError: (_e, t, ctx) => {
      if (ctx?.previous) qc.setQueryData(["todos"], ctx.previous);
      setError(`Could not save "${t.title}"`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["todos"] }),
  });
  return <V.Todos ready={todos.isSuccess} todos={todos.data?.todos ?? []} onToggle={(t) => toggle.mutate(t)} error={error} />;
}

function E() {
  const qc = useQueryClient();
  const notes = useQuery({ queryKey: ["notes"], queryFn: api.notes });
  const [draft, setDraft] = useState("");
  const add = useMutation({
    mutationKey: ["addNote"],
    scope: { id: "notes" }, // paused offline mutations resume in order
    mutationFn: (text: string) => api.addNote(text),
    // returning the invalidation keeps the mutation pending (shown as such) until the list has been refetched
    onSettled: () => qc.invalidateQueries({ queryKey: ["notes"] }),
  });
  const pending = useMutationState({ filters: { mutationKey: ["addNote"], status: "pending" }, select: (m) => m.state.variables as string });
  const rows: V.NoteRow[] = [...(notes.data?.notes ?? []).map((n) => ({ key: `s${n.id}`, text: n.text })), ...pending.map((text, i) => ({ key: `p${i}`, text, pending: true }))];
  const submit = () => {
    add.mutate(draft);
    setDraft("");
  };
  return <V.Notes ready={notes.isSuccess} notes={rows} draft={draft} onDraft={setDraft} onAdd={submit} />;
}

function F() {
  const [count, setCount] = useState(0);
  const [synced, setSynced] = useState(0);
  // hook-level onSuccess runs for every mutation (per-call callbacks would only run for the last one)
  const inc = useMutation({ mutationFn: api.increment, onSuccess: (r) => setSynced((s) => Math.max(s, r.count)) });
  const plus = () => {
    setCount((c) => c + 1);
    inc.mutate();
  };
  return <V.Counter count={count} synced={synced} onPlus={plus} />;
}

function LiveData() {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: (query) => ((query.state.data?.tick ?? 0) >= 8 ? false : 250) });
  const details = useQueries({ queries: api.DETAIL_IDS.map((id) => ({ queryKey: ["detail", id], queryFn: () => api.detail(id) })) });
  const [polls, setPolls] = useState(0);
  const seen = useRef(0);
  useEffect(() => {
    if (status.dataUpdatedAt && status.dataUpdatedAt !== seen.current) {
      seen.current = status.dataUpdatedAt;
      setPolls((p) => p + 1);
    }
  }, [status.dataUpdatedAt]);
  return <V.LivePanel tick={status.data?.tick ?? 0} polls={polls} details={details.map((d) => d.data)} />;
}
const G = () => (
  <V.Live>
    <LiveData />
  </V.Live>
);

function H() {
  const items = useQuery({ queryKey: ["items"], queryFn: api.items });
  const [q, setQ] = useState("");
  const results = useQuery({ queryKey: ["search", q], queryFn: () => api.search(q), enabled: q.length > 0 });
  const create = useCreateItem();
  const [title, setTitle] = useState("");
  return (
    <V.Clean
      ready={items.isSuccess}
      items={items.data?.items ?? []}
      q={q}
      onQ={setQ}
      results={q ? (results.data?.results ?? []) : []}
      title={title}
      onTitle={setTitle}
      onCreate={() => create.mutate(title, { onSuccess: () => setTitle("") })}
    />
  );
}

const S: Record<string, () => React.ReactElement> = { a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H };
const client = new QueryClient();
export default function TanStackLayer({ s }: { s: string }) {
  const C = S[s] ?? H;
  return (
    <QueryClientProvider client={client}>
      <C />
    </QueryClientProvider>
  );
}
